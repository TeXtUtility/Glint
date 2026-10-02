// No Electron imports, so this runs under plain Node for tests.
// Audio arrives already at 16 kHz mono: CoreAudio (audiotee) and Chromium (mic AudioContext) resample
// with proper low-pass filters, so there's no hand-rolled resampler here.
import * as ort from 'onnxruntime-node'
import { VAD_DEFAULTS as VAD, type VadSettings } from '../shared/state.ts'

export { VAD }

export const SAMPLE_RATE = 16_000
export const FRAME = 512 // Silero v5 frame at 16 kHz
export const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000 // 32 ms

export function s16ToF32(s16: Int16Array): Float32Array {
  const out = new Float32Array(s16.length)
  for (let i = 0; i < s16.length; i++) out[i] = s16[i] / 0x8000
  return out
}

/**
 * Speech models sometimes loop on short clips ("Right. right. right"). Collapses a phrase of 2+ words repeated back to
 * back, or a single word said 3+ times in a row, to one copy. Case and punctuation are ignored when comparing.
 */
export function collapseRepeats(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const key = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
  const same = (a: number, b: number, n: number) => {
    for (let k = 0; k < n; k++) if (key(words[a + k]) !== key(words[b + k])) return false
    return true
  }
  for (let n = 6; n >= 1; n--) {
    for (let i = 0; i + 2 * n <= words.length; i++) {
      let reps = 1
      while (i + (reps + 1) * n <= words.length && same(i, i + reps * n, n)) reps++
      // A trailing partial copy of the phrase is part of the loop too.
      let tail = 0
      while (tail < n && i + reps * n + tail < words.length && key(words[i + reps * n + tail]) === key(words[i + tail])) tail++
      if ((n >= 2 && reps >= 2) || reps >= 3) {
        words.splice(i + n, (reps - 1) * n + (tail < n ? tail : 0))
        const last = words[i + n - 1]
        if (!/[.!?]$/.test(last) && /[.!?]$/.test(text.trim())) words[i + n - 1] = last.replace(/[,;:]?$/, '.')
      }
    }
  }
  return words.join(' ')
}

export function encodeWav(audio: Float32Array): Buffer {
  const data = Buffer.alloc(audio.length * 2)
  for (let i = 0; i < audio.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, audio[i])) * 0x7fff), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16) // fmt chunk size
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(SAMPLE_RATE, 24)
  h.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate
  h.writeUInt16LE(2, 32) // block align
  h.writeUInt16LE(16, 34) // bits per sample
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

/** A minute of exact silence from the call, with the user talking, before saying macOS may be blocking it. */
export const BLOCKED_CALL_S = 60

/**
 * With System Audio Recording denied, macOS hands the capture helper exact zeros and no error. Says so once (per
 * instance): 'blocked' after BLOCKED_CALL_S of them once the mic has had speech, if no sound has come through at all
 * (a call that went quiet for a minute isn't blocked), then 'back' when sound arrives.
 */
export class SilentCall {
  micSpoke = false
  private zeros = 0
  private heard = false
  private blocked = false

  push(samples: Float32Array): 'blocked' | 'back' | null {
    if (samples.some((x) => x !== 0)) {
      this.heard = true
      if (!this.blocked) return null
      this.blocked = false
      return 'back'
    }
    this.zeros += samples.length
    if (this.heard || !this.micSpoke || this.zeros < BLOCKED_CALL_S * SAMPLE_RATE) return null
    this.heard = this.blocked = true
    return 'blocked'
  }
}

// Silero VAD v5 (ONNX) takes 512-sample frames plus 64 samples of context, and keeps recurrent state.

const CONTEXT = 64
const SR = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [])

export class VadStream {
  session: ort.InferenceSession
  state = new Float32Array(2 * 128)
  context = new Float32Array(CONTEXT)
  constructor(session: ort.InferenceSession) {
    this.session = session
  }
  async prob(frame: Float32Array): Promise<number> {
    const input = new Float32Array(CONTEXT + FRAME)
    input.set(this.context)
    input.set(frame, CONTEXT)
    const out = await this.session.run({
      input: new ort.Tensor('float32', input, [1, CONTEXT + FRAME]),
      state: new ort.Tensor('float32', this.state, [2, 1, 128]),
      sr: SR,
    })
    this.state = new Float32Array(out.stateN.data as Float32Array)
    this.context = frame.slice(FRAME - CONTEXT)
    return (out.output.data as Float32Array)[0]
  }
  reset() {
    this.state = new Float32Array(2 * 128)
    this.context = new Float32Array(CONTEXT)
  }
}

export type SegEvent =
  | { type: 'start'; at: number }
  | { type: 'misfire' }
  /** `padMs`: pre-speech pad at the start of `audio`; `speechEndMs`: where its last voiced frame ends, from the start. */
  | { type: 'segment'; at: number; audio: Float32Array; padMs: number; speechEndMs: number }

type Frame = { f: Float32Array; t: number }

export class Segmenter {
  o: VadSettings // replaced live when the settings change
  pre: Frame[] = []
  seg: Frame[] = []
  speaking = false
  startAt = 0
  speechFrames = 0
  silentFrames = 0
  /** Pad frames before the trigger, and the last voiced frame, as indexes into `seg`: a flushed or force-ended
   * segment has no closing pause, and one right after another has less pad than the setting. */
  padFrames = 0
  lastSpeech = 0
  constructor(opts: VadSettings = VAD) {
    this.o = opts
  }

  /** `start` is in ms. */
  push(f: Float32Array, t: number, p: number): SegEvent[] {
    const o = this.o
    if (!this.speaking) {
      this.pre.push({ f, t })
      if (this.pre.length > Math.ceil(o.preSpeechPadMs / FRAME_MS) + 1) this.pre.shift()
      if (p < o.positive) return []
      this.speaking = true
      this.seg = this.pre // pre-speech pad, including this frame
      this.pre = []
      this.startAt = t
      this.padFrames = this.lastSpeech = this.seg.length - 1
      this.speechFrames = 1
      this.silentFrames = 0
      return [{ type: 'start', at: t }]
    }
    this.seg.push({ f, t })
    if (p >= o.positive) {
      this.lastSpeech = this.seg.length - 1
      this.speechFrames++
      this.silentFrames = 0
    } else if (p < o.negative) {
      this.silentFrames++
    }
    const quiet = this.silentFrames * FRAME_MS >= o.redemptionMs
    const tooLong = this.seg.length * FRAME_MS >= o.maxSegmentMs
    return quiet || tooLong ? [this.end()] : []
  }

  flush(): SegEvent | null {
    return this.speaking ? this.end() : null
  }

  reset() {
    this.pre = []
    this.seg = []
    this.speaking = false
    this.speechFrames = 0
    this.silentFrames = 0
  }

  private end(): SegEvent {
    const frames = this.seg
    const speechMs = this.speechFrames * FRAME_MS
    const padMs = this.padFrames * FRAME_MS
    const speechEndMs = (this.lastSpeech + 1) * FRAME_MS
    this.reset()
    if (speechMs < this.o.minSpeechMs) return { type: 'misfire' }
    const audio = new Float32Array(frames.length * FRAME)
    frames.forEach((fr, i) => audio.set(fr.f, i * FRAME))
    return { type: 'segment', at: this.startAt, audio, padMs, speechEndMs }
  }
}

export class RoleStream {
  vad: VadStream
  seg = new Segmenter()
  buf = new Float32Array(0)
  constructor(vad: VadStream) {
    this.vad = vad
  }
  get speaking() {
    return this.seg.speaking
  }

  /** `endTime` is the wall-clock ms at the end of `samples` (their arrival time). */
  async push(samples: Float32Array, endTime: number): Promise<SegEvent[]> {
    const all = new Float32Array(this.buf.length + samples.length)
    all.set(this.buf)
    all.set(samples, this.buf.length)
    const t0 = endTime - (all.length / SAMPLE_RATE) * 1000
    const events: SegEvent[] = []
    let i = 0
    for (; i + FRAME <= all.length; i += FRAME) {
      const frame = all.slice(i, i + FRAME)
      const p = await this.vad.prob(frame)
      events.push(...this.seg.push(frame, t0 + (i / SAMPLE_RATE) * 1000, p))
    }
    this.buf = all.slice(i)
    return events
  }

  flush() {
    return this.seg.flush()
  }

  reset() {
    this.vad.reset()
    this.seg.reset()
    this.buf = new Float32Array(0)
  }
}
