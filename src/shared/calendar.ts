// Action items as an iCalendar (.ics) file, which Calendar and every other calendar app can import.
import type { ActionItem } from './history.ts'

const escape = (text: string) => text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
/** Calendar dates and times are computed in UTC and written without a zone: local time, as said in the meeting. */
const at = (date: string, time = '00:00') => {
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, h, mi))
}
const day = (t: Date) => t.toISOString().slice(0, 10).replace(/-/g, '') // 20261002
const local = (t: Date) => `${t.toISOString().slice(0, 16).replace(/[-:]/g, '')}00` // 20261002T150000
const stamp = (t: Date) => `${t.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`

/** Lines longer than 75 bytes continue on the next line after a space (RFC 5545 §3.1), split between characters. */
function fold(line: string): string {
  const parts: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length
    if (bytes + n > (parts.length ? 74 : 75)) {
      parts.push(cur)
      cur = ''
      bytes = 0
    }
    cur += ch
    bytes += n
  }
  return [...parts, cur].join('\r\n ')
}

/**
 * One event per dated item: all day on its date, or 30 minutes from its time. The UID is the item's id, so adding
 * the same item again updates its event instead of making a second one.
 */
export function actionsToIcs(items: ActionItem[], meeting: string, now: Date): string {
  const events = items.filter((a) => a.due).flatMap((a) => {
    const start = at(a.due!, a.time)
    const when = a.time
      ? [`DTSTART:${local(start)}`, `DTEND:${local(new Date(start.getTime() + 30 * 60_000))}`]
      : [`DTSTART;VALUE=DATE:${day(start)}`, `DTEND;VALUE=DATE:${day(new Date(start.getTime() + 86_400_000))}`]
    const title = a.owner && a.owner !== 'Me' ? `${a.owner}: ${a.text}` : a.text
    return ['BEGIN:VEVENT', `UID:${a.id}@glint`, `DTSTAMP:${stamp(now)}`, ...when, `SUMMARY:${escape(title)}`, `DESCRIPTION:${escape(`From "${meeting}"`)}`, 'END:VEVENT']
  })
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Glint//Meeting notes//EN', 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR']
  return `${lines.map(fold).join('\r\n')}\r\n`
}
