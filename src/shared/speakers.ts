// Who is speaking, from speaker embeddings. No Electron or model imports, so tests run under plain Node.
// Embeddings are unit length, so a dot product is their cosine similarity.
import type { VoiceSettings } from './state.ts'

/** Shorter lines don't carry enough voice to tell the user from someone else (1 s clips are close to a coin flip). */
export const MIN_LABEL_S = 1
/** A line is named from its own voice only with this much speech; shorter ones are named from context (fillSpeaker). */
export const MATCH_MIN_S = 1.5
/** A new voice needs at least this much speech in one line. */
export const NEW_VOICE_S = 2
/** A voice is offered for naming once it has this much speech over at least two lines. */
export const NAME_AFTER_S = 6
/** The embedding only needs the middle of a line; longer audio costs time without helping. */
export const EMBED_MAX_S = 4
/** Session model of the user's voice: needs this much clean speech before it's trusted. */
const ME_SESSION_MIN_S = 6
/** A saved person keeps adapting to new rooms and mics, but slowly: newer speech never outweighs this much. */
const PERSON_WEIGHT_CAP_S = 120

export type Vec = ArrayLike<number>

export function unit(v: Vec): number[] {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  n = Math.sqrt(n) || 1
  return Array.from(v, (x) => x / n)
}

export function cosine(a: Vec, b: Vec): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Weighted mean of two unit vectors, back to unit length. */
export function blend(a: Vec, aWeight: number, b: Vec, bWeight: number): number[] {
  return unit(Array.from(a, (x, i) => x * aWeight + b[i] * bWeight))
}

/** Share of [start, end) covered by `spans` (which may overlap each other). */
export function overlapShare(start: number, end: number, spans: [number, number][]): number {
  if (end <= start) return 0
  const clipped = spans
    .map(([a, b]) => [Math.max(a, start), Math.min(b, end)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
  let covered = 0
  let reached = -Infinity
  for (const [a, b] of clipped) {
    const from = Math.max(a, reached)
    if (b > from) {
      covered += b - from
      reached = b
    }
  }
  return covered / (end - start)
}

/**
 * Is this mic speech the user? 'not-me' is echo of the call (in a call) or someone else in the room (room mode).
 * No reference voice, or a line too short to judge, is 'unsure'.
 */
export function meVerdict(simToMe: number | null, seconds: number, o: VoiceSettings): 'me' | 'not-me' | 'unsure' {
  if (simToMe === null || seconds < MIN_LABEL_S) return 'unsure'
  return simToMe >= o.meKeep ? 'me' : simToMe <= o.notMe ? 'not-me' : 'unsure'
}

/** The user's voice: the saved voiceprint, or else one learnt this session from mic speech with no call audio over it. */
export class MeVoice {
  enrolled: number[] | null
  private session: number[] | null = null
  private sessionSeconds = 0
  constructor(enrolled: number[] | null) {
    this.enrolled = enrolled
  }
  /** Only for mic speech that can't be anyone else: in a call, with nothing playing from the call at the same time. */
  learn(v: Vec, seconds: number) {
    if (seconds < MIN_LABEL_S) return
    this.session = this.session ? blend(this.session, this.sessionSeconds, v, seconds) : unit(v)
    this.sessionSeconds += seconds
  }
  score(v: Vec): number | null {
    const ref = this.enrolled ?? (this.sessionSeconds >= ME_SESSION_MIN_S ? this.session : null)
    return ref ? cosine(v, ref) : null
  }
}

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, ' ').split(' ').filter(Boolean)

/** Share of the mic line's words also in the call line. High means the mic just heard the call through the speakers. */
export function echoTextShare(mic: string, call: string): number {
  const a = words(mic)
  if (!a.length) return 0
  const pool = new Map<string, number>()
  for (const w of words(call)) pool.set(w, (pool.get(w) ?? 0) + 1)
  let hits = 0
  for (const w of a) {
    const n = pool.get(w) ?? 0
    if (n) {
      hits++
      pool.set(w, n - 1)
    }
  }
  return hits / a.length
}
export const ECHO_TEXT_SHARE = 0.6
/** Mic lines shorter than this are echo only as an exact repeat starting with the call's line: "okay" said over the call is the user. */
export const ECHO_MIN_WORDS = 4
export const SHORT_ECHO_MS = 1500

/**
 * Is this mic line the call, heard through the speakers? `call`: the call's lines around it (the caller picks the
 * window). A long line is echo when most of its words are theirs; a short one only when it's the same words as one of
 * their lines, starting within SHORT_ECHO_MS of it.
 */
export function isEcho(text: string, startMs: number, call: { text: string; startMs: number }[]): boolean {
  const n = words(text).length
  if (!n || !call.length) return false
  if (n < ECHO_MIN_WORDS) {
    return call.some((c) => Math.abs(c.startMs - startMs) <= SHORT_ECHO_MS && echoTextShare(text, c.text) === 1 && echoTextShare(c.text, text) === 1)
  }
  return echoTextShare(text, call.map((c) => c.text).join(' ')) >= ECHO_TEXT_SHARE
}

const QUESTION_START =
  /^(what|why|how|when|where|who|whom|whose|which|can|could|would|will|should|shall|do|does|did|is|are|was|were|have|has|had|may|might|am|isn't|aren't|don't|doesn't|didn't|won't|wouldn't|can't|couldn't|shouldn't)\b/i

/**
 * Ends with "?", or (for English from a transcriber that doesn't punctuate) is four or more words that open like a
 * question. Each match can start a paid Glance answer, so a punctuated line without "?" ("Will do.") never counts.
 */
export function isQuestion(text: string): boolean {
  const t = text.trim()
  if (/\?["')\]]*$/.test(t)) return true
  return !/[.,!?;:]/.test(t) && t.split(/\s+/).length >= 4 && QUESTION_START.test(t)
}

/** A line gets split at speaker changes only if it has at least this much speech: two turns need room. */
export const SPLIT_MIN_S = 3
/** Speaker turns shorter than this stay part of the turn around them. */
const TURN_MIN_S = 0.5

export interface Turn { start: number; end: number; speaker: number }

/**
 * Seconds at which to cut a line so each piece has one speaker, from diarization turns (which can overlap when
 * two people talk at once). Short turns are folded into their neighbours first, so a stray "mm" never makes a piece.
 */
export function speakerCuts(turns: Turn[]): number[] {
  const byStart = [...turns].sort((a, b) => a.start - b.start)
  const joinSame = (list: Turn[]) =>
    list.reduce<Turn[]>((out, t) => {
      const last = out.at(-1)
      if (last && last.speaker === t.speaker) last.end = Math.max(last.end, t.end)
      else out.push({ ...t })
      return out
    }, [])
  const runs = joinSame(joinSame(byStart).filter((t) => t.end - t.start >= TURN_MIN_S))
  const cuts: number[] = []
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1]
    const next = runs[i]
    cuts.push(next.start < prev.end ? next.start : (prev.end + next.start) / 2) // overlap: cut where the next one starts
  }
  return cuts
}

export type Source = 'mic' | 'system'
export interface Person { id: string; name: string; centroid: number[]; weight: number }
export interface Voice { id: string; label: string; centroid: number[]; seconds: number; lines: number; source: Source; asked: boolean }

/**
 * Labels lines by voice for one session: saved people first, then voices heard this session, then a new voice.
 * Voices from the mic (a room) and from system audio (a call) never match each other: different people, and
 * different-sounding audio.
 */
export class SpeakerTracker {
  people: Person[]
  voices: Voice[] = []
  o: VoiceSettings
  /** A saved person's voiceprint changed and should be written back. */
  peopleChanged = false
  private count = 0
  constructor(people: Person[], o: VoiceSettings) {
    this.people = people
    this.o = o
  }

  assign(v: number[], seconds: number, source: Source): { id?: string; isNew?: boolean } {
    if (seconds < MATCH_MIN_S) return {}
    const ranked = [
      ...this.people.map((p) => ({ id: p.id, sim: cosine(v, p.centroid) })),
      ...this.voices.filter((x) => x.source === source).map((x) => ({ id: x.id, sim: cosine(v, x.centroid) })),
    ].sort((a, b) => b.sim - a.sim)
    const [best, second] = ranked
    if (best && best.sim >= this.o.match && best.sim - (second?.sim ?? -1) >= this.o.margin) {
      const voice = this.voices.find((x) => x.id === best.id)
      if (voice) {
        voice.centroid = blend(voice.centroid, voice.seconds, v, seconds)
        voice.seconds += seconds
        voice.lines++
      } else if (best.sim >= this.o.match + 0.1 && seconds >= 3) {
        const p = this.people.find((x) => x.id === best.id)!
        p.centroid = blend(p.centroid, p.weight, v, seconds)
        p.weight = Math.min(PERSON_WEIGHT_CAP_S, p.weight + seconds)
        this.peopleChanged = true
      }
      return { id: best.id }
    }
    if (seconds >= NEW_VOICE_S && (!best || best.sim < this.o.newBelow)) {
      const id = `voice-${++this.count}`
      this.voices.push({ id, label: `Speaker ${this.count}`, centroid: unit(v), seconds, lines: 1, source, asked: false })
      return { id, isNew: true }
    }
    return {}
  }

  /** Everyone a line could be: saved people, and this session's voices from the same source. */
  known(source: Source): { id: string; centroid: number[] }[] {
    return [...this.people, ...this.voices.filter((x) => x.source === source)]
  }

  /**
   * End of a call: session voices that turn out to be a saved person, or another voice from the same source, now
   * that every voice has all its speech. Folds each into the other (a saved person's voiceprint is left as it is)
   * and returns what went where.
   */
  duplicates(): { drop: string; keep: string }[] {
    const out: { drop: string; keep: string }[] = []
    for (const v of [...this.voices].sort((a, b) => a.seconds - b.seconds)) {
      const best = [...this.people, ...this.voices.filter((x) => x !== v && x.source === v.source)]
        .map((x) => ({ x, sim: cosine(v.centroid, x.centroid) }))
        .sort((a, b) => b.sim - a.sim)[0]
      if (!best || best.sim < this.o.match) continue
      const into = this.voices.find((x) => x === best.x)
      if (into) Object.assign(into, { centroid: blend(into.centroid, into.seconds, v.centroid, v.seconds), seconds: into.seconds + v.seconds, lines: into.lines + v.lines })
      this.voices = this.voices.filter((x) => x !== v)
      out.push({ drop: v.id, keep: best.x.id })
    }
    return out
  }

  /** Continue "Speaker N" numbering after labels a resumed session already has. */
  skipTo(n: number) {
    this.count = Math.max(this.count, n)
  }

  /** The next voice worth asking the user to name, if any. */
  nextToName(): Voice | undefined {
    return this.voices.find((x) => !x.asked && x.seconds >= NAME_AFTER_S && x.lines >= 2)
  }

  /**
   * "These are the same person": combine two labels. A saved person always survives (a voice folds into them);
   * of two voices, or two people, `intoId` survives. Returns which id is kept and which is gone.
   */
  merge(fromId: string, intoId: string): { keep: string; drop: string } {
    if (fromId === intoId) throw new Error('pick a different speaker')
    const voice = (id: string) => this.voices.find((x) => x.id === id)
    const person = (id: string) => this.people.find((x) => x.id === id)
    const [fromV, intoV, fromP, intoP] = [voice(fromId), voice(intoId), person(fromId), person(intoId)]
    if (!(fromV || fromP) || !(intoV || intoP)) throw new Error('that speaker is no longer available')
    if (fromV && intoV) {
      intoV.centroid = blend(intoV.centroid, intoV.seconds, fromV.centroid, fromV.seconds)
      intoV.seconds += fromV.seconds
      intoV.lines += fromV.lines
      this.voices = this.voices.filter((x) => x !== fromV)
      return { keep: intoId, drop: fromId }
    }
    if (fromV || intoV) {
      const v = (fromV ?? intoV)!
      const p = (fromP ?? intoP)!
      this.save(v.id, p)
      return { keep: p.id, drop: v.id }
    }
    intoP!.centroid = blend(intoP!.centroid, intoP!.weight, fromP!.centroid, fromP!.weight)
    intoP!.weight = Math.min(PERSON_WEIGHT_CAP_S, intoP!.weight + fromP!.weight)
    this.people = this.people.filter((x) => x !== fromP)
    return { keep: intoId, drop: fromId }
  }

  /** Turns a session voice into a saved person, or folds it into an existing one. Returns the person. */
  save(voiceId: string, person: { id: string; name: string }): Person {
    const voice = this.voices.find((x) => x.id === voiceId)
    if (!voice) throw new Error('that voice is no longer available')
    this.voices = this.voices.filter((x) => x !== voice)
    const existing = this.people.find((p) => p.id === person.id)
    if (existing) {
      existing.centroid = blend(existing.centroid, existing.weight, voice.centroid, voice.seconds)
      existing.weight = Math.min(PERSON_WEIGHT_CAP_S, existing.weight + voice.seconds)
      return existing
    }
    const p = { id: person.id, name: person.name, centroid: voice.centroid, weight: Math.min(PERSON_WEIGHT_CAP_S, voice.seconds) }
    this.people.push(p)
    return p
  }
}

/** One line's voice, kept for the session so lines can be named later from what came after them. */
export interface LineVoice {
  /** Start and end of its speech, ms since the epoch. */
  start: number
  end: number
  source: Source
  /** Its voice embedding; null while the voice model loads. */
  v: number[] | null
  seconds: number
  speaker?: string
  /** Named from the voices around it rather than a match of its own, so it can change when more is known. */
  soft?: boolean
  /** Too short to be sure who it was: shown as "Name?". */
  unsure?: boolean
}

/** A pause this short between two lines from the same side can still be one person's turn. */
const TURN_GAP_MS = 3000
/**
 * The closest voice must reach this similarity and lead the next by this much. On 48 simulated calls of two or three
 * LibriSpeech voices through a 16 kbps Opus codec (a third of lines 0.5 to 1.4 s), naming lines this way left 0.1 to
 * 0.3% of lines unnamed with 1.0 to 1.4% wrong, where naming each line only from its own match left 20 to 25% as
 * "Them". Short lines named by the closest voice were wrong 0.6% (under 0.8 s) and 1.9% (0.8 to 1.1 s) of the time.
 */
const CLOSEST_FLOOR = 0.2
const CLOSEST_LEAD = 0.05

/**
 * A speaker for a line the voice match didn't name: the closest voice heard on its side of the call (a closed set of
 * a few people, so a far easier choice than recognising a voice from scratch), or with no usable voice yet, the only
 * voice on that side, or (marked unsure) the person whose turn it sits in. undefined when nothing settles it.
 */
export function fillSpeaker(line: LineVoice, lines: LineVoice[], known: { id: string; centroid: number[] }[]): { speaker: string; unsure: boolean } | undefined {
  const side = lines.filter((l) => l !== line && l.source === line.source && l.speaker)
  const heard = new Set(side.filter((l) => !l.soft).map((l) => l.speaker!))
  const candidates = known.filter((k) => heard.has(k.id))
  if (line.v && candidates.length) {
    const [best, second] = candidates.map((k) => ({ id: k.id, sim: cosine(line.v!, k.centroid) })).sort((a, b) => b.sim - a.sim)
    if (best.sim >= CLOSEST_FLOOR && best.sim - (second?.sim ?? -1) >= CLOSEST_LEAD) {
      return { speaker: best.id, unsure: false }
    }
    return undefined // a voice that fits nobody heard so far: better unnamed than wrong
  }
  if (candidates.length === 1) return { speaker: candidates[0].id, unsure: false }
  const before = side.filter((l) => l.end <= line.start + 200 && line.start - l.end <= TURN_GAP_MS).at(-1)
  const after = side.find((l) => l.start >= line.end - 200 && l.start - line.end <= TURN_GAP_MS)
  const turn = before && after ? (before.speaker === after.speaker ? before.speaker : undefined) : (before ?? after)?.speaker
  return turn ? { speaker: turn, unsure: true } : undefined
}

/**
 * Names every line its own voice left unnamed or only guessed at, in time order, against the voices as they are
 * now. Returns the lines whose label changed.
 */
export function refill(lines: LineVoice[], known: (source: Source) => { id: string; centroid: number[] }[]): LineVoice[] {
  const changed: LineVoice[] = []
  for (const line of [...lines].sort((a, b) => a.start - b.start)) {
    if (line.speaker && !line.soft) continue
    const fill = fillSpeaker(line, lines, known(line.source))
    if (fill && (fill.speaker !== line.speaker || fill.unsure !== !!line.unsure)) {
      Object.assign(line, { speaker: fill.speaker, soft: true, unsure: fill.unsure || undefined })
      changed.push(line)
    }
  }
  return changed
}

