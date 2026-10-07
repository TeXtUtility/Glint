import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseEvents } from './calendar.ts'

test("parseEvents: Outlook's events as invites, whether PowerShell wrote one or many, and junk left out", () => {
  const meeting = { title: 'Weekly sync', start: 1_760_000_000_000, end: 1_760_001_800_000, allDay: false, attendees: [{ name: 'Sam Lee', email: 'sam@example.com', me: false }, { name: 'Me', email: 'me@example.com', me: true }] }
  assert.deepEqual(parseEvents(JSON.stringify([meeting])), [meeting])
  // A lone attendee may come out as an object rather than a one-item list.
  const one = parseEvents(JSON.stringify({ ...meeting, attendees: { name: 'Sam Lee', email: '', me: false } }))
  assert.deepEqual(one[0].attendees, [{ name: 'Sam Lee', email: '', me: false }])
  assert.deepEqual(parseEvents('[]'), [])
  assert.deepEqual(parseEvents(''), [])
  assert.deepEqual(parseEvents(JSON.stringify([{ title: 'no times' }, null, meeting])), [meeting])
})
