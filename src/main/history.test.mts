import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mock, test } from 'node:test'
import { app, safeStorage, shell } from 'electron'
import type { SavedMessage } from '../shared/history.ts'
import type { Session } from '../shared/state.ts'
import { freshUserData } from '../test/electron.ts'
import { initHistory, listSessions, loadSession, macSleeps, macWakes, saveChat, trashSession, updateNotes } from './history.ts'
import { getState, initState, patchState } from './state.ts'

// Autosaves run every 10 s, and an ended session's notes would call the AI: time only moves when a test ticks it.
mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
initState({ onboardingDone: true, saveChats: true })
initHistory()

const fileOf = (id: string) => path.join(app.getPath('userData'), 'sessions', `${id}.glint`)
const line = (text: string, offsetMs: number) => ({ role: 'them' as const, at: new Date(offsetMs).toISOString(), offsetMs, status: 'ready' as const, text })
const ask = (text: string): SavedMessage => ({ id: text, role: 'user', text })

test("the live session's rename and summary edit survive its next autosave", () => {
  const live: Session = { id: 'live-1', chatId: 'c1', language: 'en', startedAt: Date.now(), isResumed: false, priorElapsedMs: 0, transcript: [line('Hello.', 1_000)] }
  patchState({ session: live })
  mock.timers.tick(10_000)
  assert.equal(loadSession('live-1').transcript.length, 1)
  updateNotes('live-1', { title: 'Budget review', summary: 'Agreed on Q3.' })
  patchState({ session: { ...live, transcript: [...live.transcript, line('Next item.', 2_000)] } })
  mock.timers.tick(10_000)
  const r = loadSession('live-1')
  assert.equal(r.transcript.length, 2) // that autosave did happen
  assert.equal(r.title, 'Budget review')
  assert.equal(r.summary, 'Agreed on Q3.')
  assert.equal(r.edited, true)
})

test('with saving chats off, a new chat outside a session is never written; one already in History still saves', () => {
  patchState({ saveChats: false })
  try {
    saveChat('chat-off', [ask('Is this kept?')])
    assert.equal(fs.existsSync(fileOf('chat-off')), false)
    patchState({ saveChats: true })
    saveChat('chat-kept', [ask('Saved while on')])
    patchState({ saveChats: false })
    saveChat('chat-kept', [ask('Saved while on'), ask('Continued while off')])
    assert.equal(loadSession('chat-kept').messages.length, 2)
  } finally {
    patchState({ saveChats: true })
  }
})

test("a trashed chat isn't written back by a save from the panel that still has it open", async () => {
  saveChat('chat-1', [ask('What does a 409 mean?')])
  assert.equal(fs.existsSync(fileOf('chat-1')), true)
  await trashSession('chat-1')
  saveChat('chat-1', [ask('What does a 409 mean?'), ask('And a 410?')])
  assert.equal(fs.existsSync(fileOf('chat-1')), false)
})

test('a chat whose trashing failed keeps saving', async () => {
  saveChat('chat-2', [ask('First?')])
  mock.method(shell, 'trashItem', async () => {
    throw new Error('The Trash is unavailable')
  })
  await assert.rejects(trashSession('chat-2'), /Trash is unavailable/)
  mock.restoreAll()
  saveChat('chat-2', [ask('First?'), ask('Second?')])
  assert.equal(loadSession('chat-2').messages.length, 2)
})

test("unreadable session files are counted and skipped; the rest still list", () => {
  freshUserData()
  saveChat('chat-ok', [ask('Still here?')])
  fs.writeFileSync(fileOf('other-mac'), 'encrypted with a key this Mac lacks')
  fs.writeFileSync(fileOf('garbled'), safeStorage.encryptString('{"version": 2}'))
  mock.method(console, 'warn', () => {})
  const { sessions, unreadable } = listSessions()
  mock.restoreAll()
  assert.deepEqual(sessions.map((s) => s.id), ['chat-ok'])
  assert.equal(unreadable, 2)
  assert.throws(() => loadSession('other-mac'), /keychain key|Windows account/)
})

test('a session id that could name a path outside the sessions folder is refused', async () => {
  const dir = freshUserData()
  for (const id of ['../state', 'a/b', '..', '', 'x.glint', 'chat-1/../../keys']) assert.throws(() => loadSession(id), /bad session id/)
  await assert.rejects(trashSession('../state'), /bad session id/)
  mock.method(console, 'error', () => {})
  saveChat('chat-x/../../../escaped', [ask('Hi?')])
  mock.restoreAll()
  assert.match(getState().audioError ?? '', /bad session id/)
  assert.equal(fs.existsSync(path.join(dir, '..', 'escaped.glint')), false)
  assert.equal(fs.existsSync(path.join(dir, 'sessions')), false)
})

test('notes cut off by the Mac sleeping are written again once it wakes', async () => {
  freshUserData()
  patchState({ ai: { ...getState().ai, provider: 'openai', fallbacks: [] } }) // no key here: each attempt fails at once, offline
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
  const live: Session = { id: 'slept-1', chatId: 'c2', language: 'en', startedAt: Date.now(), isResumed: false, priorElapsedMs: 0, transcript: [line('Ship it Friday.', 1_000)] }
  patchState({ session: live })
  patchState({ session: null }) // ended: its notes start 1.5 s later
  mock.method(console, 'error', () => {})
  mock.timers.tick(1_500)
  macSleeps() // the lid closes while they're being written
  await settle()
  assert.match(loadSession('slept-1').notesError ?? '', /went to sleep/)
  macWakes()
  mock.timers.tick(10_000)
  await settle()
  mock.restoreAll()
  const r = loadSession('slept-1')
  assert.equal(r.notesStatus, 'failed')
  assert.doesNotMatch(r.notesError ?? '', /went to sleep/, 'tried again after waking (and failed for its own reason)')
})
