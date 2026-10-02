import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { globalShortcut } from 'electron'
import type { State } from '../shared/state.ts'
import { updateShortcuts } from './shortcuts.ts'
import { getState, initState } from './state.ts'

initState({ onboardingDone: true })
const at = (p: Partial<State>): State => ({ ...getState(), ...p })
const panel = (visible: boolean) => ({ ...getState().chat, visible })
const run = () => {}

test('openSettings: its keys are taken only while the panel or the corner strip is up', () => {
  const held = new Set<string>()
  mock.method(globalShortcut, 'unregisterAll', () => held.clear())
  mock.method(globalShortcut, 'register', (acc: string) => (held.add(acc), true))
  const keys = getState().shortcuts.openSettings
  const holds = (p: Partial<State>) => (updateShortcuts(at(p), run), held.has(keys))
  assert.equal(holds({ overlayVisible: true, layout: 'full', chat: panel(false) }), false) // just the capsule
  assert.equal(holds({ overlayVisible: true, layout: 'full', chat: panel(true) }), true)
  assert.equal(holds({ overlayVisible: true, layout: 'glance', chat: panel(false) }), true)
  assert.equal(holds({ overlayVisible: false, layout: 'glance', chat: panel(false) }), false)
  assert.equal(holds({ overlayVisible: true, layout: 'full', chat: panel(true), isRecordingShortcut: true }), false)
  mock.restoreAll()
})

test("shortcutFailures: keys that won't register are listed, kept while hidden, and dropped once they change", () => {
  const taken = getState().shortcuts.openSettings
  mock.method(console, 'warn', () => {})
  mock.method(globalShortcut, 'register', (acc: string) => acc !== taken)
  updateShortcuts(at({ overlayVisible: true, layout: 'full', chat: panel(true) }), run)
  assert.deepEqual(getState().shortcutFailures, ['openSettings'])
  updateShortcuts(at({ overlayVisible: true, layout: 'full', chat: panel(false) }), run)
  assert.deepEqual(getState().shortcutFailures, ['openSettings'])
  const shortcuts = { ...getState().shortcuts, openSettings: 'CommandOrControl+Shift+,' }
  updateShortcuts(at({ overlayVisible: true, layout: 'full', chat: panel(false), shortcuts }), run)
  assert.deepEqual(getState().shortcutFailures, [])
  mock.restoreAll()
})

test('shortcutFailures: keys that register on a later try leave the list', () => {
  const up = getState().shortcuts.moveUp
  let free = false
  mock.method(console, 'warn', () => {})
  mock.method(globalShortcut, 'register', (acc: string) => free || acc !== up)
  updateShortcuts(at({ overlayVisible: true, layout: 'full', chat: panel(true) }), run)
  assert.deepEqual(getState().shortcutFailures, ['moveUp'])
  free = true
  updateShortcuts(at({ overlayVisible: false, layout: 'full', chat: panel(true) }), run)
  updateShortcuts(at({ overlayVisible: true, layout: 'full', chat: panel(true) }), run)
  assert.deepEqual(getState().shortcutFailures, [])
  mock.restoreAll()
})
