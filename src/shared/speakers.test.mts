import assert from 'node:assert/strict'
import { test } from 'node:test'
import { echoTextShare, fillSpeaker, isEcho, isQuestion, MeVoice, meVerdict, overlapShare, refill, SpeakerTracker, speakerCuts, unit, type LineVoice } from './speakers.ts'
import { VOICE_DEFAULTS as O } from './state.ts'

// Unit vectors at a chosen similarity to axis 0: sim(at(s), A) = s.
const A = [1, 0, 0, 0]
const B = [0, 1, 0, 0]
const at = (s: number, axis = 0) => unit(Array.from({ length: 4 }, (_, i) => (i === axis ? s : i === 3 ? Math.sqrt(1 - s * s) : 0)))

test('overlapShare merges overlapping spans and clips to the window', () => {
  assert.equal(overlapShare(0, 10, []), 0)
  assert.equal(overlapShare(0, 10, [[2, 4], [3, 6]]), 0.4)
  assert.equal(overlapShare(0, 10, [[-5, 20]]), 1)
  assert.equal(overlapShare(5, 5, [[0, 10]]), 0)
})

test('meVerdict: thresholds, and unsure without a reference or on short lines', () => {
  assert.equal(meVerdict(0.7, 2, O), 'me')
  assert.equal(meVerdict(0.1, 2, O), 'not-me')
  assert.equal(meVerdict(0.33, 2, O), 'unsure')
  assert.equal(meVerdict(null, 2, O), 'unsure')
  assert.equal(meVerdict(0.9, 0.5, O), 'unsure')
})

test('MeVoice: a session voice is trusted only after enough clean speech; a voiceprint wins', () => {
  const me = new MeVoice(null)
  me.learn(A, 3)
  assert.equal(me.score(A), null)
  me.learn(A, 3)
  assert.ok(Math.abs(me.score(A)! - 1) < 1e-9)
  assert.ok(Math.abs(new MeVoice(B).score(A)!) < 1e-9)
})

test('echoTextShare and isQuestion', () => {
  assert.equal(echoTextShare('so the budget is final', 'yes so the budget is final now'), 1)
  assert.equal(echoTextShare('I think we should wait', 'the budget is final'), 0)
  assert.equal(echoTextShare('', 'x'), 0)
  assert.ok(isQuestion('Okay, so what is your timeline?'))
  assert.ok(isQuestion('Could you walk me through it'))
  assert.ok(!isQuestion('That sounds good.'))
  assert.ok(!isQuestion('Will do.'))
  assert.ok(!isQuestion('What I mean is, we ship it'))
  assert.ok(!isQuestion('Will do'))
})

test('SpeakerTracker: new voices, matching, margin, sources, naming and saving', () => {
  const t = new SpeakerTracker([], O)
  assert.deepEqual(t.assign(A, 0.8, 'system'), {}) // too short to label
  assert.deepEqual(t.assign(A, 1.5, 'system'), {}) // unknown but too short to start a voice
  const first = t.assign(A, 3, 'system')
  assert.deepEqual(first, { id: 'voice-1', isNew: true })
  assert.deepEqual(t.assign(at(0.9), 2, 'system'), { id: 'voice-1' })
  assert.deepEqual(t.assign(B, 3, 'system'), { id: 'voice-2', isNew: true })
  assert.deepEqual(t.assign(unit([0.38, 0, 0.925, 0]), 3, 'system'), {}) // ~0.37 to voice-1: neither a match nor clearly new
  assert.deepEqual(t.assign(A, 3, 'mic').isNew, true) // a room voice never matches a call voice

  assert.equal(t.nextToName(), undefined) // voice-1: 5 s over 2 lines, not enough yet
})

test('SpeakerTracker: offers a voice for naming, then recognises the saved person', () => {
  const t = new SpeakerTracker([], O)
  t.assign(A, 3, 'system')
  assert.equal(t.nextToName(), undefined) // one line
  t.assign(A, 4, 'system')
  const v = t.nextToName()!
  assert.equal(v.label, 'Speaker 1')
  const p = t.save(v.id, { id: 'p1', name: 'Priya' })
  assert.equal(p.name, 'Priya')
  assert.equal(t.voices.length, 0)
  assert.deepEqual(t.assign(at(0.8), 2, 'mic'), { id: 'p1' }) // saved people match from any source
  assert.throws(() => t.save(v.id, { id: 'p1', name: 'Priya' }))
})

test('SpeakerTracker: two saved people too close to call get no label', () => {
  const t = new SpeakerTracker([{ id: 'x', name: 'X', centroid: at(0.9, 0), weight: 10 }, { id: 'y', name: 'Y', centroid: at(0.9, 1), weight: 10 }], O)
  const between = unit([1, 1, 0, 0.2])
  assert.deepEqual(t.assign(between, 3, 'system'), {})
})

test('speakerCuts: cuts between turns, at the overlap start, and ignores blips', () => {
  assert.deepEqual(speakerCuts([{ start: 0, end: 4, speaker: 0 }]), [])
  assert.deepEqual(speakerCuts([{ start: 0.2, end: 3.8, speaker: 0 }, { start: 4.4, end: 8, speaker: 1 }]), [4.1])
  assert.deepEqual(speakerCuts([{ start: 0, end: 4, speaker: 0 }, { start: 3.5, end: 8, speaker: 1 }]), [3.5])
  // A, a 0.3 s blip from B, then A again: one piece
  assert.deepEqual(speakerCuts([{ start: 0, end: 3, speaker: 0 }, { start: 3.1, end: 3.4, speaker: 1 }, { start: 3.5, end: 6, speaker: 0 }]), [])
  // A B A turns, out of order
  assert.deepEqual(speakerCuts([{ start: 6, end: 9, speaker: 0 }, { start: 0, end: 3, speaker: 0 }, { start: 3, end: 6, speaker: 1 }]), [3, 6])
})

test('SpeakerTracker.merge: voices combine, a saved person always survives', () => {
  const t = new SpeakerTracker([{ id: 'p1', name: 'Priya', centroid: at(0.95, 2), weight: 20 }, { id: 'p2', name: 'Pri', centroid: at(0.9, 2), weight: 10 }], O)
  t.assign(A, 3, 'system')
  t.assign(B, 3, 'system')
  assert.deepEqual(t.merge('voice-2', 'voice-1'), { keep: 'voice-1', drop: 'voice-2' })
  assert.equal(t.voices.length, 1)
  assert.equal(t.voices[0].seconds, 6)
  assert.deepEqual(t.merge('p1', 'voice-1'), { keep: 'p1', drop: 'voice-1' }) // person into voice: the person stays
  assert.equal(t.voices.length, 0)
  assert.deepEqual(t.merge('p2', 'p1'), { keep: 'p1', drop: 'p2' })
  assert.deepEqual(t.people.map((p) => p.id), ['p1'])
  assert.equal(t.people[0].weight, 36) // 20 + the 6 s voice + 10
  assert.throws(() => t.merge('p1', 'p1'))
  assert.throws(() => t.merge('nope', 'p1'))
})

test('SpeakerTracker: a line under 1.5 s is never named from its own voice', () => {
  const t = new SpeakerTracker([{ id: 'p1', name: 'Priya', centroid: A, weight: 20 }], O)
  assert.deepEqual(t.assign(A, 1.2, 'system'), {})
  assert.deepEqual(t.assign(A, 1.6, 'system'), { id: 'p1' })
})

test('fillSpeaker: the closest voice heard in the call; context (unsure) without a voice', () => {
  const line = (start: number, end: number, speaker?: string, v: number[] | null = null, soft?: boolean): LineVoice =>
    ({ start, end, source: 'system', v, seconds: (end - start) / 1000, speaker, soft })
  const known = [{ id: 'dana', centroid: A }, { id: 'priya', centroid: B }]
  const two = [line(0, 4000, 'dana', A), line(4500, 8000, 'priya', B)]
  // A clear lean, long enough to be sure.
  assert.deepEqual(fillSpeaker(line(9000, 10500, undefined, at(0.4, 0)), two, known), { speaker: 'dana', unsure: false })
  // Short works the same way.
  assert.deepEqual(fillSpeaker(line(9000, 9700, undefined, at(0.4, 0)), two, known), { speaker: 'dana', unsure: false })
  // Short, but only one other person in the call: it's them.
  assert.deepEqual(fillSpeaker(line(5000, 5600, undefined, at(0.5, 0)), [line(0, 4000, 'dana', A)], known), { speaker: 'dana', unsure: false })
  // A voice that fits nobody heard so far stays unnamed.
  assert.equal(fillSpeaker(line(5000, 5600, undefined, at(0.1, 2)), two, known), undefined)
  // No voice yet (model loading): the only voice, or the turn the line sits in.
  assert.deepEqual(fillSpeaker(line(5000, 5600), [line(0, 4000, 'dana', A)], known), { speaker: 'dana', unsure: false })
  assert.deepEqual(fillSpeaker(line(8200, 8600), [...two, line(9000, 12000, 'priya', B)], known), { speaker: 'priya', unsure: true })
  assert.equal(fillSpeaker(line(4100, 4400), two, known), undefined) // between two people
  // Guessed lines don't count as having heard someone.
  assert.deepEqual(fillSpeaker(line(20000, 20500), [line(0, 4000, 'dana', A), line(9000, 9500, 'priya', null, true)], known), { speaker: 'dana', unsure: false })
})

test('refill: earlier unnamed lines are named once a voice is known, and guesses can change', () => {
  const lines: LineVoice[] = [
    { start: 0, end: 800, source: 'system', v: at(0.6), seconds: 0.8 },
    { start: 1000, end: 4000, source: 'system', v: A, seconds: 3, speaker: 'dana' },
  ]
  const changed = refill(lines, () => [{ id: 'dana', centroid: A }])
  assert.deepEqual(changed.map((l) => [l.start, l.speaker, l.soft, l.unsure]), [[0, 'dana', true, undefined]])
  assert.deepEqual(refill(lines, () => [{ id: 'dana', centroid: A }]), []) // nothing new
})

test('SpeakerTracker.duplicates: a new voice that is a saved person, or another voice, folds in', () => {
  const t = new SpeakerTracker([{ id: 'p1', name: 'Priya', centroid: A, weight: 20 }], O)
  t.voices.push({ id: 'voice-1', label: 'Speaker 1', centroid: at(0.8), seconds: 4, lines: 2, source: 'system', asked: false })
  t.voices.push({ id: 'voice-2', label: 'Speaker 2', centroid: B, seconds: 9, lines: 3, source: 'system', asked: false })
  t.voices.push({ id: 'voice-3', label: 'Speaker 3', centroid: at(0.9, 1), seconds: 3, lines: 1, source: 'system', asked: false })
  assert.deepEqual(t.duplicates(), [{ drop: 'voice-3', keep: 'voice-2' }, { drop: 'voice-1', keep: 'p1' }])
  assert.deepEqual(t.voices.map((v) => [v.id, v.seconds]), [['voice-2', 12]])
  assert.deepEqual(t.people[0].centroid, A) // a saved voiceprint isn't changed by a guess
})


test('isEcho: the call heard through the speakers, from a real session on speakers', () => {
  const at = (s: number) => s * 1000
  // Same words a second apart: echo, long or short.
  assert.ok(isEcho('Let\'s go back here.', at(41), [{ text: 'Let\'s go back here.', startMs: at(40) }]))
  assert.ok(isEcho('Uh one', at(335), [{ text: 'Uh one', startMs: at(335) }]))
  assert.ok(isEcho('Medium', at(361), [{ text: 'Medium', startMs: at(361) }]))
  // Recognised a little differently on the two sides: still most of the words.
  assert.ok(isEcho('Here, well, let\'s see what we got. The fourteenth century. Oh, right.', at(221),
    [{ text: 'Here, let\'s see what we got. The 14th century oh just try again.', startMs: at(220) }, { text: 'Let\'s see what we got the fourteenth century', startMs: at(218) }]))
  // The user's own reply, with the call quiet or saying something else: kept.
  assert.ok(!isEcho('You didn\'t say anything? No.', at(601), [{ text: 'Well, say something. Let me know.', startMs: at(603) }]))
  assert.ok(!isEcho('And those are plural.', at(266), [{ text: 'What are you tracing it to?', startMs: at(262) }]))
  // "Okay" said after theirs, not with it: kept. Said at the same moment: the same sound, dropped.
  assert.ok(!isEcho('Okay.', at(300), [{ text: 'Okay.', startMs: at(296) }]))
  assert.ok(isEcho('Okay.', at(299), [{ text: 'Okay.', startMs: at(299) }]))
  assert.ok(!isEcho('Okay.', at(299), []))
})
