// On-device models on disk: cleaning up what no setting can use any more, and removing what the current settings
// don't need. Speech models are hundreds of MB each and nothing else ever deletes them.
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { LOCAL_WHISPER_MODELS, speechModelFor, type State } from '../shared/state'
import { LIVE_WORDS_MODEL } from './live-words'

export const modelsDir = () => path.join(app.getPath('userData'), 'models')

/** Every model directory a setting can pick, relative to modelsDir. */
function known(): Set<string> {
  const all = new Set([path.join('asr', LIVE_WORDS_MODEL), 'speaker'])
  for (const lang of ['en', 'fr', 'ja']) for (const size of LOCAL_WHISPER_MODELS) all.add(dirOf(speechModelFor(lang, size).id))
  return all
}

/** What the current settings use: the speech model for the default language, live words if on, the voice model. */
function needed(s: State): Set<string> {
  const t = s.transcription
  const use = new Set(['speaker'])
  if (t.engine === 'local') use.add(dirOf(speechModelFor(s.session?.language ?? t.language, t.localModel).id))
  if (t.engine === 'local' && t.liveWords) use.add(path.join('asr', LIVE_WORDS_MODEL))
  return use
}

/** sherpa-onnx models unpack under asr/, transformers.js ones under their Hugging Face id. */
const dirOf = (id: string) => (id.startsWith('sherpa-onnx') ? path.join('asr', id) : id)

/** Each model directory on disk (two levels: asr/name, onnx-community/name, speaker), and stray files. */
function onDisk(): string[] {
  const out: string[] = []
  const list = (rel: string) => {
    try {
      return fs.readdirSync(path.join(modelsDir(), rel))
    } catch {
      return []
    }
  }
  for (const top of list('')) {
    if (top === 'speaker') out.push(top)
    else if (top === 'asr' || top === 'onnx-community') for (const name of list(top)) out.push(path.join(top, name))
    else out.push(top)
  }
  return out
}

function sizeOf(p: string): number {
  try {
    const st = fs.statSync(p)
    if (!st.isDirectory()) return st.size
    return fs.readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f)), 0)
  } catch {
    return 0
  }
}

/** At launch: deletes half-finished downloads and models no setting can use (left by an older version). */
export function sweepModels() {
  const keep = known()
  for (const rel of onDisk()) {
    if (keep.has(rel)) continue
    console.log(`[models] removing unused ${rel}`)
    fs.rmSync(path.join(modelsDir(), rel), { recursive: true, force: true })
  }
}

/** Bytes on disk, and how many of them the current settings don't use. */
export function modelUsage(s: State): { total: number; unused: number } {
  const use = needed(s)
  let total = 0
  let unused = 0
  for (const rel of onDisk()) {
    const n = sizeOf(path.join(modelsDir(), rel))
    total += n
    if (!use.has(rel) && !rel.endsWith('.part')) unused += n
  }
  return { total, unused }
}

/**
 * Deletes the models the current settings don't use; one needed later downloads again. A download in progress
 * (`.part`) is left alone: only the launch sweep removes those, when nothing can be writing them.
 */
export function removeUnusedModels(s: State) {
  const use = needed(s)
  for (const rel of onDisk()) if (!use.has(rel) && !rel.endsWith('.part')) fs.rmSync(path.join(modelsDir(), rel), { recursive: true, force: true })
  return modelUsage(s)
}
