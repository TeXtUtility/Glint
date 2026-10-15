// A calendar's private iCal feed (Google, Outlook.com, new Outlook, iCloud: each offers a secret address) read into the
// events Guess picks the invite from. ical.js does the hard parts: repeating meetings, moved or cancelled ones, and
// Outlook's own time zone names.
import ICAL from 'ical.js'
import type { CalendarEvent } from './meetings.ts'

/** Occurrences walked per repeating event: a daily meeting since 2010 is under 6,000. */
const MAX_STEPS = 10_000
const MAX_TOTAL_STEPS = 100_000

const email = (v: unknown) => String(v ?? '').replace(/^mailto:/i, '').trim()

/** Events overlapping `from`–`to` (ms), each repeat of a repeating one on its own. */
export function icsEvents(text: string, from: number, to: number): CalendarEvent[] {
  const cal = new ICAL.Component(ICAL.parse(text))
  for (const tz of cal.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz)
  // Google names a person's main calendar after their address; others give no owner, and nobody is flagged.
  const name = String(cal.getFirstPropertyValue('x-wr-calname') ?? '')
  const owner = /^[^@\s]+@[^@\s]+$/.test(name) ? name.toLowerCase() : ''

  const vevents = cal.getAllSubcomponents('vevent')
  // A moved or changed occurrence comes as its own VEVENT with the series' UID and a RECURRENCE-ID.
  const series = new Map<string, InstanceType<typeof ICAL.Event>>()
  for (const v of vevents) if (!v.hasProperty('recurrence-id')) series.set(String(v.getFirstPropertyValue('uid')), new ICAL.Event(v))
  for (const v of vevents) if (v.hasProperty('recurrence-id')) series.get(String(v.getFirstPropertyValue('uid')))?.relateException(v)

  const out: CalendarEvent[] = []
  const add = (e: InstanceType<typeof ICAL.Event>, start: InstanceType<typeof ICAL.Time>, end: InstanceType<typeof ICAL.Time>) => {
    const s = start.toJSDate().getTime()
    const en = end.toJSDate().getTime()
    if (s > to || en < from || String(e.component.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') return
    const people = [...e.component.getAllProperties('attendee'), ...e.component.getAllProperties('organizer')].map((p) => ({
      name: String(p.getParameter('cn') ?? ''),
      email: email(p.getFirstValue()),
    }))
    const attendees = [...new Map(people.filter((a) => a.email || a.name).map((a) => [a.email || a.name, a])).values()]
      .map((a) => (owner && a.email.toLowerCase() === owner ? { ...a, me: true } : a))
    out.push({ title: e.summary ?? '', start: s, end: en, ...(start.isDate && { allDay: true }), attendees })
  }

  let steps = 0
  for (const e of series.values()) {
    if (!e.startDate) continue
    if (!e.isRecurring()) {
      add(e, e.startDate, e.endDate ?? e.startDate)
      continue
    }
    const it = e.iterator()
    for (let i = 0, next = it.next(); next && i < MAX_STEPS && steps++ < MAX_TOTAL_STEPS; i++, next = it.next()) {
      if (next.toJSDate().getTime() > to) break
      const o = e.getOccurrenceDetails(next)
      add(o.item, o.startDate, o.endDate)
    }
  }
  return out
}
