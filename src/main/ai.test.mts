import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mock, test } from 'node:test'
import { coolClaudeCli, runAsk, warmClaudeCli } from './ai.ts'
import { platform } from './platform/index.ts'
import { getState, initState } from './state.ts'

// A stand-in `claude`: answers every message it's sent with "hi", in Claude Code's stream-json.
const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glint-claude-')), 'claude.mjs')
fs.writeFileSync(fake, `import { createInterface } from 'node:readline'
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
createInterface({ input: process.stdin }).on('line', () => {
  say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } })
  say({ type: 'result', is_error: false })
})
`)

test('an ask never goes to a Claude Code process that is being ended (it would fail with exit code 143)', async () => {
  mock.method(platform, 'cliCommand', async () => [process.execPath, [fake]])
  mock.method(platform, 'shellPath', async () => process.env.PATH ?? '')
  initState({})
  const ai = { ...getState().ai, provider: 'claude-cli' as const }
  await warmClaudeCli(ai, ['system'], 'fast')
  coolClaudeCli() // ends the spare, which takes a moment to exit
  let text = ''
  const ask = { id: 'a', text: 'q', screenshot: null, transcript: [], history: [], hasSession: false, effort: 'fast' as const }
  await runAsk(ai, ['system'], ask, (d) => (text += d), new AbortController().signal)
  assert.equal(text, 'hi')
  coolClaudeCli()
})
