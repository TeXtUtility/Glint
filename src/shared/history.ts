import { DATE_RE, isRetry, TIME_RE } from './prompt.ts'
import { elapsedMs, formatElapsed, type Session, type State, type TranscriptItem } from './state.ts'

export interface SavedMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** User turns: the full prompt sent (transcript + question), so later asks keep that context. */
  sent?: string
  /** User turns: transcript lines this ask delivered (see lineKey). Set only once the ask was answered. */
  sentKeys?: string[]
  /** User turns: the instruction carried out, typed or repeated from earlier, so an empty ask can repeat it. */
  typed?: string
  /** Replies a humanizer rewrote: the model's own text. `text` is what was shown; the model's history gets this. */
  original?: string
}

/** Past this, the oldest turns of a chat are left out of what the model sees... */
export const HISTORY_MAX_CHARS = 400_000
/** ...down to this, in one step, so the cached prefix then stays the same for many asks. */
export const HISTORY_KEEP_CHARS = 250_000

/**
 * What the model sees of earlier turns: only asks that were answered, each with its reply. A failed or stopped ask is
 * left out, so its question isn't sent twice and its transcript lines go with the next ask instead. `dropped` counts
 * the oldest turns left out; it only grows, in large steps (see HISTORY_MAX_CHARS).
 */
export function chatHistory(msgs: SavedMessage[], dropped: number): { history: { role: 'user' | 'assistant'; text: string }[]; dropped: number } {
  const turns = msgs
    .filter((m) => m.role === 'user' && m.sentKeys !== undefined)
    .map((m) => {
      const reply = msgs.find((r) => r.id === `${m.id}:reply`)
      const said = reply?.original ?? reply?.text // a follow-up works on what the model wrote, not a humanizer's rewrite
      return [{ role: 'user' as const, text: m.sent ?? m.text }, ...(said?.trim() ? [{ role: 'assistant' as const, text: said }] : [])]
    })
  const size = (from: number) => turns.slice(from).flat().reduce((n, t) => n + t.text.length, 0)
  let from = Math.min(dropped, turns.length)
  if (size(from) > HISTORY_MAX_CHARS) while (from < turns.length - 1 && size(from) > HISTORY_KEEP_CHARS) from++
  return { history: turns.slice(from).flat(), dropped: from }
}

/** The most recent instruction in a chat, which an ask with nothing typed repeats. */
export const lastInstruction = (msgs: SavedMessage[]) =>
  [...msgs].reverse().find((m) => m.role === 'user' && m.typed && !isRetry(m.typed))?.typed // "rewrite" isn't the task

export interface SavedSession {
  version: 1
  id: string
  chatId: string
  language: string
  /** When the session first started (a resume keeps the original). */
  startedAt: number
  /** null while live, or if Glint crashed before it ended. */
  endedAt: number | null
  elapsedMs: number
  transcript: TranscriptItem[]
  /** Names for TranscriptItem.speaker, as they were when the session was saved. */
  speakers?: Record<string, string>
  /** The mode active when the session started, by name. */
  mode?: string
  messages: SavedMessage[]
  // Post-session notes, written by main after the session ends. Absent until then.
  title?: string
  /** Markdown. */
  summary?: string
  tags?: string[]
  notesStatus?: 'processing' | 'done' | 'failed'
  notesError?: string
  /** The user edited the title or summary; regenerating keeps their text. */
  edited?: boolean
  /** To-dos from the meeting, written with the notes; the user ticks them off, dates and reassigns them. */
  actions?: ActionItem[]
  /**
   * The label each person had when the notes were written, by speaker id ('me' for the user). Naming or renaming
   * someone later changes their label in `speakers`, and the notes are shown with the new name (see `renamed`).
   */
  notesLabels?: Record<string, string>
  /** A follow-up email drafted on request. */
  followUp?: { subject: string; body: string }
}

/**
 * `ownerId` is the person in the session who does it ('me' or a speaker id), so it follows renames; `owner` is the
 * name as written, the only one for someone who didn't speak ("Legal"). `ownerByUser`: reassigned by hand, so
 * rewriting the notes keeps it. `due` is YYYY-MM-DD and `time` HH:MM (24 h).
 */
export interface ActionItem {
  id: string; text: string; owner?: string; ownerId?: string; ownerByUser?: boolean; due?: string; time?: string; done?: boolean
  /** When the meeting put it, in the words used ("before Friday"): offered in the date picker, kept if `due` changes. */
  suggested?: { due: string; time?: string; said: string }
}

/** Everyone the notes can name: the user, then each speaker by their current name. */
export const sessionPeople = (r: Pick<SavedSession, 'speakers'>) =>
  [{ id: 'me', name: 'Me' }, ...Object.entries(r.speakers ?? {}).map(([id, name]) => ({ id, name }))]

/** The session person a name in the notes stands for: matched against the labels the notes were written with. */
export function personFor(name: string | undefined, labels: Record<string, string>): string | undefined {
  const n = name?.trim().toLowerCase()
  if (!n) return undefined
  if (n === 'me' || n === 'i') return 'me'
  return Object.entries(labels).find(([, label]) => label.toLowerCase() === n)?.[0]
}

/** Who does an item now: their current name when they're a person in the session, else the name as written. */
export const ownerName = (a: ActionItem, r: Pick<SavedSession, 'speakers' | 'notesLabels'>) =>
  a.ownerId === 'me' ? 'Me' : (a.ownerId && (r.speakers?.[a.ownerId] ?? r.notesLabels?.[a.ownerId])) || a.owner

/**
 * Notes text with each person's name as it is now. One pass, longest label first, so "Speaker 1" doesn't eat into
 * "Speaker 12" and a swap is never swapped again.
 */
export function renamed(text: string, r: Pick<SavedSession, 'speakers' | 'notesLabels'>): string {
  const swaps = Object.entries(r.notesLabels ?? {})
    .flatMap(([id, was]) => {
      const now = id === 'me' ? 'Me' : r.speakers?.[id]
      return now && now !== was ? [[was, now] as const] : []
    })
    .sort((a, b) => b[0].length - a[0].length)
  if (!swaps.length) return text
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${swaps.map(([was]) => esc(was)).join('|')})(?![\\p{L}\\p{N}_])`, 'gu')
  return text.replace(re, (m) => swaps.find(([was]) => was === m)![1])
}

/** Action items from a window, kept only if well-formed: text, and a date and time in their formats. */
export function cleanActions(list: unknown): ActionItem[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((a) => {
    if (typeof a?.id !== 'string' || typeof a.text !== 'string' || !a.text.trim()) return []
    const opt = (v: unknown, re?: RegExp) => (typeof v === 'string' && v && (!re || re.test(v)) ? v : undefined)
    const sg = a.suggested
    const suggested = opt(sg?.due, DATE_RE) && opt(sg.said) ? { due: sg.due, time: opt(sg.time, TIME_RE), said: sg.said.slice(0, 80) } : undefined
    return [{
      id: a.id, text: a.text.slice(0, 500), owner: opt(a.owner)?.slice(0, 60), ownerId: opt(a.ownerId), ownerByUser: a.ownerByUser === true || undefined,
      due: opt(a.due, DATE_RE), time: opt(a.time, TIME_RE), done: a.done === true || undefined, ...(suggested && { suggested }),
    }]
  })
}

export type SessionNotes = Pick<SavedSession, 'title' | 'summary' | 'tags' | 'notesStatus' | 'notesError' | 'edited' | 'actions' | 'followUp' | 'notesLabels'>
export const notesOf = (r: SavedSession): SessionNotes => ({
  title: r.title, summary: r.summary, tags: r.tags, notesStatus: r.notesStatus, notesError: r.notesError, edited: r.edited,
  actions: r.actions, followUp: r.followUp, notesLabels: r.notesLabels,
})

export type SessionSummary = Pick<SavedSession, 'id' | 'startedAt' | 'endedAt' | 'elapsedMs'> & SessionNotes

/**
 * Who said a line: "Me", a saved person, "Speaker 2", or "Them". A room-mode line that might not be the user gets
 * a "?"; for the model it's "Unclear".
 */
export function lineLabel(t: Pick<TranscriptItem, 'role' | 'speaker' | 'sure'>, speakers?: Record<string, string>, forModel = false): string {
  if (t.sure === false && forModel) return 'Unclear'
  const name = t.role === 'me' ? 'Me' : (t.speaker && speakers?.[t.speaker]) || 'Them'
  return t.sure === false ? `${name}?` : name
}

/** `[m:ss] Name: text` lines, as shown in session detail, copied to the clipboard and sent for notes. */
export function transcriptText(items: TranscriptItem[], speakers?: Record<string, string>): string {
  return items
    .filter((t) => t.text)
    .map((t) => `[${formatElapsed(t.offsetMs)}] ${lineLabel(t, speakers)}: ${t.text}`)
    .join('\n')
}

/** Snapshot the live session. Pending lines are dropped: their audio isn't kept, so they can never finish. */
export function toRecord(
  s: Pick<State, 'session' | 'pause'> & { session: Session },
  messages: SavedMessage[],
  firstStartedAt: number,
  now: number,
  ended: boolean,
): SavedSession {
  const { session } = s
  return {
    version: 1,
    id: session.id,
    chatId: session.chatId,
    language: session.language,
    startedAt: firstStartedAt,
    endedAt: ended ? now : null,
    elapsedMs: elapsedMs(s, now),
    transcript: session.transcript.filter((t) => t.status === 'ready'),
    ...(session.speakers && { speakers: session.speakers }),
    ...(session.mode && { mode: session.mode }),
    messages: messages.filter((m) => m.text.trim()),
  }
}

/** A live Session that continues a saved one; the timer picks up where it stopped. */
export function resumeFrom(r: SavedSession, now: number): Session {
  const lastOffset = Math.max(0, ...r.transcript.map((t) => t.offsetMs))
  return {
    id: r.id,
    chatId: r.chatId,
    language: r.language,
    transcript: r.transcript.map((t) => ({ ...t, status: 'ready' })),
    startedAt: now,
    isResumed: true,
    priorElapsedMs: Math.max(r.elapsedMs, lastOffset),
    ...(r.speakers && { speakers: r.speakers }),
    ...(r.mode && { mode: r.mode }),
  }
}

/** Standalone chats (asked with no session running) are saved as records with no transcript. */
export const isChatId = (id: string) => id.startsWith('chat-')

/** A standalone chat's record: keeps `prev`'s start time and notes; untitled chats are named after the first question. */
export function chatRecord(prev: SavedSession | null, id: string, messages: SavedMessage[], now: number): SavedSession {
  const r: SavedSession = prev ?? {
    version: 1, id, chatId: id, language: '', startedAt: now, endedAt: null, elapsedMs: 0, transcript: [], messages: [],
  }
  const first = messages.find((m) => m.role === 'user')?.text.replace(/\s+/g, ' ').trim().slice(0, 80)
  return { ...r, endedAt: now, messages: messages.filter((m) => m.text.trim()), title: r.title || first }
}

export function parseRecord(json: string): SavedSession {
  const r = JSON.parse(json)
  const ok =
    r?.version === 1 &&
    typeof r.id === 'string' &&
    typeof r.chatId === 'string' &&
    typeof r.language === 'string' &&
    typeof r.startedAt === 'number' &&
    (r.endedAt === null || typeof r.endedAt === 'number') &&
    typeof r.elapsedMs === 'number' &&
    Array.isArray(r.transcript) &&
    (r.speakers === undefined || (typeof r.speakers === 'object' && r.speakers !== null && Object.values(r.speakers).every((v) => typeof v === 'string'))) &&
    Array.isArray(r.messages)
  if (!ok) throw new Error('malformed session record')
  return r
}
