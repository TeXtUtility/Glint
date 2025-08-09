// Stands in for every `?nodeWorker` import (setup.ts): the factory makes a fake Worker that records what it's sent.
import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'

export class FakeWorker extends EventEmitter {
  posted: unknown[] = []
  terminated = false
  postMessage(m: unknown) {
    this.posted.push(m)
  }
  terminate() {
    this.terminated = true
    setImmediate(() => this.emit('exit', 1)) // later, as a real worker's
    return Promise.resolve(1)
  }
}

/** Every worker made so far, newest last. */
export const workers: FakeWorker[] = []

export default function createWorker(): Worker {
  const w = new FakeWorker()
  workers.push(w)
  return w as unknown as Worker
}
