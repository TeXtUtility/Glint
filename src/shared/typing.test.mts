// Ghost's TypingEngineTests, ported, plus Glint's field break and streaming text.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ControlDoubleTap, TypingEngine } from './typing.ts'

const type = (e: TypingEngine, s: string) => [...s].map((c) => e.handle(c)).at(-1)

test('advances on match, waits on mismatch, ignores input after complete', () => {
  const e = new TypingEngine('abc')
  assert.equal(e.handle('a'), 'advanced')
  assert.equal(e.handle('b'), 'advanced')
  assert.equal(e.handle('c'), 'complete')
  assert.equal(e.progress, 1)
  assert.equal(e.handle('d'), 'ignored')
  const m = new TypingEngine('abc')
  assert.equal(m.handle('x'), 'mismatch')
  assert.equal(m.position, 0)
  m.handle('a')
  assert.equal(m.handle('x'), 'mismatch')
  assert.equal(m.position, 1)
})

test('backspace: clamps at zero, undoes the last key first, fixes "uick" typed for "quick"', () => {
  const e = new TypingEngine('ab')
  e.backspace()
  assert.equal(e.position, 0)
  type(e, 'ab')
  e.backspace()
  e.backspace()
  e.backspace()
  assert.equal(e.position, 0)
  const q = new TypingEngine('quick')
  type(q, 'uick')
  assert.deepEqual([q.position, q.pendingMismatches], [0, 4])
  for (let i = 0; i < 4; i++) q.backspace()
  assert.deepEqual([q.position, q.pendingMismatches], [0, 0])
  type(q, 'quick')
  assert.ok(q.isComplete)
  const l = new TypingEngine('ab')
  l.handle('a')
  l.handle('z')
  l.backspace()
  assert.deepEqual([l.position, l.pendingMismatches], [1, 0])
  l.backspace()
  assert.equal(l.position, 0)
})

test('newline needs Return; quotes and dashes match what a keyboard types', () => {
  const e = new TypingEngine('a\nb')
  e.handle('a')
  assert.equal(e.handle('x'), 'mismatch')
  assert.equal(e.handle('\n'), 'advanced')
  assert.equal(e.handle('b'), 'complete')
  assert.equal(type(new TypingEngine('it’s “ok” — fine'), 'it\'s "ok" - fine'), 'complete')
})

test('word skip and back', () => {
  const e = new TypingEngine('foo bar  baz')
  e.nextWord()
  assert.equal(e.position, 4)
  e.nextWord()
  assert.equal(e.position, 9)
  const m = new TypingEngine('hello world')
  type(m, 'he')
  m.nextWord()
  assert.equal(m.position, 6)
  const p = new TypingEngine('hello world')
  type(p, 'hello wo')
  p.prevWord()
  assert.equal(p.position, 6)
  p.prevWord()
  assert.equal(p.position, 0)
  const j = new TypingEngine('hi world')
  type(j, 'hi')
  j.nextWord()
  const at = j.position
  j.backspace()
  assert.equal(j.position, at - 1) // history cleared by the skip
})

test('word resync: jumps to a later word, case-insensitive, forward only, not far ahead', () => {
  const e = new TypingEngine('the quick brown fox jumps')
  type(e, 'the fox ')
  assert.equal(e.position, 20)
  assert.equal(type(e, 'jumps'), 'complete')
  const n = new TypingEngine('the cat sat')
  type(n, 'xyz ')
  assert.deepEqual([n.position, n.pendingMismatches], [0, 4])
  const c = new TypingEngine('the QUICK fox')
  type(c, 'the fox ')
  assert.ok(c.isComplete)
  const f = new TypingEngine('fox a fox b cat')
  type(f, 'fox ')
  type(f, 'fox ')
  assert.deepEqual([f.position, f.pendingMismatches], [10, 0])
  const far = new TypingEngine(`the cat ${'x '.repeat(200)}the dog ran`)
  type(far, 'the dog ')
  assert.equal(far.position, 4)
})

test('fuzzy resync: swapped and added words, never on correct typing, not far ahead', () => {
  const s = new TypingEngine('he ran happily there')
  type(s, 'he ran quickly there')
  assert.ok(s.isComplete)
  const a = new TypingEngine('he walked there')
  type(a, 'he walked happily there')
  assert.ok(a.isComplete)
  const r = new TypingEngine('abc abc abc')
  type(r, 'abc abc abc')
  assert.equal(r.position, 11)
  const g = new TypingEngine('the red cat saw the green dog yesterday')
  type(g, 'the red blue green dog')
  assert.ok(g.position >= 29)
  const far = new TypingEngine(`hello world ${'abcd '.repeat(100)}goodbye world`)
  type(far, 'hello earth world')
  assert.ok(far.position < 100)
  // A slip corrected with backspace doesn't count toward the next one.
  const b = new TypingEngine('the cat sat on the mat')
  type(b, 'the x')
  b.backspace()
  type(b, 'm')
  assert.equal(b.position, 4)
})

test('field break: Tab, or clicking into the next field and typing its answer', () => {
  const e = new TypingEngine('Ezra\tKruger')
  type(e, 'Ezra')
  assert.equal(e.handle('K'), 'advanced') // clicked into the next field
  assert.equal(type(e, 'ruger'), 'complete')
  const t = new TypingEngine('Ezra\tKruger')
  assert.equal(type(t, 'Ezra\tKruger'), 'complete')
  const w = new TypingEngine('Ezra\tKruger')
  type(w, 'Ezra')
  assert.equal(w.handle('x'), 'mismatch') // neither Tab nor the next answer
})

test('streaming text keeps the place; different text starts over', () => {
  const e = new TypingEngine('Hello')
  type(e, 'Hel')
  e.setText('Hello there')
  assert.equal(e.position, 3)
  e.setText('Different')
  assert.equal(e.position, 0)
})

test('long answers: typing and forgiving cost the same at any length', () => {
  const para = 'Whenever I catch myself doing the same task a third time, I start wondering how to make it disappear. '
  const text = para.repeat(200) // about 20,000 characters
  const e = new TypingEngine(text)
  const t = performance.now()
  for (let i = 0; i < 40; i++) {
    type(e, para.replace('same', 'very same').replace('task', 'tsak')) // an added word and a typo in every paragraph
  }
  const ms = performance.now() - t
  assert.ok(e.position >= para.length * 39, `kept up: at ${e.position}`)
  assert.ok(ms < 2000, `took ${Math.round(ms)} ms`) // ~35 ms normally; loose so a busy Mac (the installer runs this) doesn't fail it
  // Streaming 20,000 characters in small pieces keeps the place.
  const s = new TypingEngine('')
  for (let i = 0; i < text.length; i += 7) s.setText(text.slice(0, i + 7))
  assert.equal(s.total, text.length)
})

test('double-tap Control: two quick clean taps toggle; chords, slow presses and long gaps never do', () => {
  const tap = (d: ControlDoubleTap, at: number, held = 80, others = false) => (d.flags(true, others, at), d.flags(false, false, at + held))
  let d = new ControlDoubleTap()
  assert.equal(tap(d, 0), false)
  assert.equal(tap(d, 200), true)
  assert.equal(tap(d, 400), false, 'a third tap starts over')
  d = new ControlDoubleTap()
  tap(d, 0)
  assert.equal(tap(d, 600), false, 'too far apart')
  d = new ControlDoubleTap()
  tap(d, 0)
  assert.equal(tap(d, 200, 300), false, 'held too long')
  d = new ControlDoubleTap()
  tap(d, 0)
  d.flags(true, false, 200)
  d.key() // ⌃C
  assert.equal(d.flags(false, false, 260), false, 'a chord is not a tap')
  d = new ControlDoubleTap()
  tap(d, 0)
  assert.equal(tap(d, 200, 80, true), false, 'with ⌥ or ⌘ held it is a chord')
})

test('auto-skip off: no resync, no skipped field break; only word navigation moves past text', () => {
  const e = new TypingEngine('the quick brown fox jumps\tover')
  e.autoSkip = false
  type(e, 'the brown ')
  assert.equal(e.position, 4, 'a later word typed does not jump to it')
  assert.equal(e.pendingMismatches, 6)
  for (let i = 0; i < 6; i++) e.backspace()
  type(e, 'qx fox')
  assert.equal(e.position, 5, 'wrong keys wait for a backspace, never search ahead')
  for (let i = 0; i < 5; i++) e.backspace()
  e.nextWord()
  e.nextWord()
  assert.equal(e.chars.slice(e.position).join(''), 'fox jumps\tover')
  type(e, 'fox jumps')
  assert.equal(type(e, 'o'), 'mismatch', 'typing the next field without Tab does not skip the break')
  e.backspace()
  assert.equal(type(e, '\t'), 'advanced')
})
