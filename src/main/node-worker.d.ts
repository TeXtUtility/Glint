// electron-vite bundles a `?nodeWorker` import as its own file and returns a factory for it.
declare module '*?nodeWorker' {
  import type { Worker, WorkerOptions } from 'node:worker_threads'
  export default function createWorker(options?: WorkerOptions): Worker
}
