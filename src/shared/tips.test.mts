import assert from 'node:assert/strict'
import { test } from 'node:test'
import { placeOnCapsule } from './state.ts'
import { CHECKLIST, checklistLeft, tipAtStart } from './tips.ts'

test('tipAtStart: ask first, Glance on the second call, files on the third, each once, none when hidden or before setup', () => {
  const firsts = { setup: 1 }
  const at = (calls: number, f: Record<string, number> = firsts, more = {}) => tipAtStart({ calls, firsts: f, modeHasFiles: false, callApp: true, ...more })
  assert.equal(at(0), 'ask')
  assert.equal(at(1), 'glance')
  assert.equal(at(2, { ...firsts, 'tip:glance': 2 }), 'files')
  assert.equal(at(2, { ...firsts, 'tip:glance': 2 }, { modeHasFiles: true }), null)
  assert.equal(at(1, { ...firsts, 'tip:glance': 2 }, { callApp: false }), 'room')
  assert.equal(at(0, {}), null)
  assert.equal(at(0, { ...firsts, hidden: 5 }), null)
  assert.equal(at(0, { ...firsts, hidden: 0 }), 'ask') // brought back
})

test('checklistLeft: only after the new setup, until done or hidden', () => {
  assert.deepEqual(checklistLeft({}), [])
  assert.equal(checklistLeft({ setup: 1 }).length, CHECKLIST.length - 1)
  assert.deepEqual(checklistLeft({ setup: 1, hidden: 2 }), [])
  assert.deepEqual(checklistLeft(Object.fromEntries(CHECKLIST.map((c) => [c.id, 1]))), [])
})

test('placeOnCapsule: in default order, after what comes before it', () => {
  assert.deepEqual(placeOnCapsule(['activity', 'session', 'chat', 'ask'], 'room'), ['activity', 'room', 'session', 'chat', 'ask'])
  assert.deepEqual(placeOnCapsule(['activity', 'mode', 'session', 'ask'], 'labels'), ['activity', 'mode', 'labels', 'session', 'ask'])
  assert.deepEqual(placeOnCapsule(['ask', 'activity'], 'labels'), ['labels', 'ask', 'activity']) // a custom order: before the first that follows it
  assert.deepEqual(placeOnCapsule(['room'], 'room'), ['room'])
})
