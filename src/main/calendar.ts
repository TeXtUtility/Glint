// Finds the calendar invite for the meeting a session is in, so a name guess can match people to it. Read only;
// nothing is kept on disk. Two sources, either or both: the calendars the OS lets Glint read (Calendar on a Mac,
// classic Outlook on Windows), and a calendar's private iCal link, for the ones the OS can't (new Outlook, Google).
import { net } from 'electron'
import { pickInvite, type CalendarEvent } from '../shared/meetings'
import { getKey, setKey, statusOf } from './ai'
import { platform } from './platform'

const invites = new Map<string, CalendarEvent | null>()
const HOUR = 3_600_000
/** A feed holds every event the calendar has ever had: a few MB, rarely more. */
const FEED_MAX_BYTES = 50_000_000

/**
 * The invite for a session that started at `startedAt`, looked up once per session. Asks for the OS's access the
 * first time (the user pressed Guess), unless a link is saved; with neither readable there's no invite, and the guess
 * goes on from the transcript alone.
 */
export async function inviteFor(sessionId: string, startedAt: number): Promise<CalendarEvent | null> {
  if (invites.has(sessionId)) return invites.get(sessionId)!
  const link = statusOf('calendar') === 'saved'
  const cal = platform.calendar
  const os = (await (link ? cal.access() : cal.request())) === 'granted'
  if (!os && !link) return null // asked again next time, in case it's allowed by then
  const read = (events: Promise<CalendarEvent[]>, from: string) =>
    events.catch((err: Error) => (console.warn(`[calendar] could not read ${from}:`, err.message), []))
  const events = await Promise.all([os ? read(cal.events(startedAt), 'events') : [], link ? read(readFeed(getKey('calendar')!, startedAt - 6 * HOUR, startedAt + HOUR), 'the calendar link') : []])
  const invite = pickInvite(events.flat(), startedAt)
  invites.set(sessionId, invite)
  return invite
}

/** Reads the link once before saving it, so a wrong one is caught now. Resolves with how many events it read. */
export async function saveLink(raw: string | null): Promise<number> {
  const url = raw?.trim() ?? ''
  if (!url) return (setKey('calendar', null), invites.clear(), 0)
  const events = await readFeed(url, Date.now() - 7 * 24 * HOUR, Date.now() + 7 * 24 * HOUR)
  setKey('calendar', url)
  invites.clear()
  return events.length
}

async function readFeed(raw: string, from: number, to: number): Promise<CalendarEvent[]> {
  const url = raw.replace(/^webcal:/i, 'https:') // calendars hand out webcal:// for the same address
  if (!/^https:\/\/\S+$/i.test(url) || url.length > 2000) throw new Error('That isn\'t a calendar link: it starts with https:// or webcal://.')
  const res = await net.fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`The calendar link answered ${res.status}${res.status === 404 || res.status === 401 ? ': it may have been reset' : ''}.`)
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of res.body ?? []) {
    if ((size += chunk.length) > FEED_MAX_BYTES) throw new Error('The calendar is too big to read.')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('That link isn\'t an iCal calendar. Copy the address marked iCal or ICS.')
  const { icsEvents } = await import('../shared/ics') // ical.js is only needed here
  return icsEvents(text, from, to)
}
