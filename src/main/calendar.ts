// The Mac's calendars (EventKit, through a JavaScript for Automation script, as files.ts reads PDFs): only to find the
// invite for the meeting a session is in, so a name guess can match people to it. Read only; nothing is kept on disk.
import { execFile } from 'node:child_process'
import { pickInvite, type CalendarEvent } from '../shared/meetings'

export type CalendarAccess = 'granted' | 'denied' | 'ask'

const SCRIPT = `ObjC.import('EventKit')
function run(argv) {
  const status = $.EKEventStore.authorizationStatusForEntityType(0) // EKEntityTypeEvent
  // 3: full access. 0: not asked yet. 1, 2 and 4 (restricted, denied, add only): no reading.
  const access = status === 3 ? 'granted' : status === 0 ? 'ask' : 'denied'
  if (argv[0] === 'status') return access
  const store = $.EKEventStore.alloc.init
  if (argv[0] === 'request') {
    if (access !== 'ask') return access
    let done = false
    let ok = false
    const answer = (granted) => ((ok = granted), (done = true))
    if (store.respondsToSelector('requestFullAccessToEventsWithCompletion:')) store.requestFullAccessToEventsWithCompletion(answer)
    else store.requestAccessToEntityTypeCompletion(0, answer)
    const until = Date.now() + 120000
    while (!done && Date.now() < until) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2))
    return ok ? 'granted' : 'denied'
  }
  if (access !== 'granted') return '[]'
  const at = Number(argv[1])
  const date = (ms) => $.NSDate.dateWithTimeIntervalSince1970(ms / 1000)
  const events = store.eventsMatchingPredicate(store.predicateForEventsWithStartDateEndDateCalendars(date(at - 6 * 3600e3), date(at + 3600e3), $()))
  const str = (v) => (v && !v.isNil() ? ObjC.unwrap(v) : '') || ''
  const out = []
  for (let i = 0; i < events.count; i++) {
    const e = events.objectAtIndex(i)
    const attendees = []
    const list = e.attendees
    if (list && !list.isNil()) for (let j = 0; j < list.count; j++) {
      const p = list.objectAtIndex(j)
      const email = str(p.URL.resourceSpecifier).replace(/^\\/\\//, '')
      attendees.push({ name: str(p.name), email: email.includes('@') ? email : '', me: !!p.isCurrentUser })
    }
    out.push({ title: str(e.title), start: e.startDate.timeIntervalSince1970 * 1000, end: e.endDate.timeIntervalSince1970 * 1000, allDay: !!e.allDay, attendees })
  }
  return JSON.stringify(out)
}`

function script(args: string[], timeout: number): Promise<string> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('calendars are read on macOS only'))
  return new Promise((resolve, reject) =>
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, ...args], { timeout }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))),
  )
}

const asAccess = (v: string): CalendarAccess => (v === 'granted' || v === 'ask' ? v : 'denied')

/** Whether Glint may read the calendars; never shows a prompt. */
export const calendarAccess = () => script(['status'], 10_000).then(asAccess, () => 'denied' as const)

/** macOS's calendar prompt, the first time; after that, the answer given. */
export const requestCalendar = () => script(['request'], 130_000).then(asAccess, () => 'denied' as const)

const invites = new Map<string, CalendarEvent | null>()

/**
 * The invite for a session that started at `startedAt`, looked up once per session. Asks for access the first time
 * (the user pressed Guess); denied or unreadable, there's no invite and the guess goes on from the transcript alone.
 */
export async function inviteFor(sessionId: string, startedAt: number): Promise<CalendarEvent | null> {
  if (invites.has(sessionId)) return invites.get(sessionId)!
  if ((await requestCalendar()) !== 'granted') return null // asked again next time, in case it's allowed by then
  let invite: CalendarEvent | null = null
  try {
    invite = pickInvite(JSON.parse(await script(['events', String(startedAt)], 20_000)) as CalendarEvent[], startedAt)
  } catch (err) {
    console.warn('[calendar] could not read events:', (err as Error).message)
  }
  invites.set(sessionId, invite)
  return invite
}
