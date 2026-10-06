// Notices a call starting (an app starting to use the mic) so Glint can offer to take notes. Which apps use the mic
// comes from each platform (platform/); it's never the audio.
import { browserHasMic, callsNow } from '../shared/meetings'
import { phase } from '../shared/state'
import { platform } from './platform'
import { getState, patchState } from './state'

/** The calls going on now, by app name ("Zoom", "Google Meet"). */
export function currentCalls(): string[] {
  const users = platform.micUsers()
  if (!users.length) return []
  return callsNow(users, browserHasMic(users) ? platform.openWindows() : [])
}

/** Calls already offered (taken up, dismissed, or going on during a session), until they end. */
const offered = new Set<string>()

/**
 * Every 5 s while the offer is on and no session runs: a call that starts gets one offer to take notes (callDetected).
 * A call still going on when a session ends isn't offered (it's the one just recorded), and an offer goes when its call does.
 */
export function watchCalls() {
  let sessionEnded = false
  setInterval(() => {
    const s = getState()
    if (!s.meetingPrompt || phase(s) !== 'app') return void (s.callDetected && patchState({ callDetected: null }))
    if (s.session) return void (sessionEnded = true) // nothing is offered during one, so nothing is read
    let calls: string[]
    try {
      calls = currentCalls()
    } catch (err) {
      return console.warn('[calls]', (err as Error).message)
    }
    for (const c of offered) if (!calls.includes(c)) offered.delete(c)
    if (sessionEnded) {
      sessionEnded = false
      return calls.forEach((c) => offered.add(c))
    }
    if (s.callDetected && !calls.includes(s.callDetected)) patchState({ callDetected: null })
    const fresh = calls.find((c) => !offered.has(c))
    if (fresh) (offered.add(fresh), patchState({ callDetected: fresh }))
  }, 5000)
}
