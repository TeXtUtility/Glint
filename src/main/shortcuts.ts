import { globalShortcut } from 'electron'
import { inCorner, phase, type ShortcutAction, type State } from '../shared/state'
import { patchState } from './state'

// Most shortcuts are registered only while what they act on is on screen, so they don't take those keys from every
// other app. New chat (Cmd+R) is renderer-local on purpose: a global Cmd+R would steal browser reload.
function live(action: ShortcutAction, s: State) {
  const glance = inCorner(s)
  switch (action) {
    case 'ghostAsk':
    case 'ghostPrompt':
    case 'ghostPrev':
    case 'ghostNext':
    case 'ghostBack':
    case 'ghostSkip':
    case 'ghostFadeIn':
    case 'ghostFadeOut':
    case 'ghostBigger':
    case 'ghostSmaller':
    case 'ghostCorner':
      return s.overlayVisible && s.layout === 'ghost'
    case 'ghostHide': // also while hidden, to bring it back
      return s.layout === 'ghost'
    case 'ask': // the capsule's Ask is always on screen; Glance asks for a one-line answer, Ghost for one to type
      return s.overlayVisible
    case 'openSettings': // only while the panel or corner strip is up: the app menu has it for Glint's own windows
      return s.overlayVisible && (glance || s.chat.visible)
    case 'scrollUp':
    case 'scrollDown':
      return s.overlayVisible && !glance && s.chat.visible
    case 'togglePause':
      return !!s.session // takes the keys only while there's a session to pause
    case 'moveUp':
    case 'moveDown':
    case 'moveLeft':
    case 'moveRight':
      return s.overlayVisible && !glance // the corner strip stays in its corner
    default:
      return true
  }
}

let registered = ''
/**
 * Actions whose keys wouldn't register, with those keys, for Settings to warn about (shortcutFailures). Kept while
 * the action isn't live, until its keys register or change.
 */
const failed = new Map<ShortcutAction, string>()

export function updateShortcuts(s: State, run: (action: ShortcutAction) => void) {
  const active =
    s.isRecordingShortcut || phase(s) !== 'app'
      ? []
      : (Object.entries(s.shortcuts) as [ShortcutAction, string][]).filter(([action, acc]) => acc && live(action, s))
  const key = JSON.stringify(active)
  if (key !== registered) {
    registered = key
    globalShortcut.unregisterAll()
    for (const [action, acc] of active) {
      let ok = false
      try {
        ok = globalShortcut.register(acc, () => run(action))
        if (!ok) console.warn(`[shortcuts] ${acc} is taken by another app, or macOS refuses it`)
      } catch (err) {
        console.warn(`[shortcuts] invalid accelerator ${acc}:`, err)
      }
      if (ok) failed.delete(action)
      else failed.set(action, acc)
    }
  }
  for (const [action, acc] of failed) if (s.shortcuts[action] !== acc) failed.delete(action) // new keys get a fresh try
  const list = [...failed.keys()]
  if (list.join() !== s.shortcutFailures.join()) patchState({ shortcutFailures: list })
}
