// One file per session in userData/sessions, encrypted with safeStorage
// (a per-machine key held in the OS keychain). Nothing is ever written in plain text.
import { app, safeStorage, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { actionsToIcs } from '../shared/calendar'
import {
  chatRecord, cleanActions, isChatId, notesOf, ownerName, parseRecord, personFor, renamed, resumeFrom, toRecord, transcriptText,
  type ActionItem, type SavedMessage, type SavedSession, type SessionSummary,
} from '../shared/history'
import { FOLLOW_UP_SYSTEM_PROMPT, followUpPrompt, meetingDay, NOTES_SYSTEM_PROMPT, notesPrompt, parseFollowUp, parseFollowUpPartial, parseNotes } from '../shared/prompt'
import type { Session, State } from '../shared/state'
import { complete } from './ai'
import { failureLine, humanize } from './humanize'
import { getState, patchState, subscribe } from './state'
import { COMPUTER, isMac } from './system'

const SAVE_EVERY_MS = 10_000
const NOTES_DELAY_MS = 1500 // lets the chat panel's final messages land first
const dir = () => path.join(app.getPath('userData'), 'sessions')
function fileOf(id: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error('bad session id') // ids become file names
  return path.join(dir(), `${id}.glint`)
}

let chat: { sessionId: string; messages: SavedMessage[] } | null = null
let firstStartedAt: { sessionId: string; at: number } | null = null
/** The session that just ended; its chat can still arrive just after. */
let endedId: string | null = null
let dirty = false

export function initHistory() {
  // The last session is remembered in settings: file dates change when an old session's title or notes are edited.
  const remembered = getState().lastSessionId
  const last = remembered && fs.existsSync(fileOf(remembered)) ? remembered : newestId()
  patchState({ lastSessionId: last })
  // A session that ended because Glint quit never got its notes (or quit while writing them): write them now.
  const r = last ? tryLoad(last) : null
  if (r && r.endedAt && (!r.notesStatus || r.notesError === 'interrupted') && r.transcript.length) setTimeout(() => void generateNotes(r.id), 5_000)
  subscribe((s, prev) => {
    if (prev.session && prev.session.id !== s.session?.id) save(prev, true)
    else if (s.session && s.session.transcript !== prev.session?.transcript) dirty = true
  })
  setInterval(() => {
    const s = getState()
    if (dirty && s.session) save(s, false)
  }, SAVE_EVERY_MS)
  // Quitting mid-session ends it; don't lose the last 10 s.
  app.on('before-quit', () => {
    const s = getState()
    if (s.session) save(s, true)
  })
}

/** Saves the live session now, as ended: for exits that skip before-quit (reset and relaunch). */
export function saveLiveSession() {
  const s = getState()
  if (s.session) save(s, true)
}

export function setMessages(sessionId: string, messages: SavedMessage[]) {
  if (getState().session?.id === sessionId) {
    chat = { sessionId, messages }
    dirty = true
  } else if (endedId === sessionId) {
    const r = tryLoad(sessionId) // re-read: notes may already be on disk
    if (r) write({ ...r, messages: messages.filter((m) => m.text.trim()) })
  }
}

/** Chats moved to the Trash; the panel may still have one open, and saving it would bring it back. */
const trashed = new Set<string>()

export function saveChat(id: string, messages: SavedMessage[]) {
  if (isChatId(id) && !trashed.has(id)) write(chatRecord(tryLoad(id), id, messages, Date.now()))
}

/** The live session's notes as last written (resumed with it, or edited in History), kept for its autosaves. */
let kept: { sessionId: string; notes: ReturnType<typeof notesOf> | null } | null = null

function save(s: Pick<State, 'session' | 'pause'>, isEnd: boolean) {
  const session = s.session as Session
  dirty = false
  const messages = chat?.sessionId === session.id ? chat.messages : []
  const started = firstStartedAt?.sessionId === session.id ? firstStartedAt.at : session.startedAt
  // A resumed session keeps its notes until they're regenerated: read once per session, not on every autosave.
  if (isEnd || kept?.sessionId !== session.id) {
    const prev = tryLoad(session.id)
    kept = { sessionId: session.id, notes: prev && notesOf(prev) }
  }
  const record = { ...toRecord({ ...s, session }, messages, started, Date.now(), isEnd), ...kept.notes }
  // Ending schedules its notes: saved as pending, so a quit before they're written (a resumed session's old notes
  // are 'done') still gets them at the next launch.
  if (isEnd) Object.assign(record, { notesStatus: 'processing', notesError: undefined })
  // Before writing: the write's state patch runs an update's quit check, which must already see these notes pending.
  if (isEnd) {
    endedId = session.id
    scheduledNotes++
    setTimeout(() => void generateNotes(session.id).finally(() => scheduledNotes--), NOTES_DELAY_MS)
  }
  if (write(record, !isEnd) && getState().lastSessionId !== record.id) patchState({ lastSessionId: record.id }) // only saved ones resume
}

/**
 * Encrypt and write atomically. False if there was nothing to write or it failed (already reported). `quiet`: the
 * live session's periodic save, which the History list doesn't need to refetch for (refetching decrypts every file).
 */
function write(record: SavedSession, quiet = false): boolean {
  if (!record.transcript.length && !record.messages.length) return false // nothing happened; don't clutter history
  if (trashed.has(record.id)) return false // a late save (notes, a chat still open) must not bring it back
  try {
    // ponytail: on Linux without a keyring, safeStorage uses a hard-coded key; fine until Linux ships.
    if (!safeStorage.isEncryptionAvailable()) throw new Error('secure storage unavailable')
    const file = fileOf(record.id)
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
    fs.writeFileSync(`${file}.tmp`, safeStorage.encryptString(JSON.stringify(record)), { mode: 0o600 })
    fs.renameSync(`${file}.tmp`, file)
    // A rename, summary edit or ticked item on the live session: its next autosave must keep it, not the old copy.
    if (kept?.sessionId === record.id) kept.notes = notesOf(record)
    if (!quiet) patchState({ historyVersion: getState().historyVersion + 1 })
    return true
  } catch (err) {
    console.error('[history] save failed:', err)
    patchState({ audioError: `Couldn't save this session: ${(err as Error).message}` })
    return false
  }
}

export function loadSession(id: string): SavedSession {
  const data = fs.readFileSync(fileOf(id))
  let json: string
  try {
    json = safeStorage.decryptString(data)
  } catch {
    throw new Error(isMac ? 'it was encrypted with a keychain key this Mac no longer has' : "it was encrypted for a Windows account that can't unlock it anymore")
  }
  const r = parseRecord(json)
  // "processing" left on disk by a quit before or during generation: it's failed, and can be retried.
  return r.notesStatus === 'processing' && !generating.has(id) && endedId !== id ? { ...r, notesStatus: 'failed', notesError: 'interrupted' } : r
}

function tryLoad(id: string): SavedSession | null {
  try {
    return loadSession(id)
  } catch {
    return null
  }
}

/** Each file's summary (null: unreadable) as of its modified time, so listing only decrypts files that changed. */
const summaries = new Map<string, { mtimeMs: number; summary: SessionSummary | null }>()

function summaryOf(f: string): SessionSummary | null {
  const id = f.slice(0, -'.glint'.length)
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(path.join(dir(), f)).mtimeMs
  } catch {}
  const hit = summaries.get(id)
  if (hit && hit.mtimeMs === mtimeMs) return hit.summary
  const r = tryLoad(id)
  // "processing" left on disk by a quit mid-generation: show it as failed so it can be retried.
  const summary = r && { id: r.id, startedAt: r.startedAt, endedAt: r.endedAt, elapsedMs: r.elapsedMs, ...notesOf(r) }
  summaries.set(id, { mtimeMs, summary })
  return summary
}

/** Unreadable files are left on disk, logged and counted, so the dashboard can say some are missing and why. */
export function listSessions(): { sessions: SessionSummary[]; unreadable: number } {
  let files: string[] = []
  try {
    files = fs.readdirSync(dir()).filter((f) => f.endsWith('.glint'))
  } catch {
    return { sessions: [], unreadable: 0 }
  }
  let unreadable = 0
  const sessions = files
    .flatMap((f) => {
      const summary = summaryOf(f)
      if (!summary) {
        console.warn(`[history] skipping unreadable ${f}`)
        unreadable++
        return []
      }
      return [summary]
    })
    .sort((a, b) => b.startedAt - a.startedAt)
  return { sessions, unreadable }
}

/**
 * New action items from the notes, each owner matched to a person in the session where one fits. An item the user
 * already had keeps its id, tick and dates, and its owner if they reassigned it.
 */
function mergeActions(had: ActionItem[], found: Omit<ActionItem, 'id' | 'done'>[], labels: Record<string, string>): ActionItem[] {
  const old = new Map(had.map((a) => [a.text.trim().toLowerCase(), a]))
  return found.map((a) => {
    const prev = old.get(a.text.trim().toLowerCase())
    const owner = prev?.ownerByUser ? { owner: prev.owner, ownerId: prev.ownerId, ownerByUser: true } : { owner: a.owner, ownerId: personFor(a.owner, labels) }
    const suggested = a.suggested ?? prev?.suggested
    return { ...a, ...owner, id: prev?.id ?? randomUUID(), due: prev?.due ?? a.due, time: prev?.time ?? a.time, done: prev?.done, ...(suggested && { suggested }) }
  })
}

/** A person's label in a saved session, renamed by hand from its notes. Their voice isn't saved; only the label. */
export function renameSpeaker(sessionId: string, speakerId: string, name: unknown) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
  if (!n) throw new Error('Type a name first.')
  relabelSpeaker(sessionId, speakerId, speakerId, n)
}

/** The user ticked an item or changed its date. */
export function updateActions(id: string, list: unknown) {
  const r = loadSession(id)
  write({ ...r, actions: cleanActions(list) })
}

/** Opens the open, dated action items in the default calendar app, which asks which calendar to add them to. */
export async function addToCalendar(id: string): Promise<number> {
  const r = loadSession(id)
  const items = (r.actions ?? []).filter((a) => a.due && !a.done)
  if (!items.length) throw new Error('No open action item has a date. Give one a date first.')
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'glint-')) // removed an hour later, at the next launch
  const file = path.join(tmp, 'Action items.ics')
  // Everyone by their current name, as the notes show them.
  const named = items.map((a) => ({ ...a, text: renamed(a.text, r), owner: ownerName(a, r) }))
  await fs.promises.writeFile(file, actionsToIcs(named, r.title || 'Meeting', new Date()))
  const err = await shell.openPath(file)
  if (err) throw new Error(`Couldn't open Calendar: ${err}`)
  return items.length
}

/** Drafts the follow-up email from the notes, action items and transcript, and keeps it with the session. */
/** `onPartial`: the draft so far, at most every 80 ms while it streams. */
export async function draftFollowUp(id: string, onPartial?: (d: { subject: string; body: string }) => void): Promise<{ subject: string; body: string }> {
  const r = loadSession(id)
  // Everyone by their current name, including people named after the notes were written.
  const prompt = followUpPrompt({
    ...r,
    summary: r.summary && renamed(r.summary, r),
    actions: r.actions?.map((a) => ({ ...a, owner: ownerName(a, r) })),
    transcript: transcriptText(r.transcript, r.speakers),
    day: meetingDay(r.startedAt),
  })
  let sent = 0
  const onText = (soFar: string) => {
    if (!onPartial || Date.now() - sent < 80) return
    const d = parseFollowUpPartial(soFar)
    if (d) (onPartial(d), (sent = Date.now()))
  }
  // A humanized email isn't shown as it's drafted: it appears once the service has rewritten it.
  const h = getState().humanizer
  const rewrite = h.service !== 'none' && h.on && h.apply.email
  let draft = parseFollowUp(await complete(getState().ai, [FOLLOW_UP_SYSTEM_PROMPT], prompt, { effort: 'fast', onText: rewrite ? undefined : onText }))
  if (!draft) throw new Error("The AI's reply wasn't an email. Try again.")
  if (rewrite) {
    try {
      const out = await humanize(draft.body, new AbortController().signal)
      if (!('short' in out)) draft = { ...draft, body: out.text }
    } catch (err) {
      patchState({ aiFailure: failureLine((err as Error).message) }) // loud, and the email as drafted is kept
    }
  }
  const cur = tryLoad(id)
  if (cur) write({ ...cur, followUp: draft })
  return draft
}

export function updateNotes(id: string, fields: { title?: string; summary?: string }) {
  const r = loadSession(id)
  const title = typeof fields.title === 'string' ? fields.title.trim().slice(0, 120) : r.title
  const summary = typeof fields.summary === 'string' ? fields.summary.slice(0, 50_000) : r.summary
  if (title === r.title && summary === r.summary) return
  write({ ...r, title, summary, edited: true })
}

/** Moves the (still encrypted) file to the OS Trash, so a mistaken delete can be undone there. */
export async function trashSession(id: string) {
  if (getState().session?.id === id) throw new Error("Stop the session before deleting it.")
  trashed.add(id) // before the move: a save landing meanwhile would write the file back
  await shell.trashItem(fileOf(id)).catch((err) => {
    trashed.delete(id)
    throw err
  })
  if (getState().lastSessionId === id) patchState({ lastSessionId: newestId() })
  patchState({ historyVersion: getState().historyVersion + 1 })
}

const generating = new Set<string>()
let scheduledNotes = 0
/** Notes are being written, or about to be for a session that just ended. An update's restart waits for them. */
export const notesPending = () => scheduledNotes > 0 || generating.size > 0

/** When the Mac last went to sleep, whether it's asleep now, and notes that sleep cut off, to write when it wakes. */
let sleptAt = 0
let asleep = false
const afterWake = new Set<string>()
export function macSleeps() {
  sleptAt = Date.now()
  asleep = true
}
export function macWakes() {
  asleep = false
  for (const id of afterWake) retryAfterWake(id)
  afterWake.clear()
}
/** The network is usually back a few seconds after waking. */
const retryAfterWake = (id: string) => (asleep ? afterWake.add(id) : setTimeout(() => void generateNotes(id), 10_000))

export async function generateNotes(id: string) {
  if (generating.has(id) || getState().session?.id === id) return // live sessions get notes when they end
  const r = tryLoad(id)
  if (!r || (!r.transcript.length && !r.messages.some((m) => m.role === 'user'))) return
  const started = Date.now()
  generating.add(id)
  write({ ...r, notesStatus: 'processing', notesError: undefined })
  try {
    const reply = await complete(getState().ai, [NOTES_SYSTEM_PROMPT], notesPrompt(transcriptText(r.transcript, r.speakers), r.messages, meetingDay(r.startedAt)))
    const labels = { me: 'Me', ...r.speakers } // the names the transcript gave the model
    const notes = parseNotes(reply)
    if (!notes) throw new Error("the reply wasn't in the expected format")
    const cur = tryLoad(id) // re-read: chat may have been added, or the user edited meanwhile
    if (!cur) return // deleted meanwhile: writing would bring it back
    write({
      ...cur,
      title: cur.edited && cur.title ? cur.title : notes.title,
      summary: cur.edited && cur.summary ? cur.summary : notes.summary,
      tags: notes.tags,
      notesLabels: labels,
      actions: mergeActions(cur.actions ?? [], notes.actions, labels),
      notesStatus: 'done',
      notesError: undefined,
    })
    patchState({ notesReady: { id, title: (cur.edited && cur.title) || notes.title } })
  } catch (err) {
    console.error('[history] notes failed:', err)
    // Cut off by the Mac sleeping (the lid closing): written again once it's awake, not left failed.
    const slept = sleptAt >= started
    const cur = tryLoad(id)
    if (cur) write({ ...cur, notesStatus: 'failed', notesError: slept ? `the ${COMPUTER} went to sleep while they were being written; trying again once it's awake` : (err as Error).message })
    if (slept && cur) retryAfterWake(id)
  } finally {
    generating.delete(id)
  }
}

/** A voice named after its session ended: relabel that session's saved lines with the person. */
export function relabelSpeaker(sessionId: string, voiceId: string, personId: string, name: string) {
  const r = tryLoad(sessionId)
  if (!r?.speakers?.[voiceId]) return
  const { [voiceId]: _, ...rest } = r.speakers
  // The notes' labels and owners move to the new id too, so they show the new name (see `renamed`).
  const { [voiceId]: label, ...labels } = r.notesLabels ?? {}
  write({
    ...r,
    speakers: { ...rest, [personId]: name },
    transcript: r.transcript.map((t) => (t.speaker === voiceId ? { ...t, speaker: personId } : t)),
    ...(r.notesLabels && { notesLabels: label === undefined ? labels : { ...labels, [personId]: label } }),
    ...(r.actions && { actions: r.actions.map((a) => (a.ownerId === voiceId ? { ...a, ownerId: personId } : a)) }),
  })
}

export function resumeSession(id: string): Session {
  const r = loadSession(id)
  firstStartedAt = { sessionId: r.id, at: r.startedAt }
  chat = { sessionId: r.id, messages: r.messages }
  return resumeFrom(r, Date.now())
}

function newestId(): string | null {
  try {
    const files = fs.readdirSync(dir()).filter((f) => f.endsWith('.glint') && !isChatId(f)) // chats can't be resumed as sessions
    const newest = files.map((f) => ({ f, t: fs.statSync(path.join(dir(), f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]
    return newest ? newest.f.slice(0, -'.glint'.length) : null
  } catch {
    return null
  }
}
