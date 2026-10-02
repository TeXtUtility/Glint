import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  applyPatch, loadPersisted, normalize, parsePersisted, pickPersisted,
  PERSISTED_DEFAULTS, RUNTIME_DEFAULTS, type State,
} from '../shared/state'

const file = () => path.join(app.getPath('userData'), 'state.json')

let state: State
const listeners = new Set<(s: State, prev: State) => void>()
let writeTimer: NodeJS.Timeout | null = null

export function initState(runtime: Partial<State>) {
  let persisted = PERSISTED_DEFAULTS
  try {
    const loaded = loadPersisted(fs.readFileSync(file(), 'utf8'))
    persisted = loaded.value
    if (loaded.rejected.length) keepBadFile(`reset to defaults: ${loaded.rejected.join(', ')}`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') keepBadFile(`reset to defaults: ${err}`)
  }
  state = normalize({ ...RUNTIME_DEFAULTS, ...persisted, ...runtime })
}

/** The next write replaces state.json, so keep the rejected copy to recover from. */
function keepBadFile(why: string) {
  console.error('[state]', why)
  try {
    fs.copyFileSync(file(), `${file()}.bad`)
  } catch {}
}

export const getState = () => state

/** The top-level keys that differ between two states, by identity (patchState keeps unchanged keys' identity). */
export const changedKeys = (a: State, b: State) => (Object.keys(b) as (keyof State)[]).filter((k) => a[k] !== b[k])

export function subscribe(fn: (s: State, prev: State) => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function patchState(patch: Partial<State> | Record<string, unknown>) {
  const patched = normalize(applyPatch(state, patch as Record<string, unknown>))
  // Only the top-level keys whose value changed take the new value; the rest keep their identity, so windows are
  // sent just what changed (changedKeys) and unchanged parts don't re-render.
  const keys = (Object.keys(patched) as (keyof State)[]).filter((k) => patched[k] !== state[k] && !isDeepStrictEqual(patched[k], state[k]))
  if (!keys.length) return
  const next = { ...state }
  for (const k of keys) (next as Record<string, unknown>)[k] = patched[k]
  const prev = state
  const persistedChanged = !isDeepStrictEqual(pickPersisted(prev), pickPersisted(next))
  // Refuse a value that wouldn't load back exactly: a bad one would be reset at the next launch, and
  // one the loader quietly replaces (a non-object group, an unknown shortcut) would still be live until then.
  if (persistedChanged) {
    const json = JSON.stringify(pickPersisted(next))
    if (!isDeepStrictEqual(parsePersisted(json), JSON.parse(json))) throw new Error('invalid settings')
  }
  state = next
  if (persistedChanged) scheduleWrite()
  for (const fn of listeners) fn(state, prev)
}

function scheduleWrite() {
  writeTimer ??= setTimeout(flushState, 200)
}

export function flushState() {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = null
  const tmp = `${file()}.tmp`
  try {
    // Private: it holds mode prompts. Flushed to disk before the rename, so a crash or power loss can't leave a truncated state.json.
    fs.writeFileSync(tmp, JSON.stringify(pickPersisted(state), null, 2), { mode: 0o600, flush: true })
    fs.chmodSync(tmp, 0o600) // in case a stale tmp file already existed
    fs.renameSync(tmp, file())
  } catch (err) {
    console.error('[state] write failed:', err)
  }
}

export function resetAllState() {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = null
  fs.rmSync(file(), { force: true })
}
