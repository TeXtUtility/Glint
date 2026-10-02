// Speaker recognition: TitaNet-small embeddings (sherpa-onnx), the user's voiceprint, and saved people. TitaNet-small
// measured best of what sherpa-onnx runs (GLANCE-ROOM-SPEC.md): WeSpeaker models gave 12 to 34% EER under it.
// Voiceprints and voice samples live in one file encrypted with safeStorage, like session history.
// Voices heard in a session but never named exist only in memory.
import { app, net, safeStorage } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Worker } from 'node:worker_threads'
import { EMBED_MAX_S, fillSpeaker, MeVoice, refill, SpeakerTracker, speakerCuts, unit, type LineVoice, type Person, type Source } from '../shared/speakers'
import type { TranscriptItem } from '../shared/state'
import { getState, patchState } from './state'
import { verbose } from './log'
import createVoiceWorker from './voice-worker?nodeWorker'

const MODEL = {
  id: 'titanet-small',
  file: 'nemo_en_titanet_small.onnx',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx',
  sha256: 'ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e',
}
const SR = 16_000
const CLIP_MAX_S = 8 // what "who's this?" plays
const SAMPLE_MAX_S = 5 // what a saved person keeps, to check who they are later
const ENROLL_WINDOW_S = 3

interface SavedPerson extends Person {
  createdAt: number; lastHeard: number; /** base64 PCM16 at 16 kHz */ sample?: string
  /** Sessions they were heard in; `lastSession` is the last one counted, so a resumed session isn't counted twice. */
  sessions?: number; lastSession?: string
}
interface Store {
  version: 1; model: string
  /** `sample`: the recording's first seconds, base64 PCM16 at 16 kHz, to play back. */
  me: { centroid: number[]; createdAt: number; seconds?: number; sample?: string } | null
  people: SavedPerson[]
}

const modelPath = () => path.join(app.getPath('userData'), 'models', 'speaker', MODEL.file)
/** pyannote segmentation-3.0 (MIT), int8: 1.5 MB, so it ships with the app. Finds speaker changes and overlap. */
const SEGMENTATION_PATH = path.join(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'), 'pyannote_segmentation_3.int8.onnx')
const storePath = () => path.join(app.getPath('userData'), 'people.glint')

/** Runs the embedding and split models (voice-worker.ts) while loaded; ended after a session to free them. */
let worker: Worker | null = null
let loading: Promise<void> | null = null
/** Bumps on every unload, so a load that finishes after one ends its worker instead of keeping it. */
let generation = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let nextId = 0
let store: Store = { version: 1, model: MODEL.id, me: null, people: [] }
/** The store file exists but can't be decrypted; never overwrite it without the user choosing to. */
let unreadable = false

// The model

/** Downloads the model once (checked against its SHA-256) and loads it in a worker. Safe to call repeatedly. */
export function loadVoiceModel(): Promise<void> {
  const gen = generation
  return (loading ??= (async () => {
    if (!fs.existsSync(modelPath())) await download()
    const w = createVoiceWorker()
    await new Promise<void>((resolve, reject) => {
      w.on('message', (m: { t: string; id?: number; value?: unknown; message?: string }) => {
        if (m.t === 'ready') return resolve()
        const p = m.id === undefined ? undefined : pending.get(m.id)
        if (m.id !== undefined) pending.delete(m.id)
        if (m.t === 'result') p?.resolve(m.value)
        else if (m.t === 'error') (p ? p.reject(new Error(m.message)) : reject(new Error(m.message)))
      })
      w.on('error', reject)
      w.on('exit', () => {
        for (const p of pending.values()) p.reject(new Error('the voice model was unloaded'))
        pending.clear()
        reject(new Error('the voice model stopped'))
      })
      w.postMessage({ t: 'load', model: modelPath(), segmentation: SEGMENTATION_PATH })
    })
    if (gen !== generation) {
      // The session ended while it loaded: nothing would unload it. Its exit mustn't fail a newer worker's asks.
      w.removeAllListeners('exit')
      void w.terminate()
      throw new Error('the voice model was unloaded')
    }
    worker = w
    verbose('[voice] voice model loaded')
    patchState({ voiceModel: 'ready' })
  })().catch((err: Error) => {
    if (gen === generation) {
      loading = null
      patchState({ voiceModel: 'failed' })
    }
    throw err
  }))
}

/** Frees the voice models (their worker ends); the next session or voice recording loads them again. */
export function unloadVoiceModel() {
  generation++
  void worker?.terminate()
  worker = null
  loading = null
}

function ask<T>(t: 'embed' | 'split', samples: Float32Array): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    worker!.postMessage({ t, id, samples })
  })
}

async function download() {
  patchState({ voiceModel: 'downloading' })
  fs.mkdirSync(path.dirname(modelPath()), { recursive: true })
  // no-store: Chromium's HTTP cache would keep a second copy of the model. The timeout means a stall can't hang enrolling.
  const res = await net.fetch(MODEL.url, { cache: 'no-store', signal: AbortSignal.timeout(10 * 60_000) })
  if (!res.ok || !res.body) throw new Error(`voice model download failed (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  const chunks: Buffer[] = []
  let got = 0
  let shown = -1
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk))
    got += chunk.byteLength
    const pct = total ? Math.floor((got / total) * 20) * 5 : -1
    if (pct !== shown) patchState({ voiceModelPct: (shown = pct) < 0 ? null : pct })
  }
  const data = Buffer.concat(chunks) // 40 MB; fine to hold while hashing
  if (createHash('sha256').update(data).digest('hex') !== MODEL.sha256) throw new Error('the voice model download was corrupted')
  fs.writeFileSync(`${modelPath()}.part`, data)
  fs.renameSync(`${modelPath()}.part`, modelPath())
}

/** Unit-length voice embedding of the middle of `audio`; null until the model is loaded. */
export async function embed(audio: Float32Array): Promise<number[] | null> {
  if (!worker) return null
  const n = EMBED_MAX_S * SR
  const from = Math.max(0, (audio.length - n) >> 1)
  return unit(await ask<number[]>('embed', audio.slice(from, from + n)))
}

/**
 * Sample offsets at which the speaker changes within one line (none when one person spoke). Measured on joined
 * LibriSpeech clips: 16 of 17 two-speaker lines split where the second speaker starts, no single-speaker line
 * split, ~32 ms for 9 s on a base M1. Empty until the voice model has loaded.
 */
export async function speakerChanges(audio: Float32Array): Promise<number[]> {
  if (!worker) return []
  return speakerCuts(await ask<Parameters<typeof speakerCuts>[0]>('split', audio)).map((s) => Math.round(s * SR))
}

// The store

export function initVoice() {
  try {
    const raw = JSON.parse(safeStorage.decryptString(fs.readFileSync(storePath())))
    if (raw?.version !== 1 || !Array.isArray(raw.people)) throw new Error('malformed people file')
    // A different embedding model makes old voiceprints meaningless; they'd have to be recorded again.
    store = raw.model === MODEL.id ? raw : { version: 1, model: MODEL.id, me: null, people: [] }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[voice] people file unreadable:', err)
      unreadable = true
    }
  }
  publish()
  app.on('before-quit', endVoiceSession) // quitting mid-session keeps what the session's voices taught
}

function publish() {
  patchState({
    voiceprint: unreadable ? 'unreadable' : store.me ? 'enrolled' : 'none',
    voiceprintSeconds: store.me?.seconds ?? null,
    people: store.people.map((p) => ({ id: p.id, name: p.name, lastHeard: p.lastHeard, hasSample: !!p.sample, sessions: p.sessions ?? 0 })),
  })
}

/** `reset`: the user chose to start over (recording their voice again, forgetting everyone). */
function save(reset = false) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('secure storage unavailable')
  if (unreadable && !reset) throw new Error("Saved voices can't be read. Record your voice again in Settings → Voice first.")
  const tmp = `${storePath()}.tmp`
  fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(store)), { mode: 0o600 })
  fs.renameSync(tmp, storePath())
  unreadable = false
  publish()
}

const toPcm16 = (a: Float32Array) => Buffer.from(Int16Array.from(a, (x) => Math.round(Math.max(-1, Math.min(1, x)) * 0x7fff)).buffer)
const cleanName = (name: unknown) => {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
  if (!n) throw new Error('Type a name first.')
  return n
}

// The user's voiceprint

/** Averages 3 s windows of a recording. Rejects it if the windows disagree: two voices, or mostly noise. */
export async function enrollMe(pcm16: Uint8Array): Promise<void> {
  await loadVoiceModel()
  const s16 = new Int16Array(pcm16.buffer.slice(pcm16.byteOffset, pcm16.byteOffset + (pcm16.byteLength & ~1)))
  const audio = Float32Array.from(s16, (x) => x / 0x8000)
  const w = ENROLL_WINDOW_S * SR
  const vecs: number[][] = []
  for (let i = 0; i + w <= audio.length; i += w) {
    const win = audio.subarray(i, i + w)
    let e = 0
    for (const x of win) e += x * x
    if (Math.sqrt(e / win.length) < 0.01) continue // silence between sentences
    vecs.push((await embed(win))!)
  }
  if (vecs.length < 4) throw new Error('Not enough speech. Read the passage aloud for the whole recording.')
  const centroid = unit(vecs.reduce((acc, v) => acc.map((x, i) => x + v[i])))
  const agreeing = vecs.filter((v) => v.reduce((s, x, i) => s + x * centroid[i], 0) >= 0.5).length
  if (agreeing / vecs.length < 0.8) throw new Error('That sounded like more than one voice, or a lot of noise. Try again somewhere quieter.')
  const sample = Buffer.from(pcm16.buffer, pcm16.byteOffset, Math.min(pcm16.byteLength & ~1, SAMPLE_MAX_S * SR * 2)).toString('base64')
  store.me = { centroid, createdAt: Date.now(), seconds: Math.round(pcm16.byteLength / (SR * 2)), sample }
  save(true)
  if (session) session.me.enrolled = centroid
  // Recorded in Settings: nothing else needs the model until a session. (`session` outlives the session it's for.)
  if (!getState().session) unloadVoiceModel()
}

export function deleteMe() {
  store.me = null
  save()
  if (session) session.me.enrolled = null
  if (getState().roomMode) patchState({ roomMode: false })
}

// Saved people

export function renamePerson(id: string, name: unknown) {
  const p = store.people.find((x) => x.id === id)
  if (!p) return
  p.name = cleanName(name)
  save()
  const tp = session?.tracker.people.find((x) => x.id === id)
  if (tp) tp.name = p.name
  relabel((sp) => (sp[id] ? { ...sp, [id]: p.name } : sp))
}

export function deletePerson(id: string) {
  if (!store.people.some((x) => x.id === id)) return
  store.people = store.people.filter((x) => x.id !== id)
  save()
  if (session) session.tracker.people = session.tracker.people.filter((x) => x.id !== id)
}

export function forgetEveryone() {
  store.people = []
  save(true)
  if (session) session.tracker.people = []
}

/** PCM16 of a saved person's sample, or of an unnamed voice's clip from this session. */
export function voiceAudio(id: string): Uint8Array | null {
  if (id === 'me') return store.me?.sample ? Buffer.from(store.me.sample, 'base64') : null
  const clip = current()?.clips.get(id)
  if (clip) return toPcm16(clip)
  const sample = store.people.find((p) => p.id === id)?.sample
  return sample ? Buffer.from(sample, 'base64') : null
}

// This session's voices

function countSession(p: SavedPerson, sessionId: string) {
  if (p.lastSession === sessionId) return
  p.sessions = (p.sessions ?? 0) + 1
  p.lastSession = sessionId
}

/** `lines`: every labelled line's voice, so unclear lines can be named from what came before and after them. */
interface VoiceSession { id: string; tracker: SpeakerTracker; me: MeVoice; clips: Map<string, Float32Array>; lines: LineVoice[] }
let session: VoiceSession | null = null

/** The session's voice state; a resumed session keeps numbering after its existing "Speaker N" labels. */
function voices(sessionId: string): VoiceSession {
  if (session?.id === sessionId) return session
  const existing = Object.keys(getState().session?.speakers ?? {}).map((k) => Number(/^voice-(\d+)$/.exec(k)?.[1] ?? 0))
  const tracker = new SpeakerTracker(store.people.map(({ id, name, centroid, weight }) => ({ id, name, centroid: [...centroid], weight })), getState().voice)
  tracker.skipTo(Math.max(0, ...existing))
  session = { id: sessionId, tracker, me: new MeVoice(store.me?.centroid ?? null), clips: new Map(), lines: [] }
  patchState({ namePrompt: null })
  return session
}

/** The session voice actions apply to: the live one (even before its first line), else the one that just ended. */
function current(): VoiceSession | null {
  const live = getState().session
  return live ? voices(live.id) : session
}

/** Moves `fromId`'s lines in the live session, if it's `sessionId`, to `toId` labelled `name`. */
function moveLines(sessionId: string, fromId: string, toId: string, name: string) {
  const { session: live } = getState()
  if (live?.id !== sessionId) return
  const { [fromId]: _, ...rest } = live.speakers ?? {}
  patchState({
    session: { ...live, speakers: { ...rest, [toId]: name }, transcript: live.transcript.map((t) => (t.speaker === fromId ? { ...t, speaker: toId } : t)) },
  })
  for (const l of voices(sessionId).lines) if (l.speaker === fromId) l.speaker = toId
}

/** Puts context-named speakers on lines already in the transcript. */
function applyFills(sessionId: string, changed: LineVoice[]) {
  const { session: live } = getState()
  if (live?.id !== sessionId || !changed.length) return
  const by = new Map(changed.map((l) => [new Date(l.start).toISOString(), l]))
  const labelled = (t: TranscriptItem, l: LineVoice): TranscriptItem => {
    const { sure: _, ...rest } = t
    return { ...rest, speaker: l.speaker, ...(l.unsure && { sure: false as const }) }
  }
  patchState({ session: { ...live, transcript: live.transcript.map((t) => (t.role === 'them' && by.has(t.at) ? labelled(t, by.get(t.at)!) : t)) } })
}

/**
 * Before the call's notes are written: fold duplicate voices (a saved person heard as a new voice, or one person
 * split in two), then name every line that's still unnamed from the voices as they finally are.
 */
export function settleSpeakers() {
  const vs = session
  const live = getState().session
  if (!vs || live?.id !== vs.id) return
  vs.tracker.o = getState().voice
  try {
    settle(vs, live)
  } catch (err) {
    console.error('[voice] settling speakers failed:', err) // the lines keep the labels they had
  }
}

function settle(vs: VoiceSession, live: NonNullable<ReturnType<typeof getState>['session']>) {
  for (const { drop, keep } of vs.tracker.duplicates()) {
    const name = vs.tracker.people.find((p) => p.id === keep)?.name ?? vs.tracker.voices.find((v) => v.id === keep)?.label ?? live.speakers?.[keep] ?? 'Them'
    moveLines(vs.id, drop, keep, name)
    if (getState().namePrompt?.id === drop) patchState({ namePrompt: null })
  }
  applyFills(vs.id, refill(vs.lines, (source) => vs.tracker.known(source)))
}

export function meScore(sessionId: string, v: number[]): number | null {
  return voices(sessionId).me.score(v)
}

export function learnMe(sessionId: string, v: number[], seconds: number) {
  voices(sessionId).me.learn(v, seconds)
}

/**
 * Who said this line: fields to put on its transcript item. Also keeps a clip of new voices for naming. A line its
 * own voice can't name (too short, unclear, or no voice model yet) is named from context, and each new line can
 * name earlier ones that way too.
 */
export function label(sessionId: string, v: number[] | null, audio: Float32Array, seconds: number, source: Source, span: [number, number]): Pick<TranscriptItem, 'speaker' | 'sure'> {
  const vs = voices(sessionId)
  vs.tracker.o = getState().voice
  const line: LineVoice = { start: span[0], end: span[1], source, v, seconds }
  const { id } = v ? vs.tracker.assign(v, seconds, source) : {}
  if (!id) {
    const fill = fillSpeaker(line, vs.lines, vs.tracker.known(source))
    vs.lines.push(fill ? Object.assign(line, { speaker: fill.speaker, soft: true, unsure: fill.unsure || undefined }) : line)
    return fill ? { speaker: fill.speaker, ...(fill.unsure && { sure: false as const }) } : {}
  }
  vs.lines.push(Object.assign(line, { speaker: id }))
  applyFills(sessionId, refill(vs.lines.slice(-60), (src) => vs.tracker.known(src)))
  const person = store.people.find((p) => p.id === id)
  if (person) {
    person.lastHeard = Date.now()
    countSession(person, sessionId)
  }
  const voice = vs.tracker.voices.find((x) => x.id === id)
  if (voice) {
    const clip = audio.length > CLIP_MAX_S * SR ? audio.subarray(0, CLIP_MAX_S * SR) : audio
    if ((vs.clips.get(id)?.length ?? 0) < clip.length) vs.clips.set(id, clip.slice())
  }
  const name = person?.name ?? voice?.label
  if (name && getState().session?.speakers?.[id] !== name) relabel((sp) => ({ ...sp, [id]: name }))
  offerNextName()
  return { speaker: id }
}

function offerNextName() {
  if (getState().namePrompt || !session) return
  const v = session.tracker.nextToName()
  if (v) patchState({ namePrompt: { id: v.id, label: v.label, seconds: Math.round(v.seconds) } })
}

/**
 * "Who's this?" answered: save the voice as a person (or add it to one with that name) and relabel its lines in
 * the live session. Returns what changed, so a session that already ended can be relabelled on disk.
 */
export function nameVoice(voiceId: string, rawName: unknown): { sessionId: string; voiceId: string; personId: string; name: string } {
  const session = current()
  if (!session) throw new Error('that voice is no longer available')
  const name = cleanName(rawName)
  const existing = store.people.find((p) => p.name.toLowerCase() === name.toLowerCase())
  if (!session.tracker.voices.some((v) => v.id === voiceId)) {
    // A voice from before a resume: there's no voiceprint left to save, so only its label changes.
    const personId = existing?.id ?? voiceId
    moveLines(session.id, voiceId, personId, existing?.name ?? name)
    return { sessionId: session.id, voiceId, personId, name: existing?.name ?? name }
  }
  const person = session.tracker.save(voiceId, { id: existing?.id ?? randomUUID(), name: existing?.name ?? name })
  const clip = session.clips.get(voiceId)
  session.clips.delete(voiceId)
  const now = Date.now()
  const sample = clip ? toPcm16(clip.subarray(0, SAMPLE_MAX_S * SR)).toString('base64') : undefined
  if (existing) Object.assign(existing, { centroid: person.centroid, weight: person.weight, lastHeard: now, sample: existing.sample ?? sample })
  else store.people.push({ ...person, centroid: [...person.centroid], createdAt: now, lastHeard: now, sample })
  const saved = store.people.find((p) => p.id === person.id)
  if (saved) countSession(saved, session.id)
  save()
  moveLines(session.id, voiceId, person.id, person.name)
  patchState({ namePrompt: null })
  offerNextName()
  return { sessionId: session.id, voiceId, personId: person.id, name: person.name }
}

/**
 * "Same person as": merge two labels. Voiceprints combine when this session still has them; otherwise (a resumed
 * session's earlier voices) only the labels change. Merging two saved people keeps `intoId` and deletes the other.
 */
export function mergeSpeakers(fromId: string, intoId: string): { sessionId: string; keep: string; drop: string; name: string } {
  const session = current()
  if (!session) throw new Error('that speaker is no longer available')
  const known = (id: string) => session.tracker.voices.some((v) => v.id === id) || session.tracker.people.some((p) => p.id === id)
  let keep = intoId
  let drop = fromId
  if (known(fromId) && known(intoId)) ({ keep, drop } = session.tracker.merge(fromId, intoId))
  else if (fromId === intoId) throw new Error('pick a different speaker')
  else {
    // Into a label from before a resume: this session's voice takes that label's id, so its later lines keep it.
    const v = session.tracker.voices.find((x) => x.id === fromId)
    if (v) Object.assign(v, { id: intoId, label: getState().session?.speakers?.[intoId] ?? v.label })
  }

  const kept = session.tracker.people.find((p) => p.id === keep)
  const saved = store.people.find((p) => p.id === keep)
  const gone = store.people.find((p) => p.id === drop)
  if (kept && saved) Object.assign(saved, { centroid: [...kept.centroid], weight: kept.weight, lastHeard: Date.now() })
  if (gone && saved) {
    saved.sample ??= gone.sample
    // The larger count, not the sum: the two were probably heard in the same sessions.
    saved.sessions = Math.max(saved.sessions ?? 0, gone.sessions ?? 0)
    store.people = store.people.filter((p) => p !== gone)
  }
  if (kept || gone) save()

  const clip = session.clips.get(drop)
  session.clips.delete(drop)
  if (clip && !kept && (session.clips.get(keep)?.length ?? 0) < clip.length) session.clips.set(keep, clip)

  const name = kept?.name ?? session.tracker.voices.find((v) => v.id === keep)?.label ?? getState().session?.speakers?.[keep] ?? 'Them'
  moveLines(session.id, drop, keep, name)
  if (getState().namePrompt?.id === drop) {
    patchState({ namePrompt: null })
    offerNextName()
  }
  return { sessionId: session.id, keep, drop, name }
}

/** The session whose voices can still be named or merged: the live one, or the one that just ended. */
export const voiceSessionId = () => session?.id ?? null

/** "Not now": don't ask about this voice again this session. */
export function skipVoice(voiceId: string) {
  const v = current()?.tracker.voices.find((x) => x.id === voiceId)
  if (v) v.asked = true
  patchState({ namePrompt: null })
  offerNextName()
}

/** Session end: keep what saved people's voiceprints learnt, and when they were last heard. */
export function endVoiceSession() {
  if (!session || unreadable) return
  if (session.tracker.peopleChanged) {
    for (const p of session.tracker.people) {
      const saved = store.people.find((x) => x.id === p.id)
      if (saved) Object.assign(saved, { centroid: p.centroid, weight: p.weight })
    }
    session.tracker.peopleChanged = false
  }
  try {
    save()
  } catch (err) {
    console.error('[voice] save failed:', err)
  }
}

function relabel(fn: (speakers: Record<string, string>) => Record<string, string>) {
  const { session: live } = getState()
  if (live) patchState({ session: { ...live, speakers: fn(live.speakers ?? {}) } })
}

