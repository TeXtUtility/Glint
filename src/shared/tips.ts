import type { CapsuleItem, ShortcutAction } from './state.ts'

/** Milestones kept in State.firsts, each with when it first happened. */
export type First = 'setup' | 'practice' | 'answer' | 'smart' | 'mode' | 'call' | 'speaker' | 'glance'

/** Getting started: setup ticks the first five, real use the rest. Shown until it's done, in setup, the tray and History. */
export const CHECKLIST: { id: First; label: string }[] = [
  { id: 'setup', label: 'Installed' },
  { id: 'practice', label: 'Heard a practice call' },
  { id: 'answer', label: 'Got an answer' },
  { id: 'smart', label: 'Asked with smart mode' },
  { id: 'mode', label: 'Made a mode yours' },
  { id: 'call', label: 'First real call' },
  { id: 'speaker', label: 'Named a speaker' },
  { id: 'glance', label: 'Tried Glance' },
]

/** What's left, or nothing once it's done, hidden (firsts.hidden, which turns tips off too), or for an install from before it. */
export const checklistLeft = (firsts: Record<string, number>) => (firsts.setup && !firsts.hidden ? CHECKLIST.filter((c) => !firsts[c.id]) : [])

export type TipId = 'ask' | 'smart' | 'glance' | 'files' | 'room' | 'speakers' | 'more'

type Key = (a: ShortcutAction) => string

/**
 * One sentence each, shown under the capsule at the moment it's useful, at most one per session and each once.
 * `capsule`: the control the tip is about, moved onto the capsule when it's shown. `action`: a button that does it.
 */
export const TIPS: Record<TipId, { when: string; text: (k: Key) => string; capsule?: CapsuleItem; action?: string }> = {
  ask: { when: 'Your first call', text: (k) => `Press ${k('ask')} when someone asks you something. Glint answers from the call and your screen.` },
  smart: {
    when: 'Your third question in a call', action: 'Turn on',
    text: (k) => `Hard question? Smart mode thinks it through before answering: the bulb beside the chat box, or ${k('toggleSmart')}.`,
  },
  glance: { when: 'Your second call', action: 'Try it', text: (k) => `Want answers without the panel? Glance shows one line in the corner. ${k('toggleGlance')}` },
  files: { when: 'Your third call', action: 'Add files', text: () => 'Add your price sheet, notes or slides to a mode, and its answers use them.' },
  room: {
    when: 'A session started without a call app', capsule: 'room',
    text: () => 'In the room, not on a call? Room mode tells voices apart on one mic, and discreet mode fades Glint for the people beside you.',
  },
  speakers: { when: 'After your first call', capsule: 'labels', text: () => "Name the voices in a call's notes, or press Guess to read them from the calendar invite." },
  more: { when: 'After a week', action: 'Open Settings', text: () => 'More you can do: Ghost, your own modes, and arranging the capsule, all in Settings.' },
}

/** The tip a real session starts with: the first not yet shown of the ones its count and context call for. */
export function tipAtStart(o: { calls: number; firsts: Record<string, number>; modeHasFiles: boolean; callApp: boolean }): TipId | null {
  if (!o.firsts.setup || o.firsts.hidden) return null
  const want: (TipId | false)[] = [
    o.calls === 0 && 'ask',
    o.calls >= 1 && 'glance',
    // ponytail: the third call of any mode, not the third of the same one; count calls per mode if that matters.
    o.calls >= 2 && !o.modeHasFiles && 'files',
    !o.callApp && o.calls >= 1 && 'room',
  ]
  return want.find((t): t is TipId => !!t && !o.firsts[`tip:${t}`]) ?? null
}
