// Model workers (speech, voices) are ended by asking, never by terminate() alone: a worker terminated inside a
// native call (a model loading or decoding) makes the speech library throw on a dying thread, which aborts the app.
import { parentPort, type Worker } from 'node:worker_threads'

/**
 * In a worker: handles its messages one at a time, async ones included, and on { t: 'quit' } exits once the task in
 * hand is done, so it never ends inside a native call.
 */
export function serve<M extends { t: string }>(handle: (m: M) => unknown) {
  let queue: Promise<unknown> = Promise.resolve()
  parentPort!.on('message', (m: M | { t: 'quit' }) => {
    queue = queue.then(() => (m.t === 'quit' ? process.exit(0) : handle(m as M))).catch(() => {}) // handlers report their own errors
  })
}

/** In main: asks a worker to quit after its current task; one still running after 2 minutes is stuck, and ended. */
export function stopWorker(w: Worker) {
  w.postMessage({ t: 'quit' })
  const stuck = setTimeout(() => void w.terminate(), 120_000).unref()
  w.once('exit', () => clearTimeout(stuck))
}
