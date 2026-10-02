import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mock, test } from 'node:test'
import { PERSISTED_DEFAULTS } from '../shared/state.ts'
import { freshUserData } from '../test/electron.ts'
import { flushState, getState, initState, patchState } from './state.ts'

test("initState: a state.json that won't parse is kept as state.json.bad, and the defaults load", () => {
  const dir = freshUserData()
  fs.writeFileSync(path.join(dir, 'state.json'), '{"theme": "dark", "modes": [')
  mock.method(console, 'error', () => {})
  initState({})
  mock.restoreAll()
  assert.equal(fs.readFileSync(path.join(dir, 'state.json.bad'), 'utf8'), '{"theme": "dark", "modes": [')
  assert.equal(getState().theme, PERSISTED_DEFAULTS.theme)
})

test('initState: one bad setting falls back to its default alone, and the file is kept as it was', () => {
  const dir = freshUserData()
  const json = JSON.stringify({ theme: 'dark', updateChannel: 'nightly', ghostAutoSkip: false })
  fs.writeFileSync(path.join(dir, 'state.json'), json)
  mock.method(console, 'error', () => {})
  initState({})
  mock.restoreAll()
  assert.equal(getState().updateChannel, 'stable')
  assert.equal(getState().theme, 'dark')
  assert.equal(getState().ghostAutoSkip, false)
  assert.equal(fs.readFileSync(path.join(dir, 'state.json.bad'), 'utf8'), json)
})

test('initState: a first launch, with no state.json, keeps no .bad copy', () => {
  const dir = freshUserData()
  initState({})
  assert.equal(getState().theme, PERSISTED_DEFAULTS.theme)
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('flushState: writes a private temp file and renames it over state.json, even past a stale temp file', () => {
  const file = path.join(freshUserData(), 'state.json')
  initState({})
  fs.writeFileSync(`${file}.tmp`, 'left by a crash', { mode: 0o644 })
  const writes = mock.method(fs, 'writeFileSync')
  const renames = mock.method(fs, 'renameSync')
  patchState({ theme: 'dark' })
  flushState()
  mock.restoreAll()
  assert.equal(writes.mock.calls[0].arguments[0], `${file}.tmp`)
  assert.deepEqual(writes.mock.calls[0].arguments[2], { mode: 0o600, flush: true }) // on disk before the rename
  assert.deepEqual(renames.mock.calls[0].arguments, [`${file}.tmp`, file])
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.existsSync(`${file}.tmp`), false)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).theme, 'dark')
})

test('flushState: a write that fails part-way leaves the old state.json whole', () => {
  const file = path.join(freshUserData(), 'state.json')
  initState({})
  patchState({ theme: 'light' })
  flushState()
  const before = fs.readFileSync(file, 'utf8')
  mock.method(fs, 'writeFileSync', (f: string) => {
    fs.appendFileSync(f, '{"the')
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
  })
  mock.method(console, 'error', () => {})
  patchState({ theme: 'dark' })
  flushState()
  mock.restoreAll()
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})
