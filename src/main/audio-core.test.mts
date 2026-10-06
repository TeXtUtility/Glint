import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import * as ort from 'onnxruntime-node'
import { BLOCKED_CALL_S, encodeWav, FRAME, FRAME_MS, RoleStream, s16ToF32, Segmenter, SilentCall, VAD, VadStream, type SegEvent, collapseRepeats } from './audio-core.ts'

const frame = () => new Float32Array(FRAME)
function run(seg: Segmenter, probs: number[]): SegEvent[] {
  return probs.flatMap((p, i) => seg.push(frame(), i * FRAME_MS, p))
}
const n = (ms: number) => Math.ceil(ms / FRAME_MS)

test('segmenter: speech then silence → one segment with pre-pad, starting at first voiced frame', () => {
  const ev = run(new Segmenter(), [...Array(n(1000)).fill(0), ...Array(n(1000)).fill(0.9), ...Array(n(VAD.redemptionMs) + 1).fill(0)])
  assert.deepEqual(ev.map((e) => e.type), ['start', 'segment'])
  const seg = ev[1] as Extract<SegEvent, { type: 'segment' }>
  assert.equal(seg.at, n(1000) * FRAME_MS)
  const padFrames = n(VAD.preSpeechPadMs) + 1
  assert.equal(seg.audio.length, (padFrames + n(1000) - 1 + n(VAD.redemptionMs)) * FRAME)
  assert.equal(seg.padMs, n(VAD.preSpeechPadMs) * FRAME_MS)
  assert.equal(seg.speechEndMs, (n(VAD.preSpeechPadMs) + n(1000)) * FRAME_MS) // not counting the closing pause
})

test('segmenter: blip shorter than minSpeech is a misfire; mid-band probs don\'t end speech', () => {
  assert.deepEqual(run(new Segmenter(), [0.9, 0.9, ...Array(n(VAD.redemptionMs)).fill(0)]).map((e) => e.type), ['start', 'misfire'])
  const ev = run(new Segmenter(), [...Array(n(600)).fill(0.9), ...Array(n(2000)).fill(0.27)]) // between thresholds
  assert.deepEqual(ev.map((e) => e.type), ['start'])
})

test('segmenter: max length force-ends; flush returns the open segment', () => {
  const long = run(new Segmenter(), Array(n(VAD.maxSegmentMs) + 5).fill(0.9))
  assert.deepEqual(long.map((e) => e.type), ['start', 'segment', 'start'])
  const seg = new Segmenter()
  run(seg, Array(n(800)).fill(0.9))
  const flushed = seg.flush() as Extract<SegEvent, { type: 'segment' }>
  assert.equal(flushed.type, 'segment')
  assert.deepEqual([flushed.padMs, flushed.speechEndMs], [0, n(800) * FRAME_MS]) // no pad yet, no closing pause
  assert.equal(seg.flush(), null)
})

test('encodeWav writes a valid 16 kHz mono PCM16 header', () => {
  const wav = encodeWav(new Float32Array([0, 0.5, -1]))
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.readUInt32LE(24), 16000)
  assert.equal(wav.readUInt32LE(40), 6)
  assert.equal(wav.readInt16LE(46), Math.round(0.5 * 0x7fff))
  assert.equal(s16ToF32(new Int16Array([-32768]))[0], -1)
})

test('silero finds speech in synthesized audio and not in silence', { skip: process.platform !== 'darwin' }, async (ctx) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glint-vad-'))
  try {
    execFileSync('say', ['-o', path.join(dir, 's.aiff'), 'Hello, can you hear me? This is a test of the meeting transcript.'])
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', path.join(dir, 's.aiff'), path.join(dir, 's.wav')])
  } catch {
    fs.rmSync(dir, { recursive: true })
    return ctx.skip("can't synthesize speech on this Mac") // no voice installed: the installer runs these tests
  }
  const wav = fs.readFileSync(path.join(dir, 's.wav'))
  const dataAt = wav.indexOf('data') + 8
  const speech = s16ToF32(new Int16Array(wav.buffer.slice(wav.byteOffset + dataAt, wav.byteOffset + wav.length - ((wav.length - dataAt) % 2))))
  fs.rmSync(dir, { recursive: true })
  // GitHub's Mac runners sometimes synthesize silence; that's no test of the VAD.
  if (!speech.some((x) => Math.abs(x) > 0.01)) return ctx.skip('speech synthesis gave silence on this Mac')

  const vad = await ort.InferenceSession.create(path.join(import.meta.dirname, '../../resources/silero_vad.onnx'))
  const stream = new RoleStream(new VadStream(vad))
  const silence = new Float32Array(16000)
  const events: SegEvent[] = []
  let t = 0
  // Feed 50 ms chunks like the real capture does: 1 s silence, speech, 1.5 s silence.
  for (const part of [silence, speech, silence, silence.subarray(0, 8000)]) {
    for (let i = 0; i < part.length; i += 800) {
      const chunk = part.slice(i, i + 800)
      t += (chunk.length / 16000) * 1000
      events.push(...(await stream.push(chunk, t)))
    }
  }
  const segments = events.filter((e) => e.type === 'segment') as Extract<SegEvent, { type: 'segment' }>[]
  assert.ok(segments.length >= 1, `expected speech, got ${events.map((e) => e.type)}`)
  assert.ok(segments[0].at >= 800 && segments[0].at <= 1400, `speech start ${segments[0].at}ms should be near 1000ms`)
})

test('SilentCall: a minute of nothing but zeros once the user has spoken is flagged once; sound clears it', () => {
  const second = new Float32Array(16000)
  const c = new SilentCall()
  for (let i = 0; i < BLOCKED_CALL_S + 30; i++) assert.equal(c.push(second), null) // nobody has spoken: could be an empty room
  c.micSpoke = true
  assert.equal(c.push(second), 'blocked')
  assert.equal(c.push(second), null)
  assert.equal(c.push(new Float32Array([0, 1e-5])), 'back')
  assert.equal(c.push(new Float32Array([0.1])), null)
  for (let i = 0; i < BLOCKED_CALL_S * 2; i++) assert.equal(c.push(second), null) // once per session
  const d = new SilentCall()
  d.micSpoke = true
  d.push(new Float32Array([0.2])) // the call was heard once: later quiet is the other side not talking
  for (let i = 0; i < BLOCKED_CALL_S * 2; i++) assert.equal(d.push(second), null)
})

test('collapseRepeats: model loops collapse, normal speech is untouched', () => {
  assert.equal(collapseRepeats('Right. right. right'), 'Right.')
  assert.equal(collapseRepeats('Of the young prince of the young prince of the young prince'), 'Of the young prince')
  assert.equal(collapseRepeats('Turn to its place, turn to its place, turn to'), 'Turn to its place,')
  assert.equal(collapseRepeats('That works for me.'), 'That works for me.')
  assert.equal(collapseRepeats('no no'), 'no no') // a word said twice is normal speech
  assert.equal(collapseRepeats('I think that that is fine'), 'I think that that is fine')
})
