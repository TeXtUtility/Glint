// No Electron imports. The speech model runs in a worker that ends with the session: Parakeet in parakeet-worker.ts,
// Whisper in whisper-worker.ts.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import { promisify } from 'node:util'
import type { Worker } from 'node:worker_threads'
import { speechModelFor, type LocalWhisper } from '../shared/state.ts'
import { collapseRepeats, encodeWav } from './audio-core.ts' // extension lets plain Node run this for checks
import createParakeet from './parakeet-worker?nodeWorker'
import createWhisper from './whisper-worker?nodeWorker'
import { TAR } from './platform/system'
import { loadWorker, stopWorker } from './worker'

/** Transcribes one line of 16 kHz mono speech. */
type Transcriber = (audio: Float32Array, language: string) => Promise<string>
let local: { id: string; ready: Promise<Transcriber> } | null = null
/** The worker holding the speech model, while it's loaded. */
let worker: Worker | null = null
/** Bumps on every unload, so a load still downloading then doesn't start a worker nothing will end. */
let generation = 0
const run = promisify(execFile)

/**
 * NVIDIA Parakeet TDT 0.6B through sherpa-onnx: v2 for English, v3 for the 24 other European languages it covers.
 * On a base M1 with LibriSpeech test-clean (200 lines, 2 threads), v2 made 2.1% word errors against Moonshine base's
 * 3.4%, at ~180 ms against ~135 ms for a line of up to 6 s; through a 16 kbps Opus codec, like call audio, 2.2%
 * against 3.4%. v3 made 2.6% on English, so English keeps v2. Other languages use Whisper at the chosen size.
 */
const SHERPA_URL = (name: string) => `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${name}.tar.bz2`

/** SHA-256 of each sherpa-onnx package, from its GitHub release asset. Exported for the tests' own package. */
export const SHERPA_SHA256: Record<string, string> = {
  'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8': '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad',
  'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8': '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
  'sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25': '78e2b79fcf7271553a74402a76b771b09ea40117a39566a79f52235b23db6358',
}
/** What a package's workers load: it's on disk only when every one of these is. */
const SHERPA_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']
const downloads = new Map<string, Promise<void>>()

/** Downloads into cacheDir on first use, then stays cached across calls. */
export function loadLocalAsr(language: string, size: LocalWhisper, cacheDir: string, onProgress?: (pct: number) => void): Promise<Transcriber> {
  const { id } = speechModelFor(language, size)
  if (local?.id === id) return local.ready
  unloadLocalAsr() // a different model: don't keep the last one's memory
  const gen = generation
  const ready = id.startsWith('sherpa-onnx') ? loadParakeet(id, cacheDir, gen, onProgress) : loadWhisper(id, cacheDir, gen, onProgress)
  local = { id, ready }
  ready.catch(() => {
    if (local?.ready === ready) local = null // let the next call retry
  })
  return ready
}

async function loadParakeet(name: string, cacheDir: string, gen: number, onProgress?: (pct: number) => void): Promise<Transcriber> {
  const dir = path.join(cacheDir, 'asr', name)
  await fetchSherpaModel(name, path.dirname(dir), onProgress)
  return inWorker(createParakeet, { t: 'load', dir }, gen)
}

async function loadWhisper(id: string, cacheDir: string, gen: number, onProgress?: (pct: number) => void): Promise<Transcriber> {
  const transcribe = await inWorker(createWhisper, { t: 'load', model: id, cacheDir }, gen, onProgress)
  return async (audio, language) => collapseRepeats(await transcribe(audio, language))
}

/** Starts a model's worker and waits for it to load, unless the model was unloaded since `gen`. */
async function inWorker(create: () => Worker, load: object, gen: number, onProgress?: (pct: number) => void): Promise<Transcriber> {
  if (gen !== generation) throw new Error('the speech model was unloaded')
  const w = create()
  worker = w
  w.on('exit', () => {
    if (worker === w) unloadLocalAsr() // it crashed: the next line loads it again instead of waiting on it
  })
  const ask = await loadWorker(w, load, 'speech model', onProgress)
  return (audio, language) => ask<string>('decode', { samples: audio, language })
}

/** Frees the speech model's memory (its worker ends); the next session loads it again in a second or two. */
export function unloadLocalAsr() {
  generation++
  if (worker) stopWorker(worker)
  worker = null
  local = null
}

/**
 * A sherpa-onnx model package, unless it's on disk already: downloaded with progress, checked against its SHA-256,
 * then unpacked in place of any partial copy. A call while that package is downloading shares the download.
 */
export function fetchSherpaModel(name: string, into: string, onProgress?: (pct: number) => void): Promise<void> {
  if (SHERPA_FILES.every((f) => fs.existsSync(path.join(into, name, f)))) return Promise.resolve()
  let p = downloads.get(name)
  if (!p) downloads.set(name, (p = downloadSherpa(name, into, onProgress).finally(() => downloads.delete(name))))
  return p
}

async function downloadSherpa(name: string, into: string, onProgress?: (pct: number) => void) {
  fs.mkdirSync(into, { recursive: true })
  const archive = path.join(into, `${name}.tar.bz2.part`)
  const unpacked = path.join(into, `${name}.part`) // moved into place once whole, so a half-unpacked model never looks done
  try {
    const res = await fetch(SHERPA_URL(name), { signal: AbortSignal.timeout(30 * 60_000) })
    await downloadVerified(res, 'speech model', SHERPA_SHA256[name], archive, onProgress)
    fs.mkdirSync(unpacked, { recursive: true })
    await run(TAR, ['-xjf', archive, '-C', unpacked])
    fs.rmSync(path.join(into, name), { recursive: true, force: true })
    fs.renameSync(path.join(unpacked, name), path.join(into, name))
  } finally {
    fs.rmSync(unpacked, { recursive: true, force: true })
    fs.rmSync(archive, { force: true })
  }
}

export async function downloadVerified(res: Response, what: string, sha256: string, file: string, onProgress?: (pct: number) => void) {
  if (!res.ok || !res.body) throw new Error(`${what} download failed (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  const hash = createHash('sha256') // as it streams, rather than reading 460 MB back
  const out = fs.createWriteStream(file)
  let got = 0
  try {
    // Rejects on any failure, a full disk included, rather than waiting on a write that never finishes.
    await pipeline(
      Readable.fromWeb(res.body as ReadableStream<Uint8Array>),
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          hash.update(chunk)
          got += chunk.byteLength
          if (total) onProgress?.((got / total) * 100)
          yield chunk
        }
      },
      out,
    )
  } finally {
    // A failed download can leave the file still opening; removed only once it's closed, or it would be created after.
    out.destroy()
    if (!out.closed) await new Promise<void>((resolve) => out.once('close', resolve))
  }
  if (hash.digest('hex') !== sha256) throw new Error(`the ${what} download was corrupted`)
}

export async function transcribeOpenAi(audio: Float32Array, model: string, language: string, apiKey?: string) {
  const { default: OpenAI, toFile } = await import('openai') // loaded on first use: most sessions never need it
  const client = new OpenAI({ apiKey }) // no saved key: falls back to OPENAI_API_KEY
  const r = await client.audio.transcriptions.create({
    file: await toFile(encodeWav(audio), 'segment.wav', { type: 'audio/wav' }),
    model,
    language,
  })
  return r.text.trim()
}
