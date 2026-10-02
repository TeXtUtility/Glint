import assert from 'node:assert/strict'
import { test } from 'node:test'
import { errorOf, hasProse, humanizes, maxWords, protect, requestFor, restore, resultOf, split, tooShort, words, type HumanizerConfig } from './humanize.ts'

const md = `Stop the old server first, then start it again with \`npm run dev\`:

\`\`\`bash
lsof -ti tcp:3000 | xargs kill
npm run dev
\`\`\`

The gap is $\\frac{1}{8}$ of the price, see [the pricing page](https://example.com/pricing "Pricing") or https://example.com/faq.
⇥
Second field's answer.`

test('protect takes out code, maths, link addresses and field breaks, and restore puts them back byte for byte', () => {
  const { text, spans } = protect(md)
  assert.deepEqual(spans, [
    '`npm run dev`',
    '```bash\nlsof -ti tcp:3000 | xargs kill\nnpm run dev\n```',
    '$\\frac{1}{8}$',
    '](https://example.com/pricing "Pricing")',
    'https://example.com/faq.',
    '⇥',
  ])
  assert.ok(!/npm run dev|lsof|frac|example\.com/.test(text))
  assert.ok(text.includes('[the pricing page⟦4⟧'), 'the link text stays in the prose')
  assert.equal(restore(text, spans), md)
  // A rewrite that keeps every marker once, anywhere, restores; one that loses or repeats one doesn't.
  assert.equal(restore(text.replace('Stop the old server first', 'First, stop the old server'), spans), md.replace('Stop the old server first', 'First, stop the old server'))
  assert.equal(restore(text.replace('⟦2⟧', ''), spans), null)
  assert.equal(restore(`${text} ⟦3⟧`, spans), null)
  assert.equal(restore(text.replace('⟦6⟧', '⟦7⟧'), spans), null)
})

test('prices are prose, not maths; an all-code answer has nothing to rewrite', () => {
  assert.deepEqual(protect('It costs $30 now and $40 next year.').spans, [])
  assert.equal(hasProse(protect('```js\nx()\n```').text), false)
  assert.equal(hasProse(protect('Run `x`.').text), true)
})

test('fences indented in a list item, and tables, are kept whole', () => {
  const list = '1. Install it:\n\n   ```bash\n   npm i -g x\n   ```\n\n2. Then run it.'
  const { text, spans } = protect(list)
  assert.deepEqual(spans, ['   ```bash\n   npm i -g x\n   ```'])
  assert.equal(text, '1. Install it:\n\n⟦1⟧\n\n2. Then run it.')
  assert.equal(restore(text, spans), list)
  const table = 'Plans compared:\n\n| Plan | Price |\n|:-----|------:|\n| Free | $0 |\n| Pro | $20 |\n\nPick one.'
  assert.deepEqual(protect(table).spans, ['| Plan | Price |\n|:-----|------:|\n| Free | $0 |\n| Pro | $20 |'])
  assert.deepEqual(protect('a | b\n---\nnot a table').spans, []) // a heading underline, not a table's |---| row
})

test('split keeps every word, in order, within the limit', () => {
  const para = (n: number, w: string) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ') + '.'
  const text = [para(30, 'a'), para(30, 'b'), para(130, 'c'), para(10, 'd')].join('\n\n')
  const pieces = split(text, 50)
  assert.ok(pieces.every((p) => words(p) <= 50), pieces.map(words).join(','))
  assert.equal(pieces.join(' ').split(/\s+/).join(' '), text.split(/\s+/).join(' '))
  assert.deepEqual(split('short answer', 300), ['short answer'])
  // A paragraph starting with "..." or with "?!" after a space loses none of it.
  const odd = `...${para(30, 'e')} ?! ${para(30, 'f')} ... and so on`
  assert.equal(split(odd, 50).join(' ').split(/\s+/).join(' '), odd.split(/\s+/).join(' '))
})

test('minimum lengths and per-call limits follow each service', () => {
  assert.equal(tooShort('emulate', 'only a few words here'), true)
  assert.equal(tooShort('emulate', Array(40).fill('word').join(' ')), false)
  assert.equal(tooShort('undetectable', 'under fifty characters'), true)
  assert.equal(maxWords('emulate', null), 300)
  assert.equal(maxWords('emulate', { maxPerCall: 3000 }), 3000)
})

test('Ghost follows its own setting while connected; everything else follows the switch', () => {
  const h = { service: 'emulate' as const, on: false, ghost: true, apply: { chat: true, glance: false } }
  assert.equal(humanizes(h, { typeable: true }), true)
  assert.equal(humanizes(h, {}), false)
  assert.equal(humanizes({ ...h, on: true }, {}), true)
  assert.equal(humanizes({ ...h, on: true }, { brief: true }), false)
  assert.equal(humanizes({ ...h, ghost: false }, { typeable: true }), false)
  assert.equal(humanizes({ ...h, service: 'none' }, { typeable: true }), false)
})

test('each service is asked, and answers, the way its API documents', () => {
  const cfg = (service: HumanizerConfig['service'], extra: Partial<HumanizerConfig> = {}): HumanizerConfig => ({ service, options: {}, custom: null, ...extra })
  const emulate = requestFor(cfg('emulate'), 'ak_live_x', 'Hello there')
  assert.equal(emulate.url, 'https://www.tryemulate.ai/v1/humanize')
  assert.equal(emulate.headers.Authorization, 'Bearer ak_live_x')
  assert.deepEqual(JSON.parse(emulate.body), { text: 'Hello there' })
  assert.deepEqual(resultOf(cfg('emulate'), { id: 'u', tool: 'humanize', text: 'Hi.', reads_human: null, words: { charged: 137 }, elapsed: 96 }), { text: 'Hi.', words: 137 })

  const stealth = requestFor(cfg('stealthgpt', { options: { model: 'bogus' } }), 'k', 'Hello')
  assert.equal(stealth.headers['api-token'], 'k')
  assert.deepEqual(JSON.parse(stealth.body), { prompt: 'Hello', rephrase: true, model: 'standard', outputFormat: 'markdown' })
  assert.deepEqual(resultOf(cfg('stealthgpt'), { result: 'Hi', wordsSpent: 3, remainingCredits: 900 }), { text: 'Hi', words: 3, account: { wordsLeft: 900 } })

  assert.deepEqual(JSON.parse(requestFor(cfg('writehuman', { options: { tone: 'casual' } }), 'k', 'Hello').body), { text: 'Hello', tone: 'casual' })
  assert.deepEqual(resultOf(cfg('writehuman'), { id: '1', results: ['Hi'], input_words: 5, words_remaining: { total: 12400 } }), { text: 'Hi', words: 5, account: { wordsLeft: 12400 } })

  const und = requestFor(cfg('undetectable'), 'k', 'Hello')
  assert.equal(und.headers.apikey, 'k')
  assert.deepEqual(JSON.parse(und.body), { content: 'Hello', readability: 'University', purpose: 'General Writing', strength: 'Balanced', model: 'v2' })
  assert.deepEqual(resultOf(cfg('undetectable'), { id: 'doc1', status: 'queued' }), { text: undefined, id: 'doc1' })

  const custom = cfg('custom', { custom: { url: 'https://h.example/api', header: 'X-Key', body: '{"input": "{{text}}", "mode": "fast"}', result: 'data.out.0' } })
  const req = requestFor(custom, 'k', 'Say "hi"\nplease')
  assert.equal(req.headers['X-Key'], 'k')
  assert.deepEqual(JSON.parse(req.body), { input: 'Say "hi"\nplease', mode: 'fast' })
  assert.deepEqual(resultOf(custom, { data: { out: ['rewritten'] } }), { text: 'rewritten' })
  assert.deepEqual(JSON.parse(requestFor(custom, 'k', "It's $5 or $$, see $' and $&").body).input, "It's $5 or $$, see $' and $&")
})

test('failures read as plain reasons', () => {
  assert.equal(errorOf('emulate', 402, { error: { code: 'out_of_words', message: 'No words left' } }), 'out of words')
  assert.equal(errorOf('emulate', 403, { error: { code: 'plan_required' } }), "your plan doesn't include the API")
  assert.equal(errorOf('writehuman', 401, {}), 'bad API key')
  assert.equal(errorOf('undetectable', 400, { error: 'Insufficient credits' }), 'out of credits')
  assert.equal(errorOf('stealthgpt', 503, {}), 'the service is having problems')
})
