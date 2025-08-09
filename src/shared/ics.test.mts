import assert from 'node:assert/strict'
import { test } from 'node:test'
import { icsEvents } from './ics.ts'

// Outlook's shape: a Windows zone name with its VTIMEZONE, a weekly meeting with one week skipped and one moved.
const FEED = `BEGIN:VCALENDAR
VERSION:2.0
X-WR-CALNAME:me@example.com
BEGIN:VTIMEZONE
TZID:Eastern Standard Time
BEGIN:STANDARD
DTSTART:16011104T020000
RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010311T020000
RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:weekly
SUMMARY:Design sync
DTSTART;TZID=Eastern Standard Time:20260105T100000
DTEND;TZID=Eastern Standard Time:20260105T103000
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;TZID=Eastern Standard Time:20261005T100000
ORGANIZER;CN=Ana Ruiz:mailto:ana@example.com
ATTENDEE;CN=Me:mailto:ME@example.com
ATTENDEE;CN=Bo Chen:mailto:bo@example.com
END:VEVENT
BEGIN:VEVENT
UID:weekly
RECURRENCE-ID;TZID=Eastern Standard Time:20261012T100000
SUMMARY:Design sync (moved)
DTSTART;TZID=Eastern Standard Time:20261012T140000
DTEND;TZID=Eastern Standard Time:20261012T143000
ATTENDEE;CN=Bo Chen:mailto:bo@example.com
END:VEVENT
BEGIN:VEVENT
UID:holiday
SUMMARY:Holiday
DTSTART;VALUE=DATE:20261012
DTEND;VALUE=DATE:20261013
END:VEVENT
END:VCALENDAR`.replace(/\n/g, '\r\n')

const day = (iso: string) => [Date.parse(`${iso}T00:00:00Z`), Date.parse(`${iso}T23:59:59Z`)] as const

test('ics: repeats land in their own time zone, skipped and moved weeks included, the owner flagged', () => {
  const [from, to] = day('2026-09-28')
  const [sep] = icsEvents(FEED, from, to)
  assert.equal(sep.title, 'Design sync')
  assert.equal(new Date(sep.start).toISOString(), '2026-09-28T14:00:00.000Z') // 10:00 EDT
  assert.deepEqual(sep.attendees.map((a) => [a.email, !!a.me]), [['ME@example.com', true], ['bo@example.com', false], ['ana@example.com', false]])

  assert.deepEqual(icsEvents(FEED, ...day('2026-10-05')), []) // EXDATE

  const moved = icsEvents(FEED, ...day('2026-10-12'))
  assert.deepEqual(moved.map((e) => [e.title, !!e.allDay]), [['Design sync (moved)', false], ['Holiday', true]])
  assert.equal(new Date(moved[0].start).toISOString(), '2026-10-12T18:00:00.000Z') // its own time, not the series'

  const nov = icsEvents(FEED, ...day('2026-11-09'))
  assert.equal(new Date(nov[0].start).toISOString(), '2026-11-09T15:00:00.000Z') // 10:00 EST, after the clocks change
})
