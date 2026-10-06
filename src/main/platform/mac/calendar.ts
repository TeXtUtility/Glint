// The Mac's calendars (EventKit, through a JavaScript for Automation script, as files.ts reads PDFs). Read only.
import { execFile } from 'node:child_process'
import type { CalendarEvent } from '../../../shared/meetings'
import type { CalendarAccess } from '../types'

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
  return new Promise((resolve, reject) =>
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, ...args], { timeout }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))),
  )
}

const asAccess = (v: string): CalendarAccess => (v === 'granted' || v === 'ask' ? v : 'denied')

export const access = () => script(['status'], 10_000).then(asAccess, () => 'denied' as const)

export const request = () => script(['request'], 130_000).then(asAccess, () => 'denied' as const)

export const events = async (at: number) => JSON.parse(await script(['events', String(at)], 20_000)) as CalendarEvent[]
