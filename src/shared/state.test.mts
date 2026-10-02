import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyPatch, CAPSULE_ITEMS, elapsedMs, formatElapsed, ghostHints, isNewer, loadPersisted, normalize, parsePersisted, PERSISTED_DEFAULTS, phase,
  isSystemShortcut, prettyAccelerator, RUNTIME_DEFAULTS, tidyDividers, toAccelerator, type State,
} from './state.ts'

const base = (): State => ({ ...RUNTIME_DEFAULTS, ...PERSISTED_DEFAULTS, platform: 'darwin' })
const inApp = (): State => ({ ...base(), onboardingDone: true, permissions: { mic: 'granted', screen: 'granted' } })
const session = { id: 's', chatId: 'c', language: 'en', transcript: [], startedAt: 0, isResumed: false, priorElapsedMs: 0 }

test('phase needs onboarding + mac permissions', () => {
  assert.equal(phase(base()), 'onboarding')
  assert.equal(phase(inApp()), 'app')
  assert.equal(phase({ ...inApp(), permissions: { mic: 'granted', screen: 'denied' } }), 'onboarding')
  assert.equal(phase({ ...inApp(), platform: 'win32', permissions: { mic: 'denied', screen: 'denied' } }), 'app')
})

test('normalize clears app fields outside the app phase', () => {
  const s = normalize({ ...base(), session, chat: { ...base().chat, visible: true, expanded: true } })
  assert.equal(s.session, null)
  assert.equal(s.chat.visible, false)
})

test('normalize rules', () => {
  const noSession = normalize({ ...inApp(), pause: { paused: true, pausedAt: 5, pausedTotalMs: 9 }, inactivityPrompt: true })
  assert.deepEqual(noSession.pause, { paused: false, pausedTotalMs: 0 })
  assert.equal(noSession.inactivityPrompt, false)
  const collapsed = normalize({ ...inApp(), chat: { ...base().chat, visible: false, view: 'transcript' } })
  assert.equal(collapsed.chat.view, 'chat')
})

test('applyPatch merges objects one level, replaces session', () => {
  const s = applyPatch({ ...inApp(), session: { ...session, language: 'fr' } }, { chat: { expanded: true }, session: { ...session } })
  assert.equal(s.chat.expanded, true)
  assert.equal(s.chat.view, 'chat')
  assert.equal(s.session?.language, 'en')
})

test('parsePersisted: defaults fill gaps, bad types throw', () => {
  assert.deepEqual(parsePersisted('{}'), PERSISTED_DEFAULTS)
  assert.equal(parsePersisted('{"shortcuts":{"ask":"Alt+A"}}').shortcuts.toggleOverlay, PERSISTED_DEFAULTS.shortcuts.toggleOverlay)
  assert.throws(() => parsePersisted('{"isInvisible":"yes"}'))
  assert.throws(() => parsePersisted('{"theme":"neon"}'))
  assert.throws(() => parsePersisted('not json{'))
  assert.equal(parsePersisted('{"ai":{"provider":"openai"}}').ai.anthropicModel, PERSISTED_DEFAULTS.ai.anthropicModel)
  assert.throws(() => parsePersisted('{"ai":{"provider":"bard"}}'))
})

test('loadPersisted: a bad key falls back on its own instead of resetting everything', () => {
  const mode = { id: 'm1', name: 'Sales', prompt: 'x' }
  const { value, rejected } = loadPersisted(JSON.stringify({ modes: [mode], theme: 'dark', vad: { positive: 2 }, ai: 'x' }))
  assert.deepEqual(rejected, ['vad'])
  assert.deepEqual(value.vad, PERSISTED_DEFAULTS.vad)
  assert.deepEqual(value.ai, PERSISTED_DEFAULTS.ai) // non-object group: defaults
  assert.deepEqual([value.modes, value.theme], [[mode], 'dark'])
  assert.throws(() => loadPersisted('not json{'))
  // Ghost's old "Command" defaults read as the same keys, written as recording writes them.
  const old = loadPersisted(JSON.stringify({ shortcuts: { ghostPrev: 'Control+Alt+Command+[' } })).value.shortcuts.ghostPrev
  assert.deepEqual([old, prettyAccelerator(old, true)], [PERSISTED_DEFAULTS.shortcuts.ghostPrev, '⌃⌥⌘['])
})

test('capsule layout: new controls show, bad lists fall back, dividers tidy', () => {
  const load = (capsule: unknown) => loadPersisted(JSON.stringify({ capsule })).value.capsule
  assert.deepEqual(load({ shown: ['ask'], hidden: ['mode'] }), { shown: ['ask', ...CAPSULE_ITEMS.filter((id) => id !== 'ask' && id !== 'mode' && id !== 'humanize')], hidden: ['mode', 'humanize'] })
  assert.deepEqual(load({ shown: ['ask', 'ask'], hidden: [] }), PERSISTED_DEFAULTS.capsule)
  assert.deepEqual(load({ shown: ['bogus'], hidden: [] }), PERSISTED_DEFAULTS.capsule)
  assert.deepEqual(load(null), PERSISTED_DEFAULTS.capsule)
  assert.deepEqual(tidyDividers([...CAPSULE_ITEMS]), [...CAPSULE_ITEMS])
  assert.ok(PERSISTED_DEFAULTS.capsule.hidden.includes('humanize'), 'the humanizer starts in Meeting options')
  assert.deepEqual(tidyDividers(['divider-1', 'mode', 'divider-2', 'divider-3', 'ask', 'divider-4']), ['divider-1', 'mode', 'divider-3', 'ask'])
  assert.deepEqual(tidyDividers(['divider-1', 'divider-2']), [])
})

test('timer excludes paused time and adds prior elapsed', () => {
  const s = { session: { ...session, startedAt: 0, priorElapsedMs: 60_000 }, pause: { paused: true, pausedAt: 100_000, pausedTotalMs: 10_000 } }
  assert.equal(elapsedMs(s, 130_000), 60_000 + 100_000 - 10_000)
  assert.equal(formatElapsed(65_000), '1:05')
  assert.equal(formatElapsed(3_725_000), '1:02:05')
})

test('toAccelerator', () => {
  const k = (code: string, m: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
    ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m })
  assert.equal(toAccelerator(k('Backslash', { metaKey: true, shiftKey: true }), true), 'CommandOrControl+Shift+\\')
  assert.equal(toAccelerator(k('KeyK', { ctrlKey: true }), false), 'CommandOrControl+K')
  assert.equal(toAccelerator(k('Tab'), true), 'no-modifier')
  assert.equal(toAccelerator(k('KeyA', { shiftKey: true }), true), 'no-modifier')
  assert.equal(toAccelerator(k('MetaLeft', { metaKey: true }), true), null)
})

test('a Mac shortcut needs ⌘ or ⌃, and never takes the system ones', () => {
  const k = (code: string, m: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
    ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m })
  // ⌥ and ⌥⇧ alone: macOS 15 won't register them, and they type accents.
  assert.equal(toAccelerator(k('KeyE', { altKey: true }), true), 'no-modifier')
  assert.equal(toAccelerator(k('Digit2', { altKey: true, shiftKey: true }), true), 'no-modifier')
  assert.equal(toAccelerator(k('KeyE', { altKey: true, metaKey: true }), true), 'CommandOrControl+Alt+E')
  assert.equal(toAccelerator(k('KeyE', { altKey: true, ctrlKey: true }), true), 'Control+Alt+E')
  assert.equal(toAccelerator(k('KeyE', { altKey: true }), false), 'Alt+E') // fine elsewhere
  for (const [code, m] of [['KeyQ', {}], ['KeyW', {}], ['KeyH', {}], ['KeyM', {}], ['Escape', { altKey: true }]] as const) {
    assert.equal(isSystemShortcut(toAccelerator(k(code, { metaKey: true, ...m }), true) as string, true), true, code)
  }
  assert.equal(isSystemShortcut('CommandOrControl+Shift+Q', true), false)
  assert.equal(isSystemShortcut('CommandOrControl+Q', false), false)
})

test('modes: persisted and validated; a deleted active mode falls back to General', () => {
  const mode = { id: 'm1', name: 'Sales', prompt: 'x' }
  const ok = parsePersisted(JSON.stringify({ modes: [mode], activeModeId: 'm1' }))
  assert.deepEqual(ok.modes, [mode])
  assert.equal(ok.activeModeId, 'm1')
  assert.throws(() => parsePersisted(JSON.stringify({ modes: [{ id: 1 }] })))
  assert.throws(() => parsePersisted(JSON.stringify({ modes: 'nope' })))
  assert.equal(normalize({ ...inApp(), modes: [], activeModeId: 'm1' }).activeModeId, null)
  assert.equal(normalize({ ...inApp(), modes: [mode], activeModeId: 'm1' }).activeModeId, 'm1')
})

test('vad settings: defaults fill gaps, out-of-range rejected, negative kept ≤ positive', () => {
  assert.deepEqual(parsePersisted('{}').vad, PERSISTED_DEFAULTS.vad)
  assert.equal(parsePersisted(JSON.stringify({ vad: { redemptionMs: 1200 } })).vad.redemptionMs, 1200)
  assert.throws(() => parsePersisted(JSON.stringify({ vad: { positive: 2 } })))
  assert.throws(() => parsePersisted(JSON.stringify({ vad: { minSpeechMs: '400' } })))
  const s = normalize({ ...inApp(), vad: { ...PERSISTED_DEFAULTS.vad, positive: 0.4, negative: 0.6 } })
  assert.equal(s.vad.negative, 0.4)
})

test('opacity settings: defaults fill gaps, out-of-range rejected', () => {
  assert.deepEqual(parsePersisted('{}').opacity, PERSISTED_DEFAULTS.opacity)
  assert.equal(parsePersisted(JSON.stringify({ opacity: { idle: 0.5 } })).opacity.idle, 0.5)
  assert.equal(parsePersisted(JSON.stringify({ opacity: { idle: 0.5 } })).opacity.overlay, PERSISTED_DEFAULTS.opacity.overlay)
  assert.throws(() => parsePersisted(JSON.stringify({ opacity: { overlay: 0 } })))
  assert.throws(() => parsePersisted(JSON.stringify({ opacity: { background: '0.5' } })))
})

test('screenshot note: defaults, validation, per-mode note', () => {
  assert.deepEqual(parsePersisted('{}').screenshotNote, PERSISTED_DEFAULTS.screenshotNote)
  assert.equal(parsePersisted(JSON.stringify({ screenshotNote: { text: 'Use Go' } })).screenshotNote.position, 'top')
  assert.throws(() => parsePersisted(JSON.stringify({ screenshotNote: { position: 'left' } })))
  assert.throws(() => parsePersisted(JSON.stringify({ screenshotNote: { text: 'x'.repeat(1001) } })))
  assert.equal(parsePersisted(JSON.stringify({ modes: [{ id: 'm', name: 'n', prompt: 'p', screenshotNote: 'k' }] })).modes[0].screenshotNote, 'k')
  assert.throws(() => parsePersisted(JSON.stringify({ modes: [{ id: 'm', name: 'n', prompt: 'p', screenshotNote: 3 }] })))
})

test('isNewer compares versions numerically', () => {
  assert.equal(isNewer('0.5.0', '0.4.0'), true)
  assert.equal(isNewer('0.10.0', '0.9.9'), true)
  assert.equal(isNewer('1.0', '0.9.9'), true)
  assert.equal(isNewer('0.4.0', '0.4.0'), false)
  assert.equal(isNewer('0.4.0', '0.4.1'), false)
  assert.equal(isNewer('0.4.0', '0.4'), false)
})

test('speech flushed at pause time keeps its own offset', () => {
  const s = { session: { ...session, startedAt: 0 }, pause: { paused: true, pausedAt: 30_000, pausedTotalMs: 0 } }
  assert.equal(elapsedMs(s, 12_000), 12_000) // started before the pause: not pulled forward to 30 s
  assert.equal(elapsedMs(s, 40_000), 30_000) // after the pause began: frozen
})

test('ai fallbacks: default order, validated, old state.json without them gets the default', () => {
  assert.deepEqual(parsePersisted('{"ai":{"provider":"openai"}}').ai.fallbacks, PERSISTED_DEFAULTS.ai.fallbacks)
  assert.deepEqual(parsePersisted(JSON.stringify({ ai: { fallbacks: ['codex-cli'] } })).ai.fallbacks, ['codex-cli'])
  assert.throws(() => parsePersisted(JSON.stringify({ ai: { fallbacks: ['bard'] } })))
})

test('fast and smart models: defaults, and settings from before the split move the old Opus default to smart', () => {
  const d = PERSISTED_DEFAULTS.ai
  assert.equal(d.anthropicModel, 'claude-sonnet-5-5')
  assert.equal(d.anthropicSmartModel, 'claude-opus-5-5')
  assert.equal(d.fastThinking, false)
  const old = parsePersisted(JSON.stringify({ ai: { provider: 'anthropic', anthropicModel: 'claude-opus-5' } })).ai
  assert.deepEqual([old.anthropicModel, old.anthropicSmartModel], ['claude-sonnet-5-5', 'claude-opus-5-5'])
  const picked = parsePersisted(JSON.stringify({ ai: { anthropicModel: 'claude-haiku-4-5' } })).ai
  assert.equal(picked.anthropicModel, 'claude-haiku-4-5')
  const now = parsePersisted(JSON.stringify({ ai: { anthropicModel: 'claude-opus-5', anthropicSmartModel: 'claude-opus-5' } })).ai
  assert.equal(now.anthropicModel, 'claude-opus-5') // chosen after the split: kept
  assert.throws(() => parsePersisted(JSON.stringify({ ai: { fastThinking: 'yes' } })))
})

test('prettyAccelerator: Mac modifiers in the order macOS writes them', () => {
  assert.equal(prettyAccelerator('CommandOrControl+Alt+\\', true), '⌥⌘\\')
  assert.equal(prettyAccelerator('CommandOrControl+Shift+\\', true), '⇧⌘\\')
  assert.equal(prettyAccelerator('CommandOrControl+Control+Alt+Shift+Up', true), '⌃⌥⇧⌘↑')
  assert.equal(prettyAccelerator('CommandOrControl+Shift+K', false), 'Ctrl+Shift+K')
})

test("ghostHints: Ghost's card lists the shortcuts as they're set", () => {
  const sc = PERSISTED_DEFAULTS.shortcuts
  assert.deepEqual(ghostHints(sc, true), [
    "⌘↩ or ⌃⌥⌘↩ answers what's on screen", '⇧⌘↩ types a question', '⌃⌥⌘[ ] earlier and later answers', '⌃⌥⌘← → back or skip a word',
    '⌃⌥⌘↑ ↓ fade', '⌃⌥⌘= - text size', '⌃⌥⌘H or double-tap ⌃ hides', 'drag to move, ⌃⌥⌘0 back to the corner',
  ])
  // Rebound: a pair that no longer shares its modifiers is written out; a cleared one disappears.
  assert.deepEqual(ghostHints({ ...sc, ghostAsk: '', ghostNext: 'Control+Alt+N', ghostSkip: '' }, true).slice(0, 5), [
    "⌘↩ answers what's on screen", '⇧⌘↩ types a question', '⌃⌥⌘[ earlier answer', '⌃⌥N later answer', '⌃⌥⌘← back a word',
  ])
})

test('Pause and Invisible have no default shortcut, and a blank shortcut loads back', () => {
  assert.equal(PERSISTED_DEFAULTS.shortcuts.togglePause, '')
  assert.equal(PERSISTED_DEFAULTS.shortcuts.toggleInvisible, '')
  assert.equal(parsePersisted('{"shortcuts":{"togglePause":"Alt+P","toggleInvisible":""}}').shortcuts.togglePause, 'Alt+P')
  assert.equal(parsePersisted('{"shortcuts":{"ask":""}}').shortcuts.ask, '') // cleared by the user
})

test('Update channel: stable by default, beta loads back, anything else falls back to stable', () => {
  assert.equal(PERSISTED_DEFAULTS.updateChannel, 'stable')
  assert.equal(parsePersisted('{"updateChannel":"beta"}').updateChannel, 'beta')
  assert.equal(loadPersisted('{"updateChannel":"nightly"}').value.updateChannel, 'stable')
})
