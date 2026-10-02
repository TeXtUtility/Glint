import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserHasMic, callsNow, inviteContext, pickInvite, type CalendarEvent } from './meetings.ts'
import { nameGuessContext } from './prompt.ts'

/** An open window: its title and the app owning it, Chrome unless said. */
const win = (title: string, app = 'com.google.Chrome') => ({ app, title })

test('callsNow: call apps by the process using the mic, browser calls by window title', () => {
  assert.deepEqual(callsNow(['us.zoom.xos'], []), ['Zoom'])
  assert.deepEqual(callsNow(['com.hnc.Discord.helper', 'com.microsoft.teams2'], []), ['Discord', 'Microsoft Teams'])
  assert.deepEqual(callsNow(['com.apple.Music', 'com.anthropic.claudefordesktop'], [win('Meet - abc-defg-hij')]), [], 'not call apps; titles alone never count')
  assert.equal(browserHasMic(['us.zoom.xos']), false, 'window titles are only read when a browser has the mic')
  assert.equal(browserHasMic(['company.thebrowser.Browser']), true)
  assert.deepEqual(callsNow(['company.thebrowser.browser.helper'], [win('Meet - abc-defg-hij', 'company.thebrowser.Browser'), win('Inbox', 'com.apple.mail')]), ['Google Meet'])
  assert.deepEqual(callsNow(['com.apple.WebKit.GPU'], [win('Weekly sync | Microsoft Teams', 'com.apple.Safari')]), ['Microsoft Teams'])
  assert.deepEqual(callsNow(['com.google.Chrome.helper'], [win('Dictation test - Google Docs')]), [], 'a browser using the mic for something else')
  assert.deepEqual(callsNow(['com.google.Chrome.helper'], [win('Meeting notes - Google Docs')]), [], '"Meet" inside a word is not Meet')
})

test('callsNow: call apps\' own windows are no call when a browser has the mic for something else', () => {
  const apps = [win('Chat | Microsoft Teams', 'com.microsoft.teams2'), win('#general | Friends - Discord', 'com.hnc.Discord'), win('Webex', 'Cisco-Systems.Spark'), win('Zoom Workplace', 'us.zoom.xos'), win('Chat | Microsoft Teams', '')]
  assert.deepEqual(callsNow(['com.google.Chrome.helper'], apps), [], 'e.g. a voice message in WhatsApp Web')
  assert.deepEqual(callsNow(['com.google.Chrome.helper'], [...apps, win('Meet - abc-defg-hij')]), ['Google Meet'])
})

test('callsNow: Webex and Discord in a browser tab; pages that only use the words are not', () => {
  assert.deepEqual(callsNow(['com.google.Chrome.helper'], [win('Webex')]), ['Webex'])
  assert.deepEqual(callsNow(['org.mozilla.firefox'], [win('🔊 Lounge | Friends - Discord', 'org.mozilla.firefox')]), ['Discord'])
  const pages = [win('Huddle agenda - Google Docs'), win('Terms whereby we agree - Google Docs'), win('Sowing discord - Wikipedia'), win('WhatsApp')]
  assert.deepEqual(callsNow(['com.google.Chrome.helper'], pages), [], 'a Slack huddle in a tab can\'t be told apart, so "Huddle" names none')
})

const ev = (title: string, startMin: number, endMin: number, people: string[] = [], extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  title, start: startMin * 60_000, end: endMin * 60_000, attendees: [{ name: 'Me', email: 'me@x.com', me: true }, ...people.map((n) => ({ name: n, email: `${n.split(' ')[0].toLowerCase()}@acme.com` }))], ...extra,
})

test('pickInvite: the meeting going on when the session started, preferring one with people on it', () => {
  const at = 600 * 60_000 // 10:00
  const standup = ev('Standup', 600, 615, ['Dan Okafor'])
  const focus = ev('Focus time', 540, 720)
  assert.equal(pickInvite([focus, standup], at), standup)
  assert.equal(pickInvite([ev('Renewal', 605, 660, ['Priya Shah'])], at)?.title, 'Renewal', 'joined a few minutes early')
  assert.equal(pickInvite([ev('Later', 630, 660, ['X'])], at), null)
  assert.equal(pickInvite([ev('Holiday', 0, 1440, ['X'], { allDay: true })], at), null)
  assert.equal(pickInvite([ev('Block', 540, 720)], at)?.title, 'Block', 'with no one on any, still the meeting')
})

test('inviteContext: title and everyone but the user', () => {
  const text = inviteContext(ev('Northwind × Acme renewal', 600, 660, ['Priya Shah']))
  assert.match(text, /Title: Northwind × Acme renewal/)
  assert.match(text, /Invited besides the user: Priya Shah <priya@acme.com>/)
  assert.doesNotMatch(text, /me@x.com/)
  assert.equal(inviteContext(null), '')
  // The guess gets the invite ahead of the transcript; without one, the transcript alone, as before.
  assert.match(nameGuessContext('Speaker 1: hi', text), /^<calendar_invite>[\s\S]*<\/calendar_invite>\n\n<transcript>/)
  assert.equal(nameGuessContext('Speaker 1: hi'), '<transcript>\nSpeaker 1: hi\n</transcript>')
})
