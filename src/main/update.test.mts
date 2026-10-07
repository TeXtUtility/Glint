import assert from 'node:assert/strict'
import cp from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { afterEach, mock, test } from 'node:test'
import { getState, initState } from './state.ts'
import { checkForUpdate, installUpdate } from './update.ts'

initState({ updateChannel: 'beta' })
Object.assign(globalThis, { __GLINT_COMMIT__: 'abc1234' })
afterEach(() => {
  mock.restoreAll()
  syncBuiltinESMExports()
})

/** Answers GitHub's API with `reply(url)`: JSON, or a number for that error status. */
function github(reply: (url: string) => object | number) {
  mock.method(globalThis, 'fetch', async (url: string) => {
    const r = reply(url)
    return typeof r === 'number' ? new Response('', { status: r }) : Response.json(r)
  })
}

const compare = (head: string) => (url: string) =>
  url.endsWith('/compare/abc1234...beta')
    ? { ahead_by: 2, commits: [{ sha: 'older', commit: { message: 'Older' } }, { sha: head, commit: { message: 'Newer\n\nWhy it changed' } }] }
    : 404

test("checkForUpdate: an offer whose commit isn't a full SHA is refused", async () => {
  github(compare('deadbeef'))
  await checkForUpdate(true)
  assert.equal(getState().update.status, 'failed')
  assert.match(getState().update.message ?? '', /which commit/)
})

test("checkForUpdate: a build whose commit GitHub hasn't got is current", async () => {
  github(() => 404)
  await checkForUpdate(true)
  assert.equal(getState().update.status, 'current')
})

test('installUpdate: the installer comes from the commit offered, and builds exactly that commit', async () => {
  const sha = '4288055f2a9c0d1e3b5a7c9e1f2a3b4c5d6e7f80'
  github(compare(sha))
  await checkForUpdate(true)
  const { status, version, channel, commits } = getState().update
  assert.deepEqual({ status, version, channel, commits }, { status: 'available', version: '4288055', channel: 'beta', commits: ['Newer', 'Older'] })

  let call: [string, string[], { env: Record<string, string> }] | undefined
  // The login shell's PATH, looked up for the installer.
  mock.method(cp, 'execFile', (_file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string) => void) =>
    setImmediate(() => cb(null, '/usr/bin:/bin\n')))
  mock.method(cp, 'spawn', (...args: [string, string[], { env: Record<string, string> }]) => {
    call = args
    return Object.assign(new EventEmitter(), { unref() {} })
  })
  syncBuiltinESMExports() // update.ts and ai.ts import them by name
  await installUpdate()
  assert.ok(call)
  const [file, args, { env }] = call
  if (process.platform === 'win32') {
    // Through cmd, never a detached PowerShell, which quits without running anything.
    assert.match(file, /cmd\.exe$/)
    assert.ok(args.at(-1)!.endsWith(`; irm 'https://raw.githubusercontent.com/TeXtUtility/Glint/${sha}/install.ps1' | iex""`))
  } else {
    assert.equal(file, '/bin/bash')
    assert.match(args[1], new RegExp(`curl -fsSL "https://raw\\.githubusercontent\\.com/TeXtUtility/Glint/${sha}/install\\.sh" \\| bash`))
  }
  assert.equal(env.GLINT_COMMIT, sha)
  assert.equal(env.GLINT_BRANCH, 'beta')
  assert.equal(getState().update.status, 'installing')
})
