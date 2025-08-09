// Model workers (speech, voices) are ended by asking, never by terminate() alone: a worker terminated inside a
// native call (a model loading or decoding) makes the speech library throw on a dying thread, which aborts the app.
import { parentPort, type Worker } from 'node:worker_threads'

export type Ask = <T>(t: string, payload: object) => Promise<T>

/**
 * In a worker: handles its messages one at a time, async ones included, and on { t: 'quit' } exits once the task in
 * hand is done, so it never ends inside a native call.
 */
export function serve<M extends { t: string }>(handle: (m: M) => unknown) {
  let queue: Promise<unknown> = Promise.resolve()
  parentPort!.on('message', (m: M | { t: 'quit' }) => {
    queue = queue
      .then(() => (m.t === 'quit' ? process.exit(0) : handle(m as M)))
      .catch((err: Error) => parentPort!.postMessage({ t: 'error', id: 'id' in m ? m.id : undefined, message: err?.message }))
  })
}

export const transducer = (dir: string, extra?: { modelType: string }) => ({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: { encoder: `${dir}/encoder.int8.onnx`, decoder: `${dir}/decoder.int8.onnx`, joiner: `${dir}/joiner.int8.onnx` },
    tokens: `${dir}/tokens.txt`,
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
    ...extra,
  },
})

export async function loadWorker(w: Worker, load: object, what: string, onProgress?: (pct: number) => void): Promise<Ask> {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let next = 0
  await new Promise<void>((resolve, reject) => {
    w.on('message', (m: { t: string; id?: number; value?: unknown; message?: string; pct?: number }) => {
      if (m.t === 'ready') return resolve()
      if (m.t === 'progress') return onProgress?.(m.pct ?? 0)
      const p = m.id === undefined ? undefined : pending.get(m.id)
      if (m.id !== undefined) pending.delete(m.id)
      if (m.t === 'result') p?.resolve(m.value)
      else if (m.t === 'error') (p ? p.reject(new Error(m.message)) : reject(new Error(m.message)))
    })
    w.on('error', reject)
    w.on('exit', () => {
      for (const p of pending.values()) p.reject(new Error(`the ${what} was unloaded`))
      pending.clear()
      reject(new Error(`the ${what} stopped`))
    })
    w.postMessage(load)
  })
  return <T>(t: string, payload: object) => new Promise<T>((resolve, reject) => {
    const id = next++
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    w.postMessage({ t, id, ...payload })
  })
}

/** In main: asks a worker to quit after its current task; one still running after 2 minutes is stuck, and ended. */
export function stopWorker(w: Worker) {
  w.postMessage({ t: 'quit' })
  const stuck = setTimeout(() => void w.terminate(), 120_000).unref()
  w.once('exit', () => clearTimeout(stuck))
}
