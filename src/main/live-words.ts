// Live words: English speech shown word by word while it's spoken, from NVIDIA's Nemotron Speech Streaming 0.6B
// (560 ms chunks) in a worker thread. The line's final text still comes from Parakeet when the speech ends: the
// streaming model made 2.7% word errors on LibriSpeech through a call codec, Parakeet v2 2.2%. On a base M1 it used
// about 14% of the time it listened to (2 threads) per side.
import path from 'node:path'
import type { Worker } from 'node:worker_threads'
import type { State } from '../shared/state'
import createWorker from './live-words-worker?nodeWorker'
import { stopWorker } from './worker'
import { getState, patchState } from './state'
import { fetchSherpaModel } from './stt'

type Role = 'me' | 'them'
export const LIVE_WORDS_MODEL = 'sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25'
const MODEL = LIVE_WORDS_MODEL

let worker: Worker | null = null
let ready: Promise<void> | null = null
/** Bumps on every stop, so a load still downloading then doesn't start a worker nothing will end. */
let generation = 0
/** Each side's current utterance (0: none), so a late partial from the last one isn't shown under the next. */
const active: Record<Role, number> = { me: 0, them: 0 }
let utterances = 0

/** Live words apply to on-device English transcription, when switched on. */
export function liveWanted(s: State): boolean {
  const t = s.transcription
  return t.liveWords && t.engine === 'local' && (s.session?.language ?? t.language) === 'en'
}

/** The streaming model's download size. */
export const LIVE_WORDS_MB = 442

/** Downloads the model if it isn't here yet, without loading it (setup). */
export async function downloadLiveWords(modelsDir: string, onProgress?: (pct: number) => void): Promise<string> {
  const dir = path.join(modelsDir, 'asr', MODEL)
  await fetchSherpaModel(MODEL, path.dirname(dir), onProgress)
  return dir
}

/** Downloads the model once (with progress) and starts the worker. Safe to call repeatedly. */
export function prepareLiveWords(modelsDir: string, onProgress?: (pct: number) => void): Promise<void> {
  const gen = generation
  return (ready ??= (async () => {
    const dir = await downloadLiveWords(modelsDir, onProgress)
    if (gen !== generation) return // stopped while downloading: the next session starts its own
    const w = createWorker()
    worker = w
    await new Promise<void>((resolve, reject) => {
      w.on('message', (m: { t: string; role?: Role; seq?: number; text?: string; message?: string }) => {
        if (m.t === 'ready') resolve()
        else if (m.t === 'error') (console.warn('[live words]', m.message), reject(new Error(m.message)))
        else if (m.t === 'partial' && m.role && m.seq === active[m.role] && getState().liveWords[m.role] !== m.text) {
          patchState({ liveWords: { [m.role]: m.text ?? '' } })
        }
      })
      w.on('error', reject)
      w.on('exit', () => reject(new Error('live words stopped')))
      w.postMessage({ t: 'load', dir })
    })
  })().catch((err: Error) => {
    if (gen === generation) stopLiveWords()
    throw err
  }))
}

/** Frees the model's memory; the next session loads it again (about 2 s). */
export function stopLiveWords() {
  generation++
  if (worker) stopWorker(worker)
  worker = null
  ready = null
  active.me = active.them = 0
  patchState({ liveWords: { me: '', them: '' } })
}

export function liveStart(role: Role) {
  if (!worker) return
  active[role] = ++utterances
  worker.postMessage({ t: 'start', role, seq: active[role] })
  patchState({ liveWords: { [role]: '' } })
}

export function liveAudio(role: Role, samples: Float32Array) {
  if (worker && active[role]) worker.postMessage({ t: 'audio', role, samples })
}

/** The speech ended: returns what was heard so far, for the line to show until its final text arrives. */
export function liveEnd(role: Role): string {
  if (!active[role]) return ''
  active[role] = 0
  worker?.postMessage({ t: 'end', role })
  const text = getState().liveWords[role]
  patchState({ liveWords: { [role]: '' } })
  return text
}
