import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autoAsk, REFERENCE_PROMPT, REFERENCE_SEARCH_PROMPT, systemPrompt, userPrompt } from './prompt.ts'
import { buildIndex, PASSAGES_MAX_CHARS, search, searchQuery, splitPieces, stem } from './search.ts'
import { MODE_FILES_WHOLE_CHARS, searchesFiles } from './state.ts'

// Filler prose that never mentions the planted facts: a fixed vocabulary, so runs are repeatable.
const VOCAB = 'harbour morning ledger window market silver quiet orchard lantern river winter garden letter station bridge candle meadow village copper'.split(' ')
function filler(chars: number, seed = 1): string {
  let x = seed
  const next = () => (x = (x * 1103515245 + 12345) % 2 ** 31)
  const paras: string[] = []
  let n = 0
  while (n < chars) {
    const words = Array.from({ length: 60 + (next() % 60) }, () => VOCAB[next() % VOCAB.length])
    const para = `${words.join(' ')}.`
    paras.push(para)
    n += para.length + 2
  }
  return paras.join('\n\n')
}

test('searchesFiles: whole up to the limit, searched past it', () => {
  const at = (chars: number) => ({ files: [{ id: 'a', name: 'a.txt', chars }] })
  assert.equal(searchesFiles(at(MODE_FILES_WHOLE_CHARS)), false)
  assert.equal(searchesFiles(at(MODE_FILES_WHOLE_CHARS + 1)), true)
  assert.equal(searchesFiles(undefined), false)
})

test('the prompt says passages, not whole files, for a searched mode', () => {
  const big = { name: 'Book', prompt: '', files: [{ id: 'a', name: 'a.txt', chars: MODE_FILES_WHOLE_CHARS + 1 }] }
  const small = { name: 'Book', prompt: '', files: [{ id: 'a', name: 'a.txt', chars: 10 }] }
  assert.ok(systemPrompt(big).includes(REFERENCE_SEARCH_PROMPT) && !systemPrompt(big).includes(REFERENCE_PROMPT))
  assert.ok(systemPrompt(small).includes(REFERENCE_PROMPT) && !systemPrompt(small).includes(REFERENCE_SEARCH_PROMPT))
  // The passages lead the new turn, ahead of the transcript and the question.
  const turn = userPrompt({ text: 'What is it?', transcript: [{ role: 'them', text: 'hello' }], hasSession: true, reference: '<reference_passages>x</reference_passages>' })
  assert.ok(turn.startsWith('<reference_passages>x</reference_passages>') && turn.indexOf('<transcript>') > 0)
})

test('a fact planted once in a 5M-character file is found, and what is sent stays within budget', () => {
  const text = filler(2_500_000) + '\n\nThe vault combination is kept by Marisol Quenby in the brass tin under the stairs.\n\n' + filler(2_500_000, 7)
  const index = buildIndex([{ name: 'big.txt', text }])
  const found = search(index, 'Who keeps the vault combination?')
  assert.ok(found)
  assert.ok(found.text.includes('Marisol Quenby'))
  assert.ok(found.text.length <= PASSAGES_MAX_CHARS + 2000) // the budget, plus the file tags and […] joins
})

test('passages come in reading order, with no piece twice, the neighbours of a match, and […] between gaps', () => {
  const paras = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: ${filler(900, i + 3)}`)
  paras[10] = 'Paragraph 10: the quartermaster counted forty barrels.'
  paras[30] = 'Paragraph 30: the quartermaster signed the manifest.'
  const found = search(buildIndex([{ name: 'log.txt', text: paras.join('\n\n') }]), 'quartermaster')!
  const seen = [...found.text.matchAll(/Paragraph (\d+):/g)].map((m) => Number(m[1]))
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b))
  assert.equal(new Set(seen).size, seen.length)
  for (const n of [9, 10, 11, 29, 30, 31]) assert.ok(seen.includes(n), `paragraph ${n}`)
  assert.ok(found.text.includes('[…]'))
})

test('a PDF passage carries its page, even when it doesn\'t start the page', () => {
  const page = (n: number, body: string) => `[page ${n}]\n${body}`
  const text = [page(1, filler(1500, 2)), page(2, `${filler(1300, 4)}\n\nThe treaty was signed at Lindenfeld on a Tuesday.`), page(3, filler(1500, 5))].join('\n\n')
  const pieces = splitPieces(text)
  assert.ok(pieces.every((p) => p.page))
  const found = search(buildIndex([{ name: 'history.pdf', text }]), 'Where was the treaty signed?')!
  assert.ok(/\[page 2\][^[]*Lindenfeld/.test(found.text))
  assert.ok(found.pages.includes('2'))
})

test('files are grouped by name; nothing matching gives null', () => {
  const index = buildIndex([{ name: 'a.txt', text: 'The lighthouse keeper is named Orrin.' }, { name: 'b.txt', text: 'Orrin also keeps bees.' }])
  const found = search(index, 'Orrin')!
  assert.ok(found.text.includes('<file name="a.txt">') && found.text.includes('<file name="b.txt">'))
  assert.equal(search(index, 'zeppelin'), null)
})

test('searchQuery: the question; a retry\'s original; the latest lines with nothing typed; nothing outside a session', () => {
  const base = { hasSession: false }
  assert.equal(searchQuery({ ...base, text: 'What does clause 4 say?' }, []), 'What does clause 4 say?')
  assert.equal(searchQuery({ ...base, text: '', repeat: 'Explain this slide' }, []), 'Explain this slide')
  assert.equal(searchQuery({ ...base, text: 'try again', repeat: 'What does clause 4 say?' }, []), 'What does clause 4 say?')
  const lines = [...Array.from({ length: 9 }, (_, i) => ({ text: `line ${i}` })), { text: undefined }]
  assert.equal(searchQuery({ ...base, text: '', hasSession: true }, lines), 'line 3\nline 4\nline 5\nline 6\nline 7\nline 8')
  assert.equal(searchQuery({ ...base, text: '' }, []), null)
})

test('light stemming: a question worded differently from the text still finds it', () => {
  assert.deepEqual(['picks', 'picked', 'picking', 'studies', "captain's", 'glass', 'was'].map(stem), ['pick', 'pick', 'pick', 'study', 'captain', 'glass', 'was'])
  for (const forms of [['price', 'prices', 'priced', 'pricing'], ['file', 'files'], ['box', 'boxes'], ['match', 'matches']]) {
    assert.equal(new Set(forms.map(stem)).size, 1, forms.join(' '))
  }
  assert.ok(search(buildIndex([{ name: 'a.txt', text: 'The prices for the plan are listed here.' }]), 'what is the price'))
  // The benchmark's one miss: "picks up" against "picked me up".
  const text = `${filler(20_000, 9)}\n\nA sail drew near, and picked me up at last. It was the Hesper.\n\n${filler(20_000, 11)}`
  assert.ok(search(buildIndex([{ name: 'book.txt', text }]), 'Which ship picks up the narrator?')!.text.includes('Hesper'))
})

test('audit fixes: sentences of a long paragraph stay one paragraph; pages only within one file; queries', () => {
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} of one long paragraph.`).join(' ')
  const pieces = splitPieces(long)
  assert.ok(pieces.length > 1 && pieces.every((p) => !p.text.includes('\n\n')))
  const index = buildIndex([{ name: 'a.pdf', text: '[page 3]\nThe comet returns in spring.' }, { name: 'b.pdf', text: '[page 210]\nThe comet was named for its finder.' }])
  assert.deepEqual(search(index, 'comet')!.pages, [])
  assert.deepEqual(search(buildIndex([{ name: 'a.pdf', text: '[page 3]\nThe comet returns.\n\n[page 4]\nThe comet fades.' }]), 'comet')!.pages, ['3', '4'])
  const base = { hasSession: false }
  assert.equal(searchQuery({ ...base, text: 'try again' }, []), null)
  assert.equal(searchQuery({ ...base, text: autoAsk('When is the deadline?'), hasSession: true }, []), 'When is the deadline?')
})

test('weak matches past the best few are left out instead of filling the budget', () => {
  const filler = Array.from({ length: 400 }, (_, i) => `Entry ${i}: the plan for the week covers shipping, stock and the team rota in some detail.`)
  filler.splice(200, 0, 'Orrin keeps the vault combination in the ledger behind the counter.')
  const found = search(buildIndex([{ name: 'log.txt', text: filler.join('\n\n') }]), 'Who keeps the vault combination for the plan?')!
  assert.ok(found.text.includes('Orrin keeps the vault combination'))
  assert.ok(found.text.length < 20_000, `sent ${found.text.length} characters`)
})
