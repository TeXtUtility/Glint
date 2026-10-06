// Finds the calendar invite for the meeting a session is in, so a name guess can match people to it. Read only;
// nothing is kept on disk.
import { pickInvite, type CalendarEvent } from '../shared/meetings'
import { platform } from './platform'

const invites = new Map<string, CalendarEvent | null>()

/**
 * The invite for a session that started at `startedAt`, looked up once per session. Asks for access the first time
 * (the user pressed Guess); denied or unreadable, there's no invite and the guess goes on from the transcript alone.
 */
export async function inviteFor(sessionId: string, startedAt: number): Promise<CalendarEvent | null> {
  if (invites.has(sessionId)) return invites.get(sessionId)!
  if (!platform.calendar || (await platform.calendar.request()) !== 'granted') return null // asked again next time, in case it's allowed by then
  let invite: CalendarEvent | null = null
  try {
    invite = pickInvite(await platform.calendar.events(startedAt), startedAt)
  } catch (err) {
    console.warn('[calendar] could not read events:', (err as Error).message)
  }
  invites.set(sessionId, invite)
  return invite
}
