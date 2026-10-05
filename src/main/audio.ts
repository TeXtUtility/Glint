// Capture runs only while a session is live and not paused; no helper process exists otherwise.
// The mic and system audio are separate pipelines end to end (VAD model, queue, transcription), so one side
// talking never delays or silences the other. Where they overlap, voice decides: the user talking over the call
// is kept, the call leaking back into the mic through the speakers is dropped.
import { AudioTee } from 'audiotee'
import { app } from 'electron'
import type { ChildProcess } from 'node:child_process'
import * as ort from 'onnxruntime-node'
import path from 'node:path'
import { isEcho, meVerdict, overlapShare, SPLIT_MIN_S } from '../shared/speakers'
import { elapsedMs, phase, speechModelFor, type Role, type State, type TranscriptItem } from '../shared/state'
import { getKey } from './ai'
import { RoleStream, s16ToF32, SilentCall, VadStream, type SegEvent } from './audio-core'
import { getState, patchState, subscribe } from './state'
import { loadLocalAsr, transcribeLocal, transcribeOpenAi, unloadLocalAsr } from './stt'
import { embed, endVoiceSession, label, learnMe, loadVoiceModel, meScore, speakerChanges, unloadVoiceModel } from './voice'
import { verbose } from './log'
import { COMPUTER, isMac } from './system'
import { downloadLiveWords, LIVE_WORDS_MB, liveAudio, liveEnd, liveStart, liveWanted, prepareLiveWords, stopLiveWords } from './live-words'

const MODEL_PATH = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? '' : 'resources', 'silero_vad.onnx')
const MODELS_DIR = () => path.join(app.getPath('userData'), 'models')
/** Chunks per pipeline waiting for VAD (~10 s): rides out a main-process stall instead of losing speech. */
const QUEUE_MAX = 200
const FLUSH_WAIT_MS = 4000
/** Session end waits longer than an ask for the last lines, since nothing is waiting on a reply. */
const FINISH_WAIT_MS = 10_000
/** Mic speech with at least this share of its time under call speech gets the echo check. */
const OVERLAP_SHARE = 0.3
const ECHO_TEXT_WAIT_MS = 2000
const SHOW = { visible: true, expanded: true }
/** Call audio that's exact silence for a minute while the user talks: macOS may be withholding it. */
const CALL_BLOCKED = isMac
  ? "No sound from this Mac's audio for a minute. If the other side of the call is talking, macOS may be blocking Glint " +
    'from hearing it: allow Glint in System Settings → Privacy & Security → Screen & System Audio Recording (Screen ' +
    'Recording on macOS 14), then pause and resume.'
  : "No sound from this PC's audio for a minute. If the other side of the call is talking, it may be playing on another " +
    'device: make it the default output in Windows, then pause and resume.'
const ROLES = ['me', 'them'] as const

/** Bounded concurrency with a bounded queue. */
class Limiter {
  private active = 0
  private waiting: (() => void)[] = []
  constructor(private max: number, private queueMax: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.waiting.length >= this.queueMax) throw new Error('transcription queue is full')
      await new Promise<void>((r) => this.waiting.push(r))
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

interface Pipeline {
  stream: RoleStream
  queue: { samples: Float32Array; at: number }[]
  pumping: Promise<void> | null
  stt: Limiter
  /** Frames of the current speech already sent for live words. */
  liveSent: number
  /** The last segment's line work: speaker ID runs in a worker, so each side's segments wait their turn. */
  lines: Promise<void>
}

const vad: Record<Role, Promise<ort.InferenceSession> | null> = { me: null, them: null }
let pipes: Record<Role, Pipeline> | null = null
let tee: AudioTee | null = null
let capturing = false
let generation = 0 // bumps on every start/stop so a slow start can't resurrect a stopped capture
let dropped = 0
let voiceSessionId: string | null = null
/** Session ending: capture stays off while its last lines finish transcribing. */
let finishing = false
/** This session's check for call audio macOS is withholding. */
let silentCall = new SilentCall()
/** Lines a pause or stop is still pushing through VAD. */
let draining: Promise<void> = Promise.resolve()
/** Lines still transcribing, per side. Outlives a pipeline: lines flushed by a pause finish after it's gone. */
const inflight: Record<Role, Set<Promise<void>>> = { me: new Set(), them: new Set() }

/** When the call (system audio) had speech recently: closed spans, plus the start of one still going. */
const call = { spans: [] as [number, number][], openSince: null as number | null }

export function initAudio() {
  subscribe(sync)
  sync(getState())
  // A model picked in Settings downloads now, not at the next session start.
  subscribe((s, prev) => {
    if (s.transcription.liveWords === prev.transcription.liveWords || !s.session) return
    if (s.transcription.liveWords) prepareLive()
    else stopLiveWords()
  })
  // The session's last lines are in by now (stopSession awaits finishAudio): free the speech model until the next one.
  subscribe((s, prev) => prev.session && !s.session && (unloadLocalAsr(), unloadVoiceModel(), verbose('[models] speech and voice models freed')))
  subscribe(({ transcription: t }, { transcription: p }) => {
    if (t.engine === 'local' && (t.engine !== p.engine || t.localModel !== p.localModel || t.language !== p.language)) void prepareSpeech()
  })
}

function sync(s: State) {
  if (finishing && s.session) return // don't restart capture while the last lines of the session finish
  finishing = false
  const want = !!s.session && !s.pause.paused && phase(s) === 'app'
  if (pipes) for (const role of ROLES) pipes[role].stream.seg.o = s.vad // tuning applies mid-session
  if (want && !capturing) void start()
  else if (!want && capturing) stop(!!s.session)
  if (!s.session && voiceSessionId) {
    endVoiceSession()
    voiceSessionId = null
  }
  if (!s.session) stopLiveWords()
}

async function start() {
  capturing = true
  const gen = ++generation
  try {
    // One thread, run in order: onnxruntime's default spins a thread per core between runs, which took about two
    // cores for this tiny model at ~60 runs a second.
    for (const role of ROLES) vad[role] ??= ort.InferenceSession.create(MODEL_PATH, { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' })
    const [vMe, vThem] = await Promise.all([vad.me!, vad.them!])
    if (gen !== generation) return
    const pipe = (v: ort.InferenceSession): Pipeline => ({
      stream: new RoleStream(new VadStream(v)), queue: [], pumping: null, stt: new Limiter(2, 64), liveSent: 0, lines: Promise.resolve(),
    })
    pipes = { me: pipe(vMe), them: pipe(vThem) }
    for (const role of ROLES) pipes[role].stream.seg.o = getState().vad
    call.spans = []
    call.openSince = null
    dropped = 0
    if (voiceSessionId !== getState().session?.id) silentCall = new SilentCall() // a resume keeps the session's
    voiceSessionId = getState().session?.id ?? null
    warmModels()
    if (process.platform !== 'darwin') return // ponytail: Windows loopback capture (spec §9c) not built yet
    // 16-bit mono PCM, resampled by CoreAudio. Packaged, the helper sits outside app.asar: a binary inside can't be run.
    const binaryPath = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked/node_modules/audiotee/bin/audiotee') : undefined
    const t = new AudioTee({ sampleRate: 16000, chunkDurationMs: 50, binaryPath })
    // Pipe reads can end mid-sample; carry an odd byte over so later samples stay aligned.
    let carry: Buffer | null = null
    t.on('data', ({ data }: { data: Buffer }) => {
      if (tee !== t) return // a stopped helper can still flush output for a moment
      let b = carry ? Buffer.concat([carry, data]) : data
      carry = b.length % 2 ? b.subarray(b.length - 1) : null
      if (carry) b = b.subarray(0, b.length - 1)
      const samples = s16ToF32(toInt16(b))
      const heard = silentCall.push(samples)
      if (heard === 'blocked' && !getState().audioError) patchState({ audioError: CALL_BLOCKED, chat: SHOW })
      else if (heard === 'back' && getState().audioError === CALL_BLOCKED) patchState({ audioError: null })
      enqueue('them', samples)
    })
    t.on('error', (err: Error) => tee === t && helperFailed(err))
    t.on('stop', () => tee === t && helperFailed(new Error('system audio helper exited')))
    tee = t
    await t.start()
    // audiotee only reports non-zero exit codes; a helper killed by a signal (code null) would go unnoticed.
    ;(t as unknown as { process?: ChildProcess }).process?.once('exit', (code, signal) => {
      if (tee === t) helperFailed(new Error(`system audio helper exited (${signal ?? code})`))
    })
  } catch (err) {
    if (gen === generation) helperFailed(err as Error)
  }
}

function stop(keepSession: boolean) {
  capturing = false
  generation++
  const t = tee
  tee = null
  void t?.stop().catch((err: Error) => console.warn('[audio] helper stop failed:', err))
  const ps = pipes
  pipes = null
  // Pausing (or ending via finishAudio) keeps what was being said: the queued audio still goes through VAD first.
  if (ps && keepSession) draining = drain(ps)
  else if (ps) for (const role of ROLES) ps[role].stream.reset()
  patchState({ voiceActivity: { me: false, them: false } })
}

async function drain(ps: Record<Role, Pipeline>) {
  for (const role of ROLES) {
    const p = ps[role]
    await p.pumping // stops taking chunks now that it's no longer the live pipeline
    try {
      for (const { samples, at } of p.queue.splice(0)) for (const ev of await p.stream.push(samples, at)) handle(role, ev, p)
    } catch (err) {
      console.error(`[audio] ${role} VAD failed while finishing:`, err)
    }
    handle(role, p.stream.flush(), p)
    p.stream.reset()
  }
}

function helperFailed(err: Error) {
  console.error('[audio] capture failed:', err)
  if (!capturing) return
  stop(false)
  // Don't retry in a loop. End the session and say so.
  patchState({ session: null, audioError: `Audio capture stopped (${err.message}). Restart Glint to record again.`, chat: SHOW })
}

/** Mic chunks from the chat window (16 kHz PCM16). */
export function pushMic(bytes: Uint8Array) {
  enqueue('me', s16ToF32(toInt16(bytes)))
}

function toInt16(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength - (bytes.byteLength % 2))
  copy.set(bytes.subarray(0, copy.length))
  return new Int16Array(copy.buffer) // copy: Node buffers can be unaligned
}

function enqueue(role: Role, samples: Float32Array) {
  if (!capturing || !pipes) return
  const p = pipes[role]
  p.queue.push({ samples, at: Date.now() })
  if (p.queue.length > QUEUE_MAX) {
    p.queue.shift()
    if (++dropped === 1) {
      patchState({ audioError: 'Glint fell more than 10 seconds behind and skipped some audio, so the transcript has a gap. Other heavy apps may be slowing this ' + COMPUTER + ' down.', chat: SHOW })
    }
    if (dropped % 20 === 1) console.warn(`[audio] ${role} processing is behind; dropped ${dropped} chunks so far`)
  }
  p.pumping ??= pump(role, p).finally(() => (p.pumping = null))
}

async function pump(role: Role, p: Pipeline) {
  // Once this is no longer the live pipeline (pause, stop), drain() takes over the rest of its queue.
  while (pipes?.[role] === p && p.queue.length) {
    const { samples, at } = p.queue.shift()!
    try {
      for (const ev of await p.stream.push(samples, at)) handle(role, ev, p)
      feedLive(role, p)
    } catch (err) {
      console.error(`[audio] ${role} VAD failed:`, err)
    }
  }
}

function handle(role: Role, ev: SegEvent | null, p: Pipeline) {
  if (!ev) return
  if (role === 'them') trackCall(ev)
  if (ev.type === 'start') {
    p.liveSent = 0
    if (liveWanted(getState())) liveStart(role)
    return patchState({ voiceActivity: { [role]: true } })
  }
  patchState({ voiceActivity: { [role]: false } })
  if (role === 'me' && ev.type === 'segment' && !getState().roomMode) silentCall.micSpoke = true // in a room the computer is often silent
  const heard = liveEnd(role)
  if (ev.type === 'segment') queueSegment(role, ev, p, heard)
}

/**
 * A segment's lines, after the side's previous segment's, so lines keep their order. Tracked in `inflight` (with the
 * transcriptions they start) so an ask or the session's end waits for them.
 */
function queueSegment(role: Role, seg: Segment, p: Pipeline, heard: string) {
  const job = p.lines.then(() => addSegment(role, seg, p, heard)).catch((err) => console.error('[voice] line failed:', err))
  p.lines = job
  inflight[role].add(job)
  void job.finally(() => inflight[role].delete(job))
}

/** Sends the speech so far (pre-speech pad included) to live words, from where the last send stopped. */
function feedLive(role: Role, p: Pipeline) {
  const frames = p.stream.seg.seg
  if (!p.stream.speaking || p.liveSent >= frames.length) return
  const fresh = frames.slice(p.liveSent)
  p.liveSent = frames.length
  const out = new Float32Array(fresh.reduce((n, f) => n + f.f.length, 0))
  let i = 0
  for (const f of fresh) (out.set(f.f, i), (i += f.f.length))
  liveAudio(role, out)
}

function trackCall(ev: SegEvent) {
  const now = Date.now()
  call.spans = call.spans.filter(([, end]) => end > now - 60_000)
  if (ev.type === 'start') call.openSince = ev.at
  else {
    if (ev.type === 'segment') call.spans.push(speechSpan(ev))
    call.openSince = null
  }
}

type Segment = Extract<SegEvent, { type: 'segment' }>

/** Wall-clock span of the speech in a segment: its audio also holds the pre-speech pad and any closing pause. */
function speechSpan({ at, padMs, speechEndMs }: Segment): [number, number] {
  return [at, Math.max(at + 100, at - padMs + speechEndMs)]
}

function patchTranscript(sessionId: string, fn: (items: TranscriptItem[]) => TranscriptItem[]) {
  const { session } = getState()
  if (session?.id === sessionId) patchState({ session: { ...session, transcript: fn(session.transcript) } })
}

/**
 * Who said a line, decided before it's added (so its role never changes afterwards). `drop`: echo of the call.
 * `checkEcho`: can't tell by voice, so compare its words with the call's once both are transcribed.
 */
async function classify(sessionId: string, role: Role, audio: Float32Array, span: [number, number]) {
  const s = getState()
  const seconds = (span[1] - span[0]) / 1000
  const room = s.roomMode && s.voiceprint === 'enrolled'
  const v = role === 'me' || s.speakerLabels ? await embed(audio) : null // null until the voice model has loaded
  const labelled = (source: 'mic' | 'system') => (s.speakerLabels ? label(sessionId, v, audio, seconds, source, span) : {})

  if (role === 'them') return { fields: labelled('system') }
  const score = v && meScore(sessionId, v)
  const verdict = meVerdict(score, seconds, s.voice)
  if (room) {
    if (verdict === 'me') return { fields: {} }
    if (verdict === 'not-me') return { fields: { role: 'them' as const, ...labelled('mic') } }
    const guessMe = score === null || score >= (s.voice.meKeep + s.voice.notMe) / 2
    return { fields: { sure: false as const, ...(guessMe ? {} : { role: 'them' as const }) } }
  }
  // In a call the mic is the user, except when the call leaks back in through the speakers. The voice can't be
  // trusted to tell those apart (on speakers, the call's echo has passed as the user's voice), so a mic line's words
  // are checked against the call's once both are transcribed; the voice only drops what's clearly someone else.
  const callSpeech = call.openSince === null ? call.spans : [...call.spans, [call.openSince, Date.now()] as [number, number]]
  const overlap = overlapShare(span[0], span[1], callSpeech)
  const overlaps = overlap >= OVERLAP_SHARE
  if (overlaps && verdict === 'not-me') return { drop: true, fields: {} }
  // The user's voice is learnt from lines with nothing from the call over them, and only once their words show
  // they aren't the call's: an echo the call's own speech detection missed would teach it the call's voice.
  // Echo plays while the call speaks, so only lines with call speech under them are checked: a read-back said
  // after the caller finished ("Tuesday at noon?" "Yes, Tuesday at noon") is the user.
  return { checkEcho: overlap > 0, learn: !overlaps && v ? v : undefined, fields: {} }
}

/**
 * A segment is speech between pauses, which can hold more than one person when nobody paused. Where voices are
 * told apart (the call, or the room), split it at speaker changes so each line has one speaker.
 */
async function addSegment(role: Role, seg: Segment, p: Pipeline, heard = '') {
  const s = getState()
  const { at: atMs, audio } = seg
  const [start, end] = speechSpan(seg)
  const splittable = role === 'them' ? s.speakerLabels : s.roomMode && s.voiceprint === 'enrolled'
  let cuts: number[] = []
  if (splittable && (end - start) / 1000 >= SPLIT_MIN_S) {
    try {
      cuts = await speakerChanges(audio)
    } catch (err) {
      console.error('[voice] split failed:', err)
    }
  }
  verbose(`[audio] ${role} speech ${Math.round(end - start)} ms${cuts.length ? `, split into ${cuts.length + 1}` : ''}`)
  if (!cuts.length) return void (await addLine(role, atMs, audio, [start, end], p, heard))
  // The segment's audio starts a pre-speech pad before `atMs`; each piece's speech runs from its cut to the next.
  const origin = atMs - seg.padMs
  const bounds = [0, ...cuts, audio.length]
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = i === 0 ? start : origin + bounds[i] / 16
    const to = i === bounds.length - 2 ? end : origin + bounds[i + 1] / 16
    await addLine(role, from, audio.subarray(bounds[i], bounds[i + 1]), [from, Math.max(from + 100, to)], p, i === 0 ? heard : '')
  }
}

/** `heard`: the live words for this speech, shown (as pending) until the line's own text arrives. */
async function addLine(role: Role, atMs: number, audio: Float32Array, span: [number, number], p: Pipeline, heard = '') {
  const s = getState()
  if (!s.session) return
  const sessionId = s.session.id
  const at = new Date(atMs).toISOString()
  let c: Awaited<ReturnType<typeof classify>>
  try {
    c = await classify(sessionId, role, audio, span)
  } catch (err) {
    console.error('[voice] classify failed:', err)
    c = { fields: {} }
  }
  if (c.drop) return console.log('[audio] dropped mic line: echo of the call')
  const item: TranscriptItem = { role, at, offsetMs: elapsedMs(s, atMs), status: 'pending', ...(heard && { text: heard }), ...c.fields }
  patchTranscript(sessionId, (items) => [...items, item].sort((a, b) => a.at.localeCompare(b.at)))
  const same = (i: TranscriptItem) => i.role === item.role && i.at === at

  const t0 = Date.now()
  // A line still queued when its session ended isn't transcribed: that would load the freed speech model again.
  const job = p.stt.run(() => (getState().session?.id === sessionId ? transcribe(audio, s.session!.language) : Promise.resolve('')))
    .then(async (text) => {
      verbose(`[stt] ${role} line transcribed in ${Date.now() - t0} ms (${text.length} characters)`)
      if (text && c.checkEcho && (await soundsLikeCall(sessionId, span, text))) text = ''
      if (text && c.learn) learnMe(sessionId, c.learn, (span[1] - span[0]) / 1000)
      patchTranscript(sessionId, (items) =>
        text ? items.map((i) => (same(i) ? { ...i, status: 'ready' as const, text } : i)) : items.filter((i) => !same(i)),
      )
    })
    .catch((err: Error) => {
      console.warn('[audio] transcription failed:', err.message)
      patchTranscript(sessionId, (items) => items.filter((i) => !same(i)))
      // After its session ended (the model unloaded under it), there's nothing left to tell the user.
      if (getState().session?.id === sessionId && !getState().audioError) patchState({ audioError: `Transcription failed: ${err.message}`, chat: SHOW })
    })
    .finally(() => inflight[role].delete(job))
  inflight[role].add(job)
}

/** Echo check by words: the mic line repeats what the call said at the same time (rules in `isEcho`). */
async function soundsLikeCall(sessionId: string, span: [number, number], text: string): Promise<boolean> {
  // The call's line this echoes may still be open (a long turn heard in pieces): wait for it to end, then for its text.
  const { maxSegmentMs } = getState().vad
  for (const until = Date.now() + maxSegmentMs; call.openSince !== null && call.openSince <= span[1] && Date.now() < until; ) await sleep(100)
  await Promise.race([Promise.allSettled([...inflight.them]), sleep(ECHO_TEXT_WAIT_MS)])
  // Call lines that could still be playing when this one started (none is longer than maxSegmentMs), and no later
  // than it ended: echo overlaps its source.
  const [from, to] = [new Date(span[0] - maxSegmentMs - 1_000).toISOString(), new Date(span[1] + 1_000).toISOString()]
  const heard = (getState().session?.id === sessionId ? getState().session!.transcript : [])
    .filter((t) => t.role === 'them' && t.text && t.at >= from && t.at <= to)
    .map((t) => ({ text: t.text!, startMs: Date.parse(t.at) }))
  const echo = isEcho(text, span[0], heard)
  if (echo) console.log('[audio] dropped mic line: its words match the call')
  return echo
}

function transcribe(audio: Float32Array, language: string) {
  const t = getState().transcription
  return t.engine === 'openai'
    ? transcribeOpenAi(audio, t.openaiModel, language, getKey('openai'))
    : transcribeLocal(audio, t.localModel, language, MODELS_DIR())
}

/** Load the models when a session starts so the first line isn't stuck behind a download. */
function warmModels() {
  const s = getState()
  if (s.speakerLabels || s.roomMode) {
    loadVoiceModel().catch((err: Error) => {
      if (getState().session?.id === s.session?.id) patchState({ audioError: `Couldn't load the voice model: ${err.message}`, chat: SHOW })
    })
  } else {
    void loadVoiceModel().catch(() => {}) // echo checks use it too; without it they fall back to comparing words
  }
  void prepareSpeech().then(() => prepareLive())
}

/**
 * Setup (onboarding): downloads every model the first session will use, one at a time, with progress and size in
 * `sttStatus`, so none of them starts downloading mid-call. Resolves with why it failed, or null.
 */
export async function prepareModels(): Promise<string | null> {
  const why = await prepareSpeech()
  if (why) return why
  try {
    if (liveWanted(getState())) {
      let shown = -1
      await downloadLiveWords(MODELS_DIR(), (pct) => {
        const step = Math.floor(pct / 5) * 5
        if (step !== shown) patchState({ sttStatus: `Downloading live words (${LIVE_WORDS_MB} MB)… ${(shown = step)}%` })
      })
    }
    patchState({ sttStatus: 'Downloading the voice model (38 MB)…' })
    await loadVoiceModel()
    if (!getState().session) unloadVoiceModel() // downloaded; the session loads it
    patchState({ sttStatus: null })
    return null
  } catch (err) {
    const why = `Couldn't download the speech models: ${(err as Error).message}`
    patchState({ sttStatus: why })
    return why
  }
}

/** Live words' model, after the speech model so the two downloads don't compete. */
function prepareLive() {
  const s = getState()
  if (!liveWanted(s)) return
  let shown = -1
  prepareLiveWords(MODELS_DIR(), (pct) => {
    const step = Math.floor(pct / 5) * 5
    if (step !== shown) patchState({ sttStatus: `Downloading live words (${LIVE_WORDS_MB} MB)… ${(shown = step)}%` })
  })
    .then(() => getState().sttStatus?.startsWith('Downloading live') && patchState({ sttStatus: null }))
    .catch((err: Error) => {
      console.warn('[live words] unavailable:', err.message)
      patchState({ sttStatus: null }) // lines still arrive when each finishes; only the word-by-word view is missing
    })
}

/**
 * Downloads and loads the local speech model, with progress in `sttStatus`. Does nothing once it's loaded. Resolves
 * with why it failed, or null.
 */
export function prepareSpeech(): Promise<string | null> {
  const s = getState()
  const t = s.transcription
  if (t.engine !== 'local') return Promise.resolve(null)
  let shown = -1
  const language = s.session?.language ?? t.language
  const t0 = Date.now()
  return loadLocalAsr(language, t.localModel, MODELS_DIR(), (pct) => {
    const step = Math.floor(pct / 5) * 5
    const m = speechModelFor(language, t.localModel)
    if (step !== shown) patchState({ sttStatus: `Downloading ${m.label} (${m.mb} MB)… ${(shown = step)}%` })
  })
    .then(() => {
      verbose(`[models] ${speechModelFor(language, t.localModel).label} ready in ${Date.now() - t0} ms`)
      patchState({ sttStatus: null })
      if (!getState().session) unloadLocalAsr() // downloaded ahead of a session (Settings, onboarding): no need to hold it
      return null
    })
    .catch((err: Error) => {
      const why = `Couldn't load the speech model: ${err.message}`
      // In a session the panel says so. Outside one (a model picked in Settings, onboarding) the page that asked shows
      // it, instead of the panel popping open with an error for a session that isn't running.
      patchState(getState().session ? { sttStatus: null, audioError: why, chat: SHOW } : { sttStatus: why })
      return why
    })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Ask and stop: force-end open segments and wait for pending lines so speech up to now is included.
 * Bounded to FLUSH_WAIT_MS in total, even if VAD is behind and the queue never drains. While paused there are
 * no pipelines, but lines flushed by the pause may still be transcribing, so those are waited for too.
 */
export async function flushAudio() {
  const deadline = Date.now() + FLUSH_WAIT_MS
  const ps = pipes
  if (ps) {
    await Promise.race([Promise.all(ROLES.map((r) => ps[r].pumping)), sleep(1000)]) // let queued chunks reach VAD first, briefly
    for (const role of ROLES) handle(role, ps[role].stream.flush(), ps[role])
  }
  await settle(deadline)
}

/**
 * Waits (until `deadline`) for lines in progress. Twice: a segment's line work ends by starting its transcription,
 * which the second pass then waits for.
 */
async function settle(deadline: number) {
  for (let i = 0; i < 2; i++) {
    await Promise.race([Promise.allSettled(ROLES.flatMap((r) => [...inflight[r]])), sleep(Math.max(0, deadline - Date.now()))])
  }
}

/**
 * Session end: stop capturing, push everything still queued through VAD, and wait (bounded) for the last lines'
 * text, so the saved session isn't missing its final words. Capture stays off until the session is gone.
 */
export async function finishAudio() {
  finishing = true
  if (capturing) stop(true)
  await Promise.race([draining, sleep(FINISH_WAIT_MS)])
  await settle(Date.now() + FINISH_WAIT_MS)
}
