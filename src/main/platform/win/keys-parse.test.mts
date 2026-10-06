import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseWinKey } from './keys-parse.ts'

const none = { ctrl: false, alt: false, win: false, altGr: false }

test('parseWinKey: typing is text, editing keys are what they do, shortcuts are nothing', () => {
  assert.deepEqual(parseWinKey(0x41, none, 'a'), { type: 'text', text: 'a' })
  assert.deepEqual(parseWinKey(0x08, none, '\b'), { type: 'backspace' })
  assert.deepEqual(parseWinKey(0x2e, none, ''), { type: 'backspace' })
  assert.deepEqual(parseWinKey(0x0d, none, '\r'), { type: 'text', text: '\n' })
  assert.deepEqual(parseWinKey(0x09, none, '\t'), { type: 'text', text: '\t' })
  assert.equal(parseWinKey(0x43, { ...none, ctrl: true }, String.fromCharCode(3)), null)
  assert.equal(parseWinKey(0x46, { ...none, alt: true }, 'f'), null)
  assert.equal(parseWinKey(0x45, { ...none, win: true }, 'e'), null)
  assert.equal(parseWinKey(0x25, none, ''), null) // an arrow
  // AltGr is Ctrl and Right Alt together, and types: @ on a German keyboard.
  assert.deepEqual(parseWinKey(0x51, { ctrl: true, alt: true, win: false, altGr: true }, '@'), { type: 'text', text: '@' })
})
