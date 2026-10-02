// Noticing a call starting, so Glint can offer to take notes, and the calendar invite for the meeting in progress,
// which name guesses use. No Electron imports: tests run under plain Node.

/**
 * Call apps, by the bundle id of the process using the mic. An id ending in "." matches any id that starts with it;
 * any other matches itself and its helpers ("com.hnc.discord.helper").
 */
const CALL_APPS: [string, string][] = [
  ['us.zoom.', 'Zoom'],
  ['com.microsoft.teams', 'Microsoft Teams'],
  ['com.microsoft.teams2', 'Microsoft Teams'],
  ['cisco-systems.spark', 'Webex'],
  ['com.webex.', 'Webex'],
  ['com.cisco.webexmeetingsapp', 'Webex'],
  ['com.apple.facetime', 'FaceTime'],
  ['com.apple.avconferenced', 'FaceTime'], // FaceTime's calls run in this system process
  ['com.tinyspeck.slackmacgap', 'Slack'],
  ['com.hnc.discord', 'Discord'],
  ['com.skype.', 'Skype'],
  ['com.logmein.', 'GoTo Meeting'],
  ['com.amazon.amazon-chime', 'Amazon Chime'],
  ['com.ringcentral.', 'RingCentral'],
  ['net.whatsapp.whatsapp', 'WhatsApp'],
]

/** Browsers (and WebKit's media process, which Safari's tabs use): a call there is told apart by its window title. */
const BROWSERS = [
  'com.google.chrome', 'company.thebrowser.', 'com.apple.safari', 'com.apple.webkit.gpu', 'org.mozilla.firefox',
  'com.microsoft.edgemac', 'com.brave.browser', 'com.vivaldi.vivaldi', 'com.operasoftware.opera',
]

/**
 * Calls in a browser tab, by the title the tab gives its browser window. Only browsers' windows count: call apps' own
 * windows carry these names too ("Chat | Microsoft Teams", "#general | Friends - Discord") and are found by bundle id.
 * A Slack huddle in a tab leaves the channel's title as it is, so it can't be told apart.
 */
const WEB_CALLS: [RegExp, string][] = [
  [/(^|\s)Meet\s[-–—]\s|Google Meet|meet\.google\.com/i, 'Google Meet'],
  [/Microsoft Teams|teams\.(microsoft|live)\.com/i, 'Microsoft Teams'],
  [/Zoom Meeting|app\.zoom\.us/i, 'Zoom'],
  [/Webex/i, 'Webex'],
  [/\bDiscord\b/, 'Discord'], // capitalised: "discord" is also a word
  [/\bWhereby\b/, 'Whereby'], // capitalised: "whereby" is also a word
  [/Jitsi Meet/i, 'Jitsi'],
]

const matches = (id: string, p: string) => (p.endsWith('.') ? id.startsWith(p) : id === p || id.startsWith(`${p}.`))
const isBrowser = (id: string) => BROWSERS.some((p) => matches(id.toLowerCase(), p))

/** A browser is using the mic: only then are window titles worth reading. */
export const browserHasMic = (micUsers: string[]) => micUsers.some(isBrowser)

/**
 * The calls going on now, each once, by name: `micUsers` are the bundle ids of processes using the mic, `windows` the
 * open windows with the bundle id of the app owning each (read only when a browser has the mic; a call in a tab is
 * told apart by its title).
 */
export function callsNow(micUsers: string[], windows: { app: string; title: string }[]): string[] {
  const found = new Set<string>()
  for (const id of micUsers) for (const [p, name] of CALL_APPS) if (matches(id.toLowerCase(), p)) found.add(name)
  if (browserHasMic(micUsers)) for (const w of windows) if (isBrowser(w.app)) for (const [re, name] of WEB_CALLS) if (re.test(w.title)) found.add(name)
  return [...found]
}

/** One event from the Mac's calendars, as the calendar script reads it. */
export interface CalendarEvent {
  title: string
  start: number
  end: number
  allDay?: boolean
  /** Everyone invited, the user flagged. */
  attendees: { name: string; email: string; me?: boolean }[]
}

/**
 * The invite for a meeting that started at `at`: an event running then (or starting within 10 minutes of it), not all
 * day; with several, the one with people on it that started closest to `at`. null when there's none.
 */
export function pickInvite(events: CalendarEvent[], at: number): CalendarEvent | null {
  const slack = 10 * 60_000
  const now = events.filter((e) => !e.allDay && e.start - slack <= at && at <= e.end)
  if (!now.length) return null
  const score = (e: CalendarEvent) => (e.attendees.some((a) => !a.me) ? 0 : 1e12) + Math.abs(e.start - at)
  return now.reduce((a, b) => (score(b) < score(a) ? b : a))
}

/** The invite as context for a name guess: its title and everyone on it but the user. */
export function inviteContext(e: CalendarEvent | null): string {
  if (!e) return ''
  const people = e.attendees.filter((a) => !a.me).map((a) => (a.name && a.name !== a.email ? `${a.name}${a.email ? ` <${a.email}>` : ''}` : a.email)).filter(Boolean)
  return `<calendar_invite>\nTitle: ${e.title || '(no title)'}\n${people.length ? `Invited besides the user: ${people.join('; ')}` : 'No one else is listed.'}\n</calendar_invite>`
}
