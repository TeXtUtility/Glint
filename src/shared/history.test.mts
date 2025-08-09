import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chatHistory, chatRecord, cleanActions, HISTORY_KEEP_CHARS, HISTORY_MAX_CHARS, lastInstruction, lineLabel, ownerName, parseRecord, personFor, renamed, resumeFrom, toRecord, transcriptText } from './history.ts'

const session = {
  id: 's', chatId: 'c', language: 'en', startedAt: 1_000, isResumed: false, priorElapsedMs: 0,
  transcript: [
    { role: 'me' as const, at: 'a', offsetMs: 5_000, status: 'ready' as const, text: 'hi' },
    { role: 'them' as const, at: 'b', offsetMs: 9_000, status: 'pending' as const },
  ],
}

test('save → load → resume round-trips and the timer continues', () => {
  const pause = { paused: false, pausedTotalMs: 2_000 }
  const msgs = [{ id: '1', role: 'user' as const, text: 'q' }, { id: '2', role: 'assistant' as const, text: '  ' }]
  const r = parseRecord(JSON.stringify(toRecord({ session, pause }, msgs, 500, 61_000, true)))
  assert.equal(r.elapsedMs, 58_000) // 61s − 1s start − 2s paused
  assert.equal(r.startedAt, 500)
  assert.equal(r.endedAt, 61_000)
  assert.deepEqual(r.transcript.map((t) => t.text), ['hi']) // pending dropped
  assert.deepEqual(r.messages.map((m) => m.id), ['1']) // empty reply dropped

  const live = resumeFrom(r, 100_000)
  assert.equal(live.isResumed, true)
  assert.equal(live.startedAt, 100_000)
  assert.equal(live.priorElapsedMs, 58_000)
  assert.equal(toRecord({ session: live, pause: { paused: false, pausedTotalMs: 0 } }, [], 500, 110_000, false).elapsedMs, 68_000)
})

test('parseRecord rejects malformed records', () => {
  assert.throws(() => parseRecord('{"version":1,"id":"s"}'))
  assert.throws(() => parseRecord('[]'))
})

test('transcriptText formats finished lines only', () => {
  assert.equal(transcriptText(session.transcript), '[0:05] Me: hi')
})

test('speaker labels: names, unknown voices, unsure lines, and a saved session keeps its names', () => {
  const speakers = { p1: 'Priya', 'voice-2': 'Speaker 2' }
  assert.equal(lineLabel({ role: 'me' }, speakers), 'Me')
  assert.equal(lineLabel({ role: 'them', speaker: 'p1' }, speakers), 'Priya')
  assert.equal(lineLabel({ role: 'them', speaker: 'gone' }, speakers), 'Them')
  assert.equal(lineLabel({ role: 'them' }), 'Them')
  assert.equal(lineLabel({ role: 'me', sure: false }, speakers), 'Me?')
  assert.equal(lineLabel({ role: 'them', sure: false }, speakers, true), 'Unclear')
  const s2 = { ...session, speakers, transcript: [{ role: 'them' as const, at: 'a', offsetMs: 1_000, status: 'ready' as const, text: 'hello', speaker: 'p1' }] }
  const r = parseRecord(JSON.stringify(toRecord({ session: s2, pause: { paused: false, pausedTotalMs: 0 } }, [], 0, 5_000, true)))
  assert.deepEqual(r.speakers, speakers)
  assert.equal(transcriptText(r.transcript, r.speakers), '[0:01] Priya: hello')
  assert.deepEqual(resumeFrom(r, 9_000).speakers, speakers)
  assert.throws(() => parseRecord(JSON.stringify({ ...r, speakers: { a: 1 } })))
})

test('chatRecord names a new chat after its first question and keeps an existing title and start', () => {
  const msgs = [{ id: '1', role: 'user' as const, text: ' what\n is this? ' }, { id: '2', role: 'assistant' as const, text: '' }]
  const r = parseRecord(JSON.stringify(chatRecord(null, 'chat-x', msgs, 5)))
  assert.equal(r.title, 'what is this?')
  assert.equal(r.startedAt, 5)
  assert.deepEqual(r.messages.map((m) => m.id), ['1'])
  const again = chatRecord({ ...r, title: 'Mine' }, 'chat-x', msgs, 9)
  assert.equal(again.title, 'Mine')
  assert.equal(again.startedAt, 5)
  assert.equal(again.endedAt, 9)
})

test('chatHistory: only answered asks with their replies; failed and stopped asks are left out', () => {
  const msgs = [
    { id: 'a', role: 'user' as const, text: 'Assist', sent: 'explain this', sentKeys: [] },
    { id: 'a:reply', role: 'assistant' as const, text: 'It shows X.' },
    { id: 'b', role: 'user' as const, text: 'why?', sent: 'why? (failed)' }, // no sentKeys: failed or stopped
    { id: 'b:reply', role: 'assistant' as const, text: '' },
    { id: 'c', role: 'user' as const, text: 'and this', sent: 'and this', sentKeys: ['them|t1'] },
    { id: 'c:reply', role: 'assistant' as const, text: '   ' }, // answered with nothing
  ]
  assert.deepEqual(chatHistory(msgs, 0).history, [
    { role: 'user', text: 'explain this' }, { role: 'assistant', text: 'It shows X.' }, { role: 'user', text: 'and this' },
  ])
})

test("chatHistory: a humanized reply goes back to the model as the model's own text", () => {
  const msgs = [
    { id: 'a', role: 'user' as const, text: 'q', sent: 'q', sentKeys: [] },
    { id: 'a:reply', role: 'assistant' as const, text: 'the rewrite', original: 'what the model wrote' },
  ]
  assert.deepEqual(chatHistory(msgs, 0).history, [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'what the model wrote' }])
})

test('chatHistory: very long chats drop their oldest turns in one step, then hold that point', () => {
  const big = 'x'.repeat(100_000)
  const msgs = Array.from({ length: 5 }, (_, i) => [
    { id: `q${i}`, role: 'user' as const, text: big, sentKeys: [] },
    { id: `q${i}:reply`, role: 'assistant' as const, text: 'ok' },
  ]).flat()
  const first = chatHistory(msgs, 0) // 500k > max: drop down to <= keep
  assert.ok(first.dropped > 0)
  assert.ok(first.history.reduce((n, t) => n + t.text.length, 0) <= HISTORY_KEEP_CHARS)
  const more = [...msgs, { id: 'q5', role: 'user' as const, text: 'short', sentKeys: [] }]
  assert.equal(chatHistory(more, first.dropped).dropped, first.dropped) // under the max again: the cut stays put
  assert.ok(HISTORY_MAX_CHARS > HISTORY_KEEP_CHARS)
})

test('lastInstruction: the latest typed or repeated instruction', () => {
  assert.equal(lastInstruction([{ id: '1', role: 'user', text: 'explain this', typed: 'explain this' }, { id: '2', role: 'user', text: 'Assist' }]), 'explain this')
  assert.equal(lastInstruction([{ id: '1', role: 'user', text: 'Assist' }]), undefined)
  assert.equal(lastInstruction([{ id: '1', role: 'user', text: 'explain this', typed: 'explain this' }, { id: '2', role: 'user', text: 'try again', typed: 'try again' }]), 'explain this')
})

test('notes follow renames: labels swap in one pass, whole names only, owners resolve to people', () => {
  const r = {
    notesLabels: { me: 'Me', 'voice-1': 'Speaker 1', 'voice-12': 'Speaker 12', 'voice-2': 'Speaker 2', p1: 'Dana' },
    speakers: { 'voice-1': 'Speaker 2', 'voice-12': 'Priya', 'voice-2': 'Sam', p1: 'Dana' }, // 1 became "Speaker 2" while 2 became Sam
  }
  assert.equal(renamed('Speaker 1 and Speaker 12 met Speaker 2 and Dana. Speaker 1x stays.', r), 'Speaker 2 and Priya met Sam and Dana. Speaker 1x stays.')
  assert.equal(renamed('Nothing to change', { speakers: {} }), 'Nothing to change')
  assert.equal(personFor('speaker 12', r.notesLabels), 'voice-12')
  assert.equal(personFor('Me', r.notesLabels), 'me')
  assert.equal(personFor('Legal', r.notesLabels), undefined)
  assert.equal(ownerName({ id: 'a', text: 't', ownerId: 'voice-12', owner: 'Speaker 12' }, r), 'Priya')
  assert.equal(ownerName({ id: 'a', text: 't', owner: 'Legal' }, r), 'Legal')
  assert.deepEqual(cleanActions([{ id: 'a', text: 'x', ownerId: 'me', ownerByUser: true, due: 'soon' }, { text: 'no id' }]),
    [{ id: 'a', text: 'x', owner: undefined, ownerId: 'me', ownerByUser: true, due: undefined, time: undefined, done: undefined }])
  assert.deepEqual(cleanActions([{ id: 'b', text: 'y', suggested: { due: '2026-10-01', said: 'before Friday' } }, { id: 'c', text: 'z', suggested: { due: 'Friday', said: 'x' } }])
    .map((a) => a.suggested), [{ due: '2026-10-01', time: undefined, said: 'before Friday' }, undefined])
})
