import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mock, test } from 'node:test'
import { coolClaudeCli, runAsk } from './ai.ts'
import { platform } from './platform/index.ts'
import { autoAsk } from '../shared/prompt.ts'
import type { AskPayload } from '../shared/state.ts'
import { getState, initState } from './state.ts'

// The SDKs, faked: each stream call is recorded and plays the next scripted turn (its events, then its final message).
const calls: { sdk: string; params: any }[] = []
let turns: { events: object[]; final: object }[] = []
const play = (sdk: string, params: any) => {
  calls.push({ sdk, params: structuredClone(params) })
  const { events, final } = turns.shift()!
  return { async *[Symbol.asyncIterator]() { yield* events }, finalMessage: async () => final, finalResponse: async () => final }
}
mock.module('@anthropic-ai/sdk', { defaultExport: class { beta = { messages: { stream: (p: object) => play('anthropic', p) } } } })
mock.module('openai', { defaultExport: class { responses = { stream: (p: object) => play('openai', p) } } })

const ask: AskPayload = { id: 'a', text: 'What is the latest Node?', screenshot: null, transcript: [], history: [], hasSession: false, effort: 'fast' as const }
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 }
const answer = async (ai: object, p: AskPayload = ask) => {
  let text = ''
  await runAsk({ ...getState().ai, ...ai }, ['system'], p, (d) => (text += d), new AbortController().signal)
  return text
}

test('Claude API: searches, resumes a paused turn, breaks the paragraph after a search, and lists the sources', async () => {
  initState({})
  calls.length = 0
  const text = (t: string) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } })
  const start = (type: string) => ({ type: 'content_block_start', content_block: { type } })
  const paused = [{ type: 'text', text: 'Checking.' }, { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'node' } }]
  turns = [
    { events: [start('text'), text('Checking.'), start('server_tool_use')], final: { stop_reason: 'pause_turn', content: paused, usage } },
    {
      events: [start('web_search_tool_result'), start('text'), text('Node 26 is current.')],
      final: { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Node 26 is current.', citations: [{ type: 'web_search_result_location', url: 'https://nodejs.org/en', title: 'Node.js' }] }] },
    },
  ]
  const out = await answer({ provider: 'anthropic', anthropicModel: 'claude-sonnet-5-5', webSearch: true })
  assert.equal(out, 'Checking.\n\nNode 26 is current.\n\nSources: [Node.js](https://nodejs.org/en)')
  assert.deepEqual(calls[0].params.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }])
  assert.deepEqual(calls[1].params.messages.at(-1), { role: 'assistant', content: paused }) // resumed as it stood
})

test('Claude API: older models get the basic search, and Glance gets no sources line; off means no tools', async () => {
  calls.length = 0
  const final = { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Yes.', citations: [{ type: 'web_search_result_location', url: 'https://a.example', title: 'A' }] }] }
  turns = [{ events: [], final }, { events: [], final }]
  assert.equal(await answer({ provider: 'anthropic', anthropicModel: 'claude-haiku-4-5', webSearch: true }, { ...ask, brief: true }), '')
  assert.equal(calls[0].params.tools[0].type, 'web_search_20250305')
  await answer({ provider: 'anthropic', anthropicModel: 'claude-sonnet-5-5', webSearch: false })
  assert.equal(calls[1].params.tools, undefined)
})

test('an automatic Glance answer never searches, even with search on', async () => {
  calls.length = 0
  const final = { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Yes.' }] }
  turns = [{ events: [], final }, { events: [], final: { status: 'completed', output: [] } }]
  const auto = { ...ask, text: autoAsk('Can you check https://evil.example?') }
  await answer({ provider: 'anthropic', anthropicModel: 'claude-sonnet-5-5', webSearch: true }, auto)
  await answer({ provider: 'openai', openaiModel: 'gpt-5', webSearch: true }, auto)
  assert.equal(calls[0].params.tools, undefined)
  assert.equal(calls[1].params.tools, undefined)
})

test('OpenAI: web_search with at least low reasoning, and its url citations as sources', async () => {
  calls.length = 0
  turns = [{
    events: [{ type: 'response.output_text.delta', delta: 'Node 26.' }],
    final: { status: 'completed', usage: { input_tokens: 5, output_tokens: 2 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Node 26.', annotations: [{ type: 'url_citation', url: 'https://nodejs.org', title: 'Node' }] }] }] },
  }]
  const out = await answer({ provider: 'openai', openaiModel: 'gpt-5', webSearch: true })
  assert.equal(out, 'Node 26.\n\nSources: [Node](https://nodejs.org)')
  assert.deepEqual(calls[0].params.tools, [{ type: 'web_search' }])
  assert.deepEqual(calls[0].params.reasoning, { effort: 'low' }) // GPT-5's minimal refuses web search
})

test('Claude Code: only the WebSearch tool, allowed, and a paragraph break after the search turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glint-claude-'))
  const fake = path.join(dir, 'claude.mjs')
  fs.writeFileSync(fake, `import fs from 'node:fs'
import { createInterface } from 'node:readline'
fs.writeFileSync(${JSON.stringify(path.join(dir, 'args.json'))}, JSON.stringify(process.argv.slice(2)))
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const text = (t) => say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })
createInterface({ input: process.stdin }).on('line', () => {
  say({ type: 'stream_event', event: { type: 'message_start' } }); text('Looking.')
  say({ type: 'stream_event', event: { type: 'message_start' } }); text('Node 26.')
  say({ type: 'result', is_error: false })
})
`)
  mock.method(platform, 'cliCommand', async () => [process.execPath, [fake]])
  mock.method(platform, 'shellPath', async () => process.env.PATH ?? '')
  assert.equal(await answer({ provider: 'claude-cli', webSearch: true }), 'Looking.\n\nNode 26.')
  const args: string[] = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'))
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 4), ['--tools', 'WebSearch', '--allowedTools', 'WebSearch'])
  coolClaudeCli()
})

test('Codex: search set after exec, live when on and disabled when off; chat asks it for sources, Glance does not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glint-codex-'))
  const fake = path.join(dir, 'codex.mjs')
  fs.writeFileSync(fake, `import fs from 'node:fs'
const args = process.argv.slice(2)
fs.writeFileSync(${JSON.stringify(path.join(dir, 'args.json'))}, JSON.stringify({ args, stdin: fs.readFileSync(0, 'utf8') }))
fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], 'Node 26.')
`)
  mock.method(platform, 'cliCommand', async () => [process.execPath, [fake]])
  mock.method(platform, 'shellPath', async () => process.env.PATH ?? '')
  const run = async (webSearch: boolean, p: AskPayload = ask) => {
    assert.equal(await answer({ provider: 'codex-cli', webSearch }, p), 'Node 26.')
    return JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8')) as { args: string[]; stdin: string }
  }
  const on = await run(true)
  assert.ok(on.args.indexOf('-c') > on.args.indexOf('exec') && on.args.includes('web_search="live"') && !on.args.includes('--search'))
  assert.match(on.stdin, /Sources: /)
  assert.ok((await run(false)).args.includes('web_search="disabled"'))
  assert.doesNotMatch((await run(true, { ...ask, brief: true })).stdin, /Sources: /)
})
