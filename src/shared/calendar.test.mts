import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionsToIcs } from './calendar.ts'

const now = new Date(Date.UTC(2026, 8, 26, 12, 0, 0))

test('actionsToIcs: all-day and timed events, undated items left out, text escaped', () => {
  const ics = actionsToIcs([
    { id: 'a', text: 'Send the deck, v2; final', owner: 'Dana', due: '2026-10-02' },
    { id: 'b', text: 'Book the room', owner: 'Me', due: '2026-12-31', time: '23:45' },
    { id: 'c', text: 'Think about pricing' },
  ], 'Q3 launch', now)
  const lines = ics.split('\r\n')
  assert.ok(ics.endsWith('\r\n') && lines[0] === 'BEGIN:VCALENDAR')
  assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 2)
  assert.ok(lines.includes('DTSTART;VALUE=DATE:20261002') && lines.includes('DTEND;VALUE=DATE:20261003'))
  assert.ok(lines.includes('SUMMARY:Dana: Send the deck\\, v2\\; final'))
  assert.ok(lines.includes('DTSTART:20261231T234500') && lines.includes('DTEND:20270101T001500')) // crosses midnight and the year
  assert.ok(lines.includes('SUMMARY:Book the room')) // the user's own item isn't prefixed
  assert.ok(lines.includes('UID:a@glint') && lines.includes('DTSTAMP:20260926T120000Z'))
})

test('actionsToIcs: long lines fold at 75 bytes without splitting a character', () => {
  const ics = actionsToIcs([{ id: 'x', text: 'é'.repeat(100), due: '2026-10-02' }], 'm', now)
  const physical = ics.split('\r\n')
  assert.ok(physical.every((l) => new TextEncoder().encode(l).length <= 75))
  assert.ok(ics.replace(/\r\n /g, '').includes(`SUMMARY:${'é'.repeat(100)}`))
})
