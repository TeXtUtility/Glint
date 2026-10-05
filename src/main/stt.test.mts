import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, mock, test } from 'node:test'
import { workers } from '../test/node-worker.ts'
import { fetchSherpaModel, loadLocalAsr, SHERPA_SHA256, unloadLocalAsr } from './stt.ts'
import { TAR } from './system.ts'

const FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']
const PARAKEET = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glint-stt-test-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))
const folder = () => fs.mkdtempSync(path.join(tmp, 'models-'))

/** A model package, `name`/ with its four files, as the .tar.bz2 the release has. */
function pack(name: string): Buffer {
  const src = folder()
  fs.mkdirSync(path.join(src, name))
  for (const f of FILES) fs.writeFileSync(path.join(src, name, f), f)
  execFileSync(TAR, ['-cjf', path.join(src, 'pkg.tar.bz2'), '-C', src, name])
  return fs.readFileSync(path.join(src, 'pkg.tar.bz2'))
}

function placed(into: string, name: string, files = FILES) {
  fs.mkdirSync(path.join(into, name), { recursive: true })
  for (const f of files) fs.writeFileSync(path.join(into, name, f), f)
}

const serve = (body: () => BodyInit | null, init?: ResponseInit) => mock.method(globalThis, 'fetch', async () => new Response(body(), init))

test("fetchSherpaModel: a package with all four files on disk isn't downloaded; one missing a file is", async () => {
  const into = folder()
  placed(into, PARAKEET)
  const fetched = serve(() => null, { status: 404 })
  await fetchSherpaModel(PARAKEET, into)
  assert.equal(fetched.mock.callCount(), 0)
  fs.rmSync(path.join(into, PARAKEET, 'tokens.txt'))
  await assert.rejects(fetchSherpaModel(PARAKEET, into), /HTTP 404/)
  assert.equal(fetched.mock.callCount(), 1)
  mock.restoreAll()
})

test('fetchSherpaModel: two calls while it downloads share one download, which unpacks into place', async () => {
  const name = 'sherpa-onnx-test-package'
  const archive = pack(name)
  SHERPA_SHA256[name] = createHash('sha256').update(archive).digest('hex')
  const into = folder()
  placed(into, name, ['encoder.int8.onnx']) // a partial copy, replaced
  const fetched = serve(() => new Uint8Array(archive), { headers: { 'content-length': String(archive.length) } })
  const pct: number[] = []
  await Promise.all([fetchSherpaModel(name, into, (p) => pct.push(p)), fetchSherpaModel(name, into)])
  mock.restoreAll()
  delete SHERPA_SHA256[name]
  assert.equal(fetched.mock.callCount(), 1)
  assert.equal(pct.at(-1), 100)
  assert.deepEqual(fs.readdirSync(into), [name])
  assert.deepEqual(fs.readdirSync(path.join(into, name)).sort(), [...FILES].sort())
})

test("fetchSherpaModel: a download that doesn't match its SHA-256 rejects, leaves nothing behind, and is tried again next time", async () => {
  const into = folder()
  const fetched = serve(() => new Uint8Array(pack(PARAKEET)))
  await assert.rejects(fetchSherpaModel(PARAKEET, into), /corrupted/)
  assert.deepEqual(fs.readdirSync(into), [])
  await assert.rejects(fetchSherpaModel(PARAKEET, into), /corrupted/)
  assert.equal(fetched.mock.callCount(), 2)
  mock.restoreAll()
})

test('fetchSherpaModel: a connection that breaks mid-download rejects rather than hanging, and leaves no partial archive', async () => {
  const into = folder()
  serve(() => new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(64 * 1024))
      c.error(new Error('socket hang up'))
    },
  }))
  await assert.rejects(fetchSherpaModel(PARAKEET, into), /socket hang up/)
  mock.restoreAll()
  assert.deepEqual(fs.readdirSync(into), [])
})

test("fetchSherpaModel: a write that fails (a full disk, a folder it can't write) rejects rather than hanging", async () => {
  const into = folder()
  fs.chmodSync(into, 0o500)
  serve(() => new Uint8Array(1024 * 1024))
  await assert.rejects(fetchSherpaModel(PARAKEET, into), { code: 'EACCES' })
  mock.restoreAll()
  fs.chmodSync(into, 0o700)
  assert.deepEqual(fs.readdirSync(into), [])
})

test('loadLocalAsr: unloaded while loading starts no worker; one that crashes is replaced at the next line, not waited on', async () => {
  const cache = folder()
  placed(path.join(cache, 'asr'), PARAKEET)
  const tick = () => new Promise((r) => setImmediate(r))
  const first = loadLocalAsr('en', 'base', cache)
  unloadLocalAsr()
  await assert.rejects(first, /unloaded/)
  assert.equal(workers.length, 0)

  const loading = loadLocalAsr('en', 'base', cache)
  await tick()
  assert.equal(workers.length, 1)
  workers[0].emit('message', { t: 'ready' })
  const transcribe = await loading
  const line = transcribe(new Float32Array(16), 'en')
  workers[0].emit('exit', 1) // crashed
  await assert.rejects(line, /unloaded/)

  const again = loadLocalAsr('en', 'base', cache)
  await tick()
  assert.equal(workers.length, 2)
  workers[1].emit('message', { t: 'ready' })
  await again
  unloadLocalAsr()
  // Asked to quit after its current task, never terminated mid-decode (worker.ts).
  assert.deepEqual(workers[1].posted.at(-1), { t: 'quit' })
  assert.equal(workers[1].terminated, false)
})
