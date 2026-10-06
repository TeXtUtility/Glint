// The call's audio on a Mac: audiotee taps the system's output (Core Audio, macOS 14.2+) as 16 kHz mono PCM16.
import { AudioTee } from 'audiotee'
import { app } from 'electron'
import type { ChildProcess } from 'node:child_process'
import path from 'node:path'

export async function start(onPcm16: (bytes: Uint8Array) => void, onFailed: (err: Error) => void) {
  // Packaged, the helper sits outside app.asar: a binary inside can't be run.
  const binaryPath = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked/node_modules/audiotee/bin/audiotee') : undefined
  const t = new AudioTee({ sampleRate: 16000, chunkDurationMs: 50, binaryPath })
  let live = true
  const failed = (err: Error) => live && onFailed(err)
  // Pipe reads can end mid-sample; carry an odd byte over so later samples stay aligned.
  let carry: Buffer | null = null
  t.on('data', ({ data }: { data: Buffer }) => {
    if (!live) return // a stopped helper can still flush output for a moment
    let b = carry ? Buffer.concat([carry, data]) : data
    carry = b.length % 2 ? b.subarray(b.length - 1) : null
    if (carry) b = b.subarray(0, b.length - 1)
    onPcm16(b)
  })
  t.on('error', failed)
  t.on('stop', () => failed(new Error('system audio helper exited')))
  const stop = () => {
    live = false
    return t.stop()
  }
  try {
    await t.start()
  } catch (err) {
    void stop().catch(() => {})
    throw err
  }
  // audiotee only reports non-zero exit codes; a helper killed by a signal (code null) would go unnoticed.
  ;(t as unknown as { process?: ChildProcess }).process?.once('exit', (code, signal) => failed(new Error(`system audio helper exited (${signal ?? code})`)))
  return stop
}
