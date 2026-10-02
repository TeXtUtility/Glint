import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AllFailedError, failureSummary, prettyModel, providerOrder, splitFailure, tryInOrder } from './providers.ts'
import type { AiProvider } from './state.ts'

test('providerOrder: chosen first, fallbacks after, no repeats', () => {
  assert.deepEqual(providerOrder({ provider: 'openai', fallbacks: ['claude-cli', 'openai', 'anthropic'] }), ['openai', 'claude-cli', 'anthropic'])
  assert.deepEqual(providerOrder({ provider: 'anthropic', fallbacks: [] }), ['anthropic'])
})

test('tryInOrder: falls through failures, skips unusable fallbacks, reports switches', async () => {
  const tried: AiProvider[] = []
  const switches: string[] = []
  const r = await tryInOrder(['anthropic', 'openai', 'claude-cli'], async (p) => {
    tried.push(p)
    if (p === 'anthropic') throw new Error('no key')
  }, { usable: (p) => p !== 'openai', onSwitch: (f, next) => switches.push(`${f.length}->${next}`) })
  assert.equal(r.provider, 'claude-cli')
  assert.deepEqual(tried, ['anthropic', 'claude-cli'])
  assert.deepEqual(r.failures, [{ provider: 'anthropic', error: 'no key' }])
  assert.deepEqual(switches, ['1->claude-cli'])
})

test('tryInOrder: the first provider is tried even if not usable; success reports no failures', async () => {
  const r = await tryInOrder(['anthropic'], async () => {}, { usable: () => false })
  assert.deepEqual(r, { provider: 'anthropic', failures: [] })
})

test('tryInOrder: stops after a partial answer or a final error, and says everything that failed', async () => {
  const partial = tryInOrder(['anthropic', 'openai'], async (p, onText) => {
    onText()
    throw new Error(`${p} dropped`)
  })
  await assert.rejects(partial, (e: AllFailedError) => e.failures.length === 1 && /Claude API failed: anthropic dropped/.test(e.message))
  const refused = tryInOrder(['anthropic', 'openai'], async () => { throw new Error('declined') }, { isFinal: () => true })
  await assert.rejects(refused, (e: AllFailedError) => e.failures.length === 1)
  const all = tryInOrder(['anthropic', 'codex-cli'], async (p) => { throw new Error(`${p} down`) })
  await assert.rejects(all, /No AI could answer\. Claude API failed: anthropic down · Codex failed: codex-cli down/)
})

test('prettyModel: short names for the UI', () => {
  assert.equal(prettyModel('claude-opus-5'), 'Opus 5')
  assert.equal(prettyModel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5')
  assert.equal(prettyModel('claude-sonnet-5-20260101'), 'Sonnet 5')
  assert.equal(prettyModel('claude-fable-5-1'), 'Fable 5.1')
  assert.equal(prettyModel('opus'), 'Opus')
  assert.equal(prettyModel('gpt-5.5'), 'GPT-5.5')
  assert.equal(prettyModel(''), '')
})

test('failureSummary names who answered instead', () => {
  const line = failureSummary([{ provider: 'anthropic', error: 'Rate limited' }], 'claude-cli')
  assert.equal(line, 'Claude API failed: Rate limited · Claude Code answered instead')
  assert.deepEqual(splitFailure(line), ['Claude API failed: Rate limited', 'Claude Code answered instead'])
  assert.deepEqual(splitFailure('No AI could answer. Claude API failed: x · OpenAI API failed: y'), ['No AI could answer. Claude API failed: x · OpenAI API failed: y', null])
})

test('tryInOrder: a provider that stalls before answering hands over to the next', async (t) => {
  const seen: string[] = []
  const r = await tryInOrder(['claude-cli', 'anthropic'], async (p, onText, signal) => {
    if (p === 'claude-cli') {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve())) // stalls, ends quietly when stopped
      return
    }
    onText()
    seen.push(p)
  }, { firstTextMs: (p) => (p === 'claude-cli' ? 30 : undefined) })
  assert.equal(r.provider, 'anthropic')
  assert.deepEqual(r.failures, [{ provider: 'claude-cli', error: 'timed out (no answer in 0 s)' }])
  assert.equal(failureSummary(r.failures, 'anthropic'), 'Claude Code timed out (no answer in 0 s) · Claude API answered instead')
  // Once text has started, the clock stops: a long answer is not cut off.
  const long = await tryInOrder(['anthropic'], async (_p, onText) => {
    onText()
    await new Promise((resolve) => setTimeout(resolve, 60))
  }, { firstTextMs: () => 20 })
  assert.deepEqual(long, { provider: 'anthropic', failures: [] })
  // Still thinking (signs of life) past the limit isn't a stall: no second provider is asked and paid for. On a mocked
  // clock, so a busy machine firing timers late can't make it look like one.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const thinking = tryInOrder(['anthropic', 'claude-cli'], async (_p, onText, _s, alive) => {
    // 120 ms of thinking against a 100 ms limit, a sign of life every 10 ms.
    for (let i = 0; i < 12; i++) (await new Promise((resolve) => setTimeout(resolve, 10)), alive())
    onText()
  }, { firstTextMs: () => 100 })
  for (let i = 0; i < 12; i++) (t.mock.timers.tick(10), await new Promise(setImmediate))
  assert.deepEqual(await thinking, { provider: 'anthropic', failures: [] })
})
