// Keystrokes typed into any app, for Ghost on Windows: a listen-only keyboard hook on a thread of its own
// (keys-worker.ts). Windows asks no permission, and has no secure input, so password fields are seen too.
import koffi from 'koffi'
import type { Worker } from 'node:worker_threads'
import type { KeyInput } from '../types'
import createKeysWorker from './keys-worker?nodeWorker'

let handlers: { onKey: (k: KeyInput) => void; onDoubleControl: () => void } = { onKey: () => {}, onDoubleControl: () => {} }

let winHook: { worker: Worker; thread: number | null; stopping: boolean } | null = null

function watchKeysWin() {
  if (winHook) return true
  const worker = createKeysWorker()
  const h = (winHook = { worker, thread: null as number | null, stopping: false })
  worker.on('message', (m: { t: string; thread?: number; key?: KeyInput; message?: string }) => {
    if (m.t === 'ready') (h.thread = m.thread!), h.stopping && quitThread(h.thread)
    else if (m.t === 'key' && winHook === h) handlers.onKey(m.key!)
    else if (m.t === 'ctrl2' && winHook === h) handlers.onDoubleControl()
    else if (m.t === 'error') console.error('[keys]', m.message)
  })
  worker.on('error', (err) => console.error('[keys] hook failed:', err))
  worker.on('exit', () => winHook === h && (winHook = null))
  return true
}

let postQuit: ((thread: number, msg: number, w: number, l: number) => boolean) | null = null
/** The hook's thread sits in GetMessage, so it's ended with WM_QUIT rather than terminate(). */
function quitThread(thread: number) {
  postQuit ??= koffi.load('user32.dll').func('bool PostThreadMessageW(uint32_t thread, uint32_t msg, uintptr_t w, intptr_t l)')
  postQuit(thread, 0x12, 0, 0)
}

export function stopKeys() {
  if (!winHook) return
  const h = winHook
  winHook = null
  h.stopping = true
  if (h.thread) quitThread(h.thread)
}

export function watchKeys(onKey: (k: KeyInput) => void, onDoubleControl: () => void): boolean {
  handlers = { onKey, onDoubleControl }
  return watchKeysWin()
}
