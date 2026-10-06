import { memo, useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react'
import { chatHistory, lastInstruction, lineLabel, type SavedMessage, type SavedSession } from '../../shared/history'
import { HUMANIZER_LABELS, humanizes, type HumanizeStatus, type HumanizerService } from '../../shared/humanize'
import { copyText, scrub, wholeSentences } from '../../shared/markdown'
import { autoAsk, composeNote, isRetry, lineKey, unsentLines, userPrompt } from '../../shared/prompt'
import {
  askEffort, formatElapsed, INACTIVITY_COUNTDOWN_S, INACTIVITY_MS, prettyAccelerator, type AiProvider, type State, type TranscriptItem,
} from '../../shared/state'
import { glint, isMac, opacityStyle, patch, useAppState, useGlass, useTick } from './glint'
import { SessionControls } from './ControlBar'
import { Dashboard } from './Dashboard'
import { Icon } from './icons'
import { Markdown, streamEvery } from './Markdown'
import { modelLabel, PROVIDER_LABELS, type Failure } from '../../shared/providers'
import { isQuestion } from '../../shared/speakers'
import { GhostPill } from './Ghost'
import { Glance, type Cue } from './Glance'
import { useCallCapture, useMicCapture, usePlayback } from './mic'
import { withNote } from './screenshotNote'
import { DashedEdge, Presence, Segmented, Toast } from './ui'

const EMPTY_ASK_LABEL = 'Assist'
const MOD = isMac ? '⌘' : 'Ctrl+'

interface Msg extends SavedMessage {
  /** undefined = capture pending, null = none */
  screenshot?: string | null
  done?: boolean
  /** When the reply was copied for you. */
  copiedAt?: number
  /** Glance answered the other side's question (`quote`, asked by `speaker`) on its own. */
  auto?: boolean
  quote?: string
  speaker?: string
  doneAt?: number
  /** Providers that failed before this reply, and who is trying or answered instead. */
  failures?: Failure[]
  switchingTo?: AiProvider
  answeredBy?: AiProvider
  /** User turns: the mode's files were searched for this ask (too big to send whole): what was sent. */
  searched?: { count: number; pages: string[]; text: string }
  /** No provider could answer: shown in red, never as "Nothing to add". */
  failed?: boolean
  /** The user stopped this reply, or a newer ask replaced it. */
  stopped?: boolean
  /** Screen context was on but no screenshot could be taken. */
  shotFailed?: boolean
  /** Replies: who was asked, in which mode, whether smart mode thought it through, and when it started and first spoke. */
  by?: AiProvider
  /** The model that answers, as shown ("Opus 5"). */
  model?: string
  mode?: string
  smart?: boolean
  startedAt?: number
  firstAt?: number
  /** Replies sent to the humanizer: where the rewrite stands. The text stays hidden until it's back. */
  hz?: HumanizeStatus
  /** The model's own text is shown in place of the rewrite. */
  showOriginal?: boolean
}

/** What main's ai:ask says about the rewrite, when the reply was sent to the humanizer. */
type Humanized = { text: string; words: number; ms: number } | { short: string } | { error: string } | { stopped: true }

/** Glance waits this long after a question ends, in case the same person keeps going. */
const SETTLE_MS = 600
/** Glance only answers questions this recent, so turning it on doesn't answer something from minutes ago. */
const QUESTION_MAX_AGE_MS = 30_000

const toSaved = (msgs: Msg[]): SavedMessage[] => msgs.map(({ id, role, text, original, sent, sentKeys, typed }) => ({ id, role, text, original, sent, sentKeys, typed }))
/** What a reply shows, and what Copy copies: the rewrite, or the model's own text when "Show original" is on. */
const shownText = (m: Msg) => (m.showOriginal && m.original !== undefined ? m.original : m.text)

export function ChatPanel() {
  const s = useAppState()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [error, setError] = useState<{ message: string; retry: () => void } | null>(null)
  const [activity, bumpActivity] = useReducer((n: number) => n + 1, 0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  /** Whether the body follows new text: true while it's scrolled to the bottom. */
  const pinned = useRef(true)
  /** The body's last scroll position: which way each scroll went. */
  const scrolledTo = useRef(0)
  /** Scrolled up from the newest line: offers a jump back down. */
  const [behind, setBehind] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  /** Session open in the dashboard's detail view; null = the list. */
  const [historyOpen, setHistoryOpen] = useState<string | null>(null)
  /** The input has focus: discreet mode shows the whole panel while the user types. */
  const [typing, setTyping] = useState(false)
  /** Compact capsule: the mode menu in the panel's session row is open. */
  const [modeOpen, setModeOpen] = useState(false)
  /**
   * Where this thread saves: its session (and still after the session ends, so follow-ups and a reply that was
   * streaming at Stop are kept), or a standalone chat.
   */
  const saveTo = useRef<{ session: string } | { chat: string }>({ chat: `chat-${crypto.randomUUID()}` })
  /** Oldest turns left out of what the model sees, once a chat grows very long (see chatHistory). */
  const dropped = useRef(0)

  useMicCapture(!!s?.session && !s.pause.paused, !!s?.roomMode && s.voiceprint === 'enrolled')
  useCallCapture(!!s?.session && !s.pause.paused)

  // Handlers fired from main (hotkeys) need the latest values without re-subscribing.
  const latest = useRef({ s, msgs, input, historyOpen })
  latest.current = { s, msgs, input, historyOpen }

  /** When the last ask started; Glance's automatic answers wait out a cooldown after it. */
  const lastAskAt = useRef(0)

  /**
   * `auto`: Glance answering a question by itself: no screenshot, never copied, and an empty reply doesn't count.
   * An ask with nothing typed helps with what's on screen or in the call now; it never re-sends an earlier question.
   */
  async function ask(textOverride?: string, opts: { auto?: { quote: string; speaker: string } } = {}) {
    const { s, msgs, input } = latest.current
    if (!s) return
    const auto = !!opts.auto
    const brief = auto || s.layout === 'glance'
    // Ghost: the answer is typed out by hand, so it comes back as only the text to type, thought through.
    const typeable = !auto && s.layout === 'ghost'
    // Ghost has no text box: ⌘↩ answers the screen, and a question comes from its own box (textOverride).
    const typedText = auto ? '' : (textOverride ?? (typeable ? '' : input)).trim()
    // A typed retry ("again") carries the instruction before it, so a mode's file search looks for the same thing.
    const repeat = !auto && isRetry(typedText) ? lastInstruction(msgs) : undefined
    // The model is told exactly which question an automatic answer is for.
    const text = auto ? autoAsk(opts.auto!.quote) : typedText
    const retry = () => void ask(textOverride ?? typedText, opts)
    const id = crypto.randomUUID()
    const replyId = `${id}:reply`
    lastAskAt.current = Date.now()
    if (!brief && !typeable) void patch({ chat: { visible: true, expanded: true, view: 'chat' } }) // the capsule's Ask can come with the panel hidden
    // ponytail: paywall check goes here once billing exists (spec §11d).

    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    // Humanized: the reply stays hidden while the model writes and the service rewrites, then shows once.
    const hzService = humanizes(s.humanizer, { brief, typeable }) ? (s.humanizer.service as HumanizerService) : null
    const withScreen = !auto && s.screenContext === 'on'
    const note = noteFor(s)
    const position = s.screenshotNote.position
    const screenshot = withScreen
      ? glint.invoke<string | null>('screenshot:capture')
          .then((url) => (url && note ? withNote(url, note, position) : url))
          .catch((err) => (console.error('[screenshot]', err), null))
      : Promise.resolve(null)

    setError(null)
    pinned.current = true // asking always shows the new reply
    if (!auto && textOverride === undefined) setInput('') // Retry keeps whatever is being typed
    setMsgs((m) => [
      ...m.map((x) => (x.role === 'assistant' ? { ...x, done: true } : x)),
      auto
        ? { id, role: 'user', text: `Auto answer to: ${opts.auto!.quote}`, screenshot: null, auto, quote: opts.auto!.quote, speaker: opts.auto!.speaker }
        : {
            id, role: 'user', text: typedText || EMPTY_ASK_LABEL,
            screenshot: withScreen ? undefined : null, quote: typedText || undefined, typed: typedText || undefined,
          },
      {
        id: replyId, role: 'assistant', text: '', by: s.ai.provider, mode: s.modes.find((m) => m.id === s.activeModeId)?.name,
        smart: askEffort(s, { brief, typeable }) === 'smart', model: modelLabel(s.ai, s.ai.provider, askEffort(s, { brief, typeable }) === 'smart'), startedAt: Date.now(),
        hz: hzService ? { service: hzService, stage: 'replying', ghost: typeable } : undefined,
      },
    ])
    // The chat keeps a small copy for its hover preview; the full image only goes with the ask.
    void screenshot.then(async (url) => {
      const thumb = url && (await thumbnail(url))
      setMsgs((m) => m.map((x) => (x.id === id ? { ...x, screenshot: thumb, shotFailed: withScreen && !url } : x)))
    })

    let reply = ''
    let frame = 0
    let shownAt = 0
    const show = () => {
      frame = 0
      shownAt = performance.now()
      const text = scrub(reply) // what's shown and saved; leaked markers can be split across chunks
      setMsgs((m) => m.map((x) => (x.id === replyId ? { ...x, text: x.hz ? x.text : text, firstAt: x.firstAt ?? Date.now() } : x)))
    }
    // At most one update a frame, and fewer as the reply grows: each render re-parses all of its markdown.
    const tick = () => {
      if (performance.now() - shownAt < streamEvery(reply.length)) frame = requestAnimationFrame(tick)
      else show()
    }
    const off = glint.on('ai:delta', (d: { id: string; text: string }) => {
      if (d.id !== id || ctrl.signal.aborted) return
      reply += d.text
      frame ||= requestAnimationFrame(tick)
    })
    const offSwitch = glint.on('ai:switch', (d: { id: string; failures: Failure[]; next: AiProvider }) => {
      if (d.id === id) setMsgs((m) => m.map((x) => (x.id === replyId ? { ...x, failures: d.failures, switchingTo: d.next } : x)))
    })
    const offHumanizing = glint.on('ai:humanizing', (d: { id: string; service: HumanizerService }) => {
      if (d.id === id) setMsgs((m) => m.map((x) => (x.id === replyId ? { ...x, hz: { service: d.service, stage: 'humanizing', ghost: typeable } } : x)))
    })
    const offSearched = glint.on('ai:searched', (d: { id: string } & NonNullable<Msg['searched']>) => {
      if (d.id === id) setMsgs((m) => m.map((x) => (x.id === id ? { ...x, searched: { count: d.count, pages: d.pages, text: d.text } } : x)))
    })
    const cancel = () => glint.send('ai:cancel', id)
    ctrl.signal.addEventListener('abort', cancel)
    void patch({ chat: { isStreaming: true } })
    try {
      // Include speech up to this moment: main closes open segments and waits (bounded) for their text.
      // An automatic answer doesn't flush: that would cut off whoever is speaking now mid-line.
      const fresh = s.session && !auto ? (await glint.invoke('audio:flush'), await glint.invoke<State>('state:get')) : (latest.current.s ?? s)
      const shot = await screenshot
      if (ctrl.signal.aborted) return
      const lines = unsentLines(fresh.session?.transcript ?? [], msgs.flatMap((m) => m.sentKeys ?? []))
      const speakers = fresh.session?.speakers
      const transcript = lines.map((t) => ({ role: t.role, text: t.text ?? '', name: lineLabel(t, speakers, true) }))
      const hasSession = !!s.session
      const screenshotFailed = withScreen && !shot
      // The model only keeps context through history, so user turns carry the full prompt they were sent.
      const sent = userPrompt({ text, transcript, hasSession, screenshotFailed })
      setMsgs((m) => m.map((x) => (x.id === id ? { ...x, sent } : x)))
      const h = chatHistory(msgs, dropped.current)
      dropped.current = h.dropped
      const r = await glint.invoke<{ provider: AiProvider; failures: Failure[]; humanized?: Humanized }>('ai:ask', {
        id, text, screenshot: shot, transcript, history: h.history, hasSession, screenshotFailed, brief, typeable, repeat,
      })
      if (ctrl.signal.aborted) return // stopped: not delivered, so its lines go with the next ask
      if (r?.failures.length) {
        setMsgs((m) => m.map((x) => (x.id === replyId
          ? { ...x, failures: r.failures, answeredBy: r.provider, switchingTo: undefined, model: modelLabel(s.ai, r.provider, !!x.smart) } : x)))
      }
      // Answered: only now are these lines "sent", and only now does this turn join the history the model sees.
      setMsgs((m) => m.map((x) => (x.id === id ? { ...x, sentKeys: lines.map(lineKey) } : x)))
      // The rewrite arrives whole; the model's text is kept as the original. Too short or failed: the original shows.
      const original = scrub(reply)
      const hz = r.humanized
      const shown = hz && 'text' in hz ? hz.text : original
      setMsgs((m) => m.map((x) => (x.id !== replyId || !x.hz ? x
        : !hz ? { ...x, text: original, hz: undefined }
        : 'text' in hz ? { ...x, text: hz.text, original, hz: { ...x.hz, stage: 'done', words: hz.words, ms: hz.ms } }
        : { ...x, text: original, hz: { ...x.hz, ...('short' in hz ? { stage: 'short', note: hz.short } : { stage: 'failed', note: 'error' in hz ? hz.error : undefined }) } })))
      const mode = latest.current.s?.autoCopy ?? 'off'
      if (!auto && !typeable && mode !== 'off' && shown.trim() && !ctrl.signal.aborted) {
        glint.send('app:copy', copyText(shown, mode))
        setMsgs((m) => m.map((x) => (x.id === replyId ? { ...x, copiedAt: Date.now() } : x)))
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setError({ message: err instanceof Error ? err.message : String(err), retry })
        setMsgs((m) => m.map((x) => (x.id === replyId ? { ...x, failed: true, switchingTo: undefined } : x)))
      }
    } finally {
      off()
      if (frame) (cancelAnimationFrame(frame), show()) // the last words, before the reply is marked done
      offSwitch()
      offHumanizing()
      offSearched()
      ctrl.signal.removeEventListener('abort', cancel)
      const stopped = ctrl.signal.aborted
      // Stopped or failed before the rewrite came back: what the model wrote shows, as a reply without one would.
      const unsettled = (x: Msg) => x.hz?.stage === 'replying' || x.hz?.stage === 'humanizing'
      setMsgs((m) => m.map((x) => (x.id !== replyId ? x : {
        ...x, done: true, doneAt: Date.now(), stopped,
        ...(unsettled(x) && { text: scrub(reply), hz: stopped && x.hz!.stage === 'humanizing' && reply.trim() ? { ...x.hz!, stage: 'stopped' as const } : undefined }),
      })))
      if (abortRef.current === ctrl) {
        abortRef.current = null
        void patch({ chat: { isStreaming: false } })
      }
    }
  }

  function stop() {
    abortRef.current?.abort()
    abortRef.current = null
    void patch({ chat: { isStreaming: false } })
  }

  function saveChat() {
    const { msgs } = latest.current
    if (!msgs.length) return
    const to = saveTo.current
    if ('session' in to && loadedFor.current !== to.session) return // its saved chat never loaded: this would replace it
    if ('session' in to) glint.send('session:messages', { sessionId: to.session, messages: toSaved(msgs) })
    else glint.send('chat:messages', { id: to.chat, messages: toSaved(msgs) })
  }

  function newChat() {
    stop()
    saveChat() // flush the pending save of the chat being left
    saveTo.current = { chat: `chat-${crypto.randomUUID()}` }
    dropped.current = 0
    lineSeen.clear() // the old thread's lines and messages won't show again
    firstShown.clear()
    setMsgs([])
    setError(null)
    void patch({ chat: { view: 'chat' } })
  }

  function continueChat(r: SavedSession) {
    // Already open: the panel is newer than the saved copy (a reply may still be streaming or unsaved).
    const to = saveTo.current
    if ('chat' in to && r.id === to.chat) return void patch({ chat: { view: 'chat' } })
    newChat()
    saveTo.current = { chat: r.id }
    setMsgs(r.messages.map((m) => ({ ...m, screenshot: null, done: true })))
  }

  useEffect(() => {
    const offs = [
      glint.on('chat:submit', () => void ask()), // ask reads everything through `latest`
      glint.on('chat:stop', () => stop()),
      glint.on('chat:focus', () => void focusInput()), // the capsule's chat-box button
      glint.on('chat:scroll', (dy: number) => bodyRef.current?.scrollBy({ top: dy, behavior: 'smooth' })),
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // A new session starts a new chat; a resumed one loads its saved chat first.
  const sessionId = s?.session?.id
  const prevSession = useRef(sessionId)
  /** Session whose chat is safe to save: a resumed chat must load before it can overwrite what's on disk. */
  const loadedFor = useRef<string | undefined>(undefined)
  useEffect(() => {
    const prev = prevSession.current
    prevSession.current = sessionId
    if (sessionId === prev) return
    // Final save for the session that just ended, including an answer that was still streaming.
    if (prev && loadedFor.current === prev && latest.current.msgs.length) {
      glint.send('session:messages', { sessionId: prev, messages: toSaved(latest.current.msgs) })
    }
    if (prev && !sessionId) setHistoryOpen(prev) // main opens the dashboard on end: show this session's notes
    if (!sessionId) return // the thread keeps saving into the session that just ended
    newChat()
    saveTo.current = { session: sessionId }
    if (!latest.current.s?.session?.isResumed) return void (loadedFor.current = sessionId)
    void glint.invoke<SavedSession | null>('session:load', sessionId).then(
      (r) => {
        if (latest.current.s?.session?.id !== sessionId) return // stopped or replaced meanwhile
        loadedFor.current = sessionId
        if (!r) return // its file is gone (trashed meanwhile): nothing to restore, and this thread saves as its chat
        setMsgs((cur) => [...r.messages.map((m) => ({ ...m, screenshot: null, done: true })), ...cur]) // keep asks made while loading
      },
      (err: Error) => void patch({ audioError: `Couldn't load this session's chat: ${err.message}` }),
    )
  }, [sessionId])

  // Saves the thread once the reply pauses: into its session (a resumed one only after its saved chat has loaded,
  // so it can't be overwritten), or as a standalone chat.
  useEffect(() => {
    const to = saveTo.current
    if (!msgs.length || ('session' in to && loadedFor.current !== to.session)) return
    const t = setTimeout(saveChat, 500)
    return () => clearTimeout(t)
  }, [sessionId, msgs])

  // Glance answers the other side's questions by itself: once a recent "them" line that reads as a question has
  // finished and they've stopped talking, unless an ask happened within the cooldown. Unsure lines never count.
  const considered = useRef(new Set<string>())
  const transcript = s?.session?.transcript
  const themTalking = !!s?.voiceActivity.them
  const autoOn = !!s && s.layout === 'glance' && s.glance.autoAnswer && !!s.session && !s.pause.paused
  useEffect(() => {
    if (!autoOn || !transcript) return
    const q = [...transcript].reverse().find((t) => t.role === 'them' && t.status === 'ready' && t.sure !== false)
    if (!q?.text || considered.current.has(lineKey(q)) || Date.now() - Date.parse(q.at) > QUESTION_MAX_AGE_MS) return
    const timer = setTimeout(() => {
      const cur = latest.current.s
      if (!cur || cur.voiceActivity.them) return // still talking: this runs again when they stop
      considered.current.add(lineKey(q))
      if (!isQuestion(q.text!) || cur.chat.isStreaming) return
      if (Date.now() - lastAskAt.current < cur.glance.cooldownS * 1000) return
      void ask(undefined, { auto: { quote: q.text!, speaker: lineLabel(q, cur.session?.speakers) } })
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [autoOn, transcript, themTalking])

  // Inactivity timer: resets on session, transcript or message changes, and on any interaction. Any of those
  // also cancels a countdown already showing. A paused session doesn't time out; pausing is deliberate. Neither does
  // one in Ghost: it has nowhere to show the countdown, and showing the overlay would undo the user hiding it.
  const transcriptLen = s?.session?.transcript.length ?? 0
  const paused = !!s?.pause.paused
  const layout = s?.layout
  useEffect(() => {
    if (latest.current.s?.inactivityPrompt) void patch({ inactivityPrompt: false })
    if (!sessionId || paused || layout === 'ghost') return
    const t = setTimeout(() => void patch({ inactivityPrompt: true, overlayVisible: true, chat: { visible: true, expanded: true } }), INACTIVITY_MS)
    return () => clearTimeout(t)
  }, [sessionId, paused, transcriptLen, msgs.length, activity, layout])

  // Chat and transcript follow new text while scrolled to the bottom. Scrolling up to read stops that until the
  // user scrolls back down; opening either view starts at the newest line. History never moves on its own.
  const view = s?.chat.expanded ? s.chat.view : null
  useLayoutEffect(() => {
    pinned.current = true
    setBehind(false)
  }, [view])
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el || !pinned.current || view === 'dashboard') return
    // New transcript lines glide the older ones up; chat follows streaming text exactly.
    const glide = view === 'transcript' && el.scrollTop > 0 && !matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: el.scrollHeight, behavior: glide ? 'smooth' : 'instant' })
  }, [view, msgs, s?.session?.transcript, s?.sttStatus, s?.liveWords])
  // Lines that arrive while the transcript isn't showing aren't new when it opens.
  useEffect(() => {
    if (view === 'transcript') return
    for (const t of s?.session?.transcript ?? []) if (!lineSeen.has(lineKey(t))) lineSeen.set(lineKey(t), 0)
  }, [view, s?.session?.transcript])

  // Always ask main: Chromium's document.hasFocus() can be true while macOS hasn't made the panel key.
  async function focusInput() {
    if (await glint.invoke<boolean>('window:focus-chat')) inputRef.current?.focus()
  }

  function back(): boolean {
    const chat = latest.current.s?.chat
    if (chat?.view === 'dashboard' && latest.current.historyOpen) return setHistoryOpen(null), true
    if (chat?.view !== 'chat') return void patch({ chat: { view: 'chat' } }), true
    if (chat.expanded) return void patch({ chat: { expanded: false } }), true
    return false
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only the full panel has these keys: Glance and Ghost draw none of it (Ghost's question box has its own Esc).
      // A key that's part of an input method's composition (Esc cancelling it, say) is the IME's.
      if (latest.current.s?.layout !== 'full' || e.isComposing) return
      const mod = glint.platform === 'darwin' ? e.metaKey : e.ctrlKey
      // Tab jumps to typing, and from the box opens a collapsed panel. Otherwise it moves focus as usual, so the
      // buttons can be reached.
      const inBox = document.activeElement === inputRef.current
      if (e.key === 'Tab' && !e.shiftKey && (document.activeElement === document.body || (inBox && !latest.current.s?.chat.expanded))) {
        e.preventDefault()
        void patch({ chat: { expanded: true } })
        void focusInput()
      } else if (e.key === 'Escape') {
        // Back, then blur (focus returns to the user's app), then hide.
        if (back()) return
        if (inBox) {
          inputRef.current?.blur()
          glint.send('window:blur-chat')
        } else void patch({ chat: { visible: false } })
      } else if (e.key === 'ArrowDown' && e.target === inputRef.current && !latest.current.input) {
        e.preventDefault()
        void patch({ chat: { expanded: true, view: 'dashboard' } })
      } else if (e.key === 'Backspace' && e.target === inputRef.current && !latest.current.input && !e.repeat) {
        back() // not on key repeat: holding Backspace to clear the box mustn't go on to close things
      } else if (mod && e.key.toLowerCase() === 't') {
        e.preventDefault()
        void patch({ chat: { expanded: true, view: 'transcript' } })
      } else if (mod && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        if (!latest.current.s?.session) newChat()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // No key focus, so Esc can't close the mode menu; a click anywhere else does.
  useEffect(() => {
    if (!modeOpen) return
    const onDown = (e: PointerEvent) => !(e.target as Element).closest('.popover, [aria-haspopup]') && setModeOpen(false)
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [modeOpen])

  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 56)}px`
  }, [input])

  // The collapsed panel (input and notices) is as tall as its content, plus a tooltip below it while one shows (there's
  // no room above: the capsule is there); main sizes the window to it.
  const panelRef = useRef<HTMLDivElement>(null)
  const collapsed = !!s && s.layout === 'full' && !s.chat.expanded
  // Frosted glass behind the panel, or behind Ghost's strip and card, which stay pinned to their corner's side.
  const ghost = s?.layout === 'ghost'
  useGlass(ghost ? '.ghost :is(.glance-strip, .glance-card)' : '.panel', isMac && (ghost || s?.layout === 'full'),
    ghost ? (s.glance.corner.endsWith('right') ? 1 : 0) : 0.5)
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!collapsed || !el) return
    let last = 0
    const send = () => {
      const tip = document.querySelector<HTMLElement>('.tip') // fixed: offsetTop is from the window's top
      // The session row's mode menu hangs below a short panel. Layout sizes: its opening scale must not shrink the window.
      const menu = el.querySelector<HTMLElement>('.popover')
      let menuBottom = 0
      for (let n: HTMLElement | null = menu; n; n = n.offsetParent as HTMLElement | null) menuBottom += n.offsetTop
      if (menu) menuBottom += menu.offsetHeight + 6
      const h = Math.ceil(Math.max(el.offsetHeight + 6, tip ? tip.offsetTop + tip.offsetHeight + 6 : 0, menuBottom)) // + the body's padding (styles.css)
      if (h !== last) glint.send('window:panel-height', (last = h)) // the observer fires on every keystroke and animation
    }
    send()
    const ro = new ResizeObserver(send)
    ro.observe(el)
    // A tooltip comes and goes outside this component, and is placed after it renders.
    const mo = new MutationObserver(send)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
    return () => (ro.disconnect(), mo.disconnect())
  }, [collapsed])

  if (!s) return null
  const { chat } = s

  if (s.layout === 'ghost') {
    const replies = msgs.filter((m) => m.role === 'assistant' && !m.failed && (m.text.trim() || !m.done))
    const open = () => void patch({ layout: 'full', overlayVisible: true, chat: { visible: true, expanded: true, view: 'chat' } })
    return <GhostPill s={s} replies={replies} error={error?.message ?? null} onOpen={open} onAsk={(q) => void ask(q)} />
  }

  if (s.layout === 'glance') {
    const reply = [...msgs].reverse().find((m) => m.role === 'assistant')
    const asked = reply && msgs.find((m) => `${m.id}:reply` === reply.id)
    const askKey = s.shortcuts.ask ? prettyAccelerator(s.shortcuts.ask, isMac) : 'the shortcut'
    const meta = asked?.auto ? [asked.speaker, asked.quote && `"${asked.quote}"`].filter(Boolean).join(' · ')
      : reply && `${reply.model ?? PROVIDER_LABELS[reply.answeredBy ?? reply.by ?? s.ai.provider]} · you asked with ${askKey}`
    const hz = reply?.hz && (reply.hz.stage === 'humanizing' ? `Humanizing with ${HUMANIZER_LABELS[reply.hz.service]}…` : reply.hz.stage === 'done' ? `Humanized by ${HUMANIZER_LABELS[reply.hz.service]}` : null)
    const cue: Cue | null = reply ? { id: reply.id, text: shownText(reply), meta: [meta, hz].filter(Boolean).join(' · '), done: !!reply.done, at: reply.doneAt ?? Date.now() } : null
    const open = () => void patch({ layout: 'full', overlayVisible: true, chat: { visible: true, expanded: true, view: 'chat' } })
    return (
      <Glance s={s} cue={cue} error={error?.message ?? null} onOpen={open}>
        {s.inactivityPrompt && s.session ? <InactivityPrompt compact />
          : s.callDetected && !s.session && (
            <div className="glance-strip idle-strip">{s.callDetected} call started
              <button className="keep" onClick={() => glint.send('session:start')}>Take notes</button>
              <button className="link" onClick={() => glint.send('call:dismiss')}>Not now</button>
            </div>
          )}
      </Glance>
    )
  }

  const failing = !!(error || s.aiFailure || s.audioError)
  const typingLocked = s.isInvisible && s.lockFocusWhenInvisible
  const updateReady = s.update.status === 'available'
  // A session's page draws its own header in place of the panel's.
  const detailOpen = chat.expanded && chat.view === 'dashboard' && !!historyOpen
  return (
    <div ref={panelRef} className={`panel surface ${collapsed ? 'collapsed' : ''} ${s.isInvisible ? '' : 'on-share'} ${failing ? 'failing' : ''} ${s.discreet && !typing && !failing ? 'faded' : ''}`}
      style={opacityStyle(s.opacity)}
      onPointerDown={bumpActivity} onKeyDown={bumpActivity}>
      <DashedEdge />
      {!detailOpen && (
        <div className="panel-head">
          <Segmented tabs label="View" value={collapsed ? null : chat.view}
            onChange={(v) => patch({ chat: collapsed ? { expanded: true, view: v } : chat.view === 'chat' && v === 'chat' ? { expanded: false } : { view: v } })}
            options={[
              { value: 'chat', label: 'Chat', tip: collapsed ? 'Open the chat' : chat.view === 'chat' ? 'Collapse the panel to the input' : 'Your questions and answers' },
              { value: 'transcript', label: 'Transcript', tip: `The live transcript (${MOD}T)` },
              { value: 'dashboard', label: 'History', tip: 'Past sessions and chats, with notes and follow-ups' },
            ]} />
          <span className="grow" />
          {collapsed || chat.view === 'chat' ? (
            <>
              <button className="icon-btn" aria-label="New chat" disabled={!!s.session} onClick={newChat}
                data-tip={s.session ? 'New chat: not during a session; its chat stays with the session' : `Start a new chat (${MOD}R)`}>
                <Icon name="plus" />
              </button>
              <button className="icon-btn" aria-label={updateReady ? 'Settings, update available' : 'Settings'} data-tip={updateReady ? 'Settings: an update is ready to install' : 'Settings'}
                onClick={() => glint.send('window:open-settings', updateReady ? 'general' : undefined)}>
                <Icon name="gear" />
                {updateReady && <span className="badge update" />}
              </button>
            </>
          ) : chat.view === 'transcript' ? <kbd className="view-key">{MOD}T</kbd> : (
            <button className="open-window" data-tip="Notes, action items and the email for every session, in a window"
              onClick={() => glint.send('window:open-followup', historyOpen ?? undefined)}>
              <Icon name="external" />Open window
            </button>
          )}
        </div>
      )}

      {s.compactBar && !s.practicing && (
        <div className={`session-row ${s.aiFailure ?? s.audioError ? 'failing' : ''}`}>
          <SessionControls s={s} modeOpen={modeOpen} onMode={setModeOpen} />
        </div>
      )}

      {error && (
        <Toast className="fail" role="alert" onDismiss={() => setError(null)}>
          <span><b>The AI failed.</b> {error.message}</span>
          <button data-tip="Ask the same thing again" onClick={error.retry}>Retry</button>
          <button data-tip="Change the provider, key or model" onClick={() => glint.send('window:open-settings', 'ai')}>AI settings</button>
          <button onClick={() => setError(null)}>Dismiss</button>
        </Toast>
      )}
      {s.inactivityPrompt && s.session && <InactivityPrompt />}
      {s.notesReady && !s.session && (
        <Toast className="notice" onDismiss={() => glint.send('notes:dismiss')}>
          <Icon name="check" size={14} />
          <span>Notes ready: <b>{s.notesReady.title}</b></span>
          <button onClick={() => glint.send('window:open-followup', s.notesReady!.id)}>Open</button>
          <button onClick={() => glint.send('notes:dismiss')}>Dismiss</button>
        </Toast>
      )}

      {chat.expanded && (
        <div className="body" ref={bodyRef} onScroll={(e) => {
          const el = e.currentTarget
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight
          // Only the user scrolls up, so any step up stops following (unless it's text shrinking at the bottom); a
          // step down never does, so the transcript's smooth glide doesn't read as scrolled away halfway.
          pinned.current = el.scrollTop < scrolledTo.current ? gap < 2 : pinned.current || gap < 40
          scrolledTo.current = el.scrollTop
          if (behind === pinned.current) setBehind(!pinned.current)
        }}>
          {chat.view === 'transcript' ? <Transcript items={s.session?.transcript ?? []} speakers={s.session?.speakers} people={s.people} status={s.sttStatus} live={!!s.session} liveWords={s.liveWords} />
            : chat.view === 'dashboard' ? <Dashboard s={s} openId={historyOpen} setOpenId={setHistoryOpen} onContinue={continueChat} />
            : <Thread msgs={msgs} discreet={s.discreet} setOriginal={(id) => setMsgs((m) => m.map((x) => (x.id === id ? { ...x, showOriginal: !x.showOriginal } : x)))} />}
        </div>
      )}
      {chat.expanded && behind && chat.view !== 'dashboard' && (
        <button className="jump" onClick={() => {
          pinned.current = true
          bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
        }}><Icon name="arrowDown" size={15} />Latest</button>
      )}

      {!(chat.expanded && chat.view === 'dashboard') && <div className="input-row">
        <div className="field">
          <textarea
            ref={inputRef}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            rows={1}
            value={input}
            placeholder={typingLocked ? 'Typing is off while invisible · click to change it in Settings'
              : s.session ? 'Ask about the conversation…' : 'Ask about your screen…'}
            onChange={(e) => setInput(e.target.value)}
            // "Keep focus in other apps while invisible" blocks typing here; a click goes to that setting instead.
            onMouseDown={() => (typingLocked ? glint.send('window:open-settings', 'general') : void glint.invoke('window:focus-chat'))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void ask()
              }
            }}
          />
        </div>
        {/* One button that morphs between send and stop. */}
        <button className={`circle send ${chat.isStreaming ? 'stopping' : ''}`} aria-label={chat.isStreaming ? 'Stop' : 'Ask'}
          data-tip={chat.isStreaming ? 'Stop the reply' : `Ask (Enter). ${MOD}↩ asks from any app`}
          onClick={chat.isStreaming ? stop : () => void ask()}>
          <span key={chat.isStreaming ? 'stop' : 'send'} className="swap">{chat.isStreaming ? <i className="stop-square" /> : <Icon name="arrowUp" size={16} />}</span>
        </button>
        <button className={`circle toggle bulb ${s.smart ? 'on' : ''}`} aria-label="Smart mode" aria-pressed={s.smart}
          data-tip={s.smart ? 'Smart mode on: thinks it through and answers thoroughly (slower)' : 'Smart mode off: fast answers'}
          onClick={() => patch({ smart: !s.smart })}>
          <Icon name="bulb" filled={s.smart} />
        </button>
      </div>}

      {chat.expanded && chat.view !== 'dashboard' && ( // the dashboard has a fixed height
        <div
          className="resize"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            glint.send('window:resize-start')
          }}
          onPointerUp={() => glint.send('window:resize-end')}
          onLostPointerCapture={() => glint.send('window:resize-end')} // e.g. a system dialog took the pointer
        />
      )}
    </div>
  )
}

/** Flashes "Copied" for 1.5 s when clicked, and once when the reply was copied for you. */
function CopyReply({ text, copiedAt }: { text: string; copiedAt?: number }) {
  const [done, setDone] = useState(false)
  const flash = (ms = 1500) => (setDone(true), setTimeout(() => setDone(false), ms))
  useEffect(() => void (copiedAt && Date.now() - copiedAt < 1500 && flash(1500 - (Date.now() - copiedAt))), [copiedAt])
  return (
    <button className={`icon-btn copy ${done ? 'done' : ''}`} aria-label="Copy" data-tip={copiedAt ? 'Already copied for you. Click to copy again' : 'Copy this reply'}
      onClick={() => (glint.send('app:copy', copyText(text, 'reply')), flash())}>
      <span key={done ? 'done' : 'copy'} className="swap-fade"><Icon name={done ? 'check' : 'copy'} size={13} /></span>{done && <span className="copied">Copied</span>}
    </button>
  )
}

/** A screenshot as a JPEG sized for the 260 px hover preview (at 2x): megabytes less per ask the chat holds. */
function thumbnail(url: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const k = Math.min(1, 520 / img.width)
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * k)
      c.height = Math.round(img.height * k)
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      resolve(c.toDataURL('image/jpeg', 0.8))
    }
    img.onerror = () => resolve(url)
    img.src = url
  })
}

/** When each transcript line was first shown (0: it arrived while the transcript wasn't open). */
const lineSeen = new Map<string, number>()
const isNewLine = (t: TranscriptItem) => {
  const k = lineKey(t)
  if (!lineSeen.has(k)) lineSeen.set(k, Date.now())
  return Date.now() - lineSeen.get(k)! < 450
}

/** What a searched ask sent; the passages go into the page only while opened, since each can be ~120k characters. */
function SearchedNote({ searched }: { searched: NonNullable<Msg['searched']> }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="searched" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary><Icon name="search" size={12} /> {searchedLabel(searched)}</summary>
      {open && searched.text && <pre>{searched.text}</pre>}
    </details>
  )
}

/** "Searched your files: 14 passages, pages 212 to 240". */
function searchedLabel({ count, pages }: NonNullable<Msg['searched']>) {
  if (!count) return 'Searched your files: nothing matched'
  const where = pages.length > 1 ? `, pages ${pages[0]} to ${pages.at(-1)}` : pages.length ? `, page ${pages[0]}` : ''
  return `Searched your files: ${count} ${count === 1 ? 'passage' : 'passages'}${where}`
}

/** When each message was first shown: only new ones rise in, not the whole thread each time the Chat view opens. */
const firstShown = new Map<string, number>()
const isFresh = (id: string) => {
  if (!firstShown.has(id)) firstShown.set(id, Date.now())
  return Date.now() - firstShown.get(id)! < 450 // the class outlives the animation, so re-renders mid-way don't cut it
}

/** `discreet`: a streaming answer shows whole sentences only, so nothing ticks along word by word. */
function Thread({ msgs, discreet, setOriginal }: { msgs: Msg[]; discreet: boolean; setOriginal: (id: string) => void }) {
  if (!msgs.length) return <p className="empty">Press {MOD}↩ from anywhere to ask about your screen.</p>
  return (
    <>
      {msgs.map((m) =>
        m.role === 'user' ? (
          <div key={m.id} className={`msg user ${isFresh(m.id) ? 'fresh' : ''}`}>
            <div className="bubble">{m.text}</div>
            {m.shotFailed ? (
              <span className="used-screen error" role="alert"><Icon name="screen" size={12} /> Screenshot failed: check Screen Recording permission</span>
            ) : (m.screenshot !== null || !!m.sentKeys?.length) && (
              <span className="used-screen" tabIndex={m.screenshot ? 0 : undefined}>
                {m.screenshot !== null && <><Icon name="screen" size={12} /> {m.screenshot === undefined ? 'Capturing…' : 'Used screen'}</>}
                {m.screenshot !== null && !!m.sentKeys?.length && ' · '}
                {!!m.sentKeys?.length && `${m.sentKeys.length} new ${m.sentKeys.length === 1 ? 'line' : 'lines'}`}
                {m.screenshot && <img src={m.screenshot} alt="Screenshot sent with this message" />}
              </span>
            )}
            {m.searched && <SearchedNote searched={m.searched} />}
          </div>
        ) : (
          <div key={m.id} className={`msg assistant ${isFresh(m.id) ? 'fresh' : ''}`}>
            <ReplyHead m={m} onToggle={() => setOriginal(m.id)} />
            <div className={`text ${m.done ? '' : 'streaming'}`}>
              {!!m.failures?.length && <FailNote m={m} />}
              {m.hz?.stage === 'failed' && (
                <div className="fail-note" role="alert"><Icon name="person" size={12} /> <b>{HUMANIZER_LABELS[m.hz.service]} failed:</b> {m.hz.note}. Showing the original.</div>
              )}
              {m.text ? <Markdown text={discreet && !m.done ? wholeSentences(shownText(m)) : shownText(m)} streaming={!m.done} /> : m.failed ? <b className="error">No answer: the AI failed.</b>
                : m.stopped ? <em className="muted">Stopped.</em>
                : m.done ? <em className="muted">Nothing to add.</em> : <span className="caret" />}
              {m.text && m.stopped && !m.hz && <em className="muted"> (stopped)</em>}
            </div>
            {m.done && m.text && <CopyReply text={shownText(m)} copiedAt={m.copiedAt} />}
          </div>
        ),
      )}
    </>
  )
}

/**
 * "✦ Opus 5 · smart · thought for 6 s": the model that answers, and what it's doing now. A humanized reply adds the
 * person icon while the model writes, then the head says where the rewrite stands.
 */
function ReplyHead({ m, onToggle }: { m: Msg; onToggle: () => void }) {
  const thinking = !m.done && !m.firstAt && !!m.smart
  useTick(thinking)
  const secs = (to: number) => Math.max(0, Math.round((to - (m.startedAt ?? to)) / 1000))
  const who = m.answeredBy ?? m.by
  if (m.hz && m.hz.stage !== 'replying' && m.hz.stage !== 'failed') {
    const by = HUMANIZER_LABELS[m.hz.service]
    return (
      <div className={`reply-head hz ${m.hz.stage}`}>
        <Icon name="person" size={14} />
        {m.hz.stage === 'humanizing' ? (
          <>
            Humanizing with {by}… ·
            <button className="link" onClick={() => patch({ humanizer: m.hz!.ghost ? { ghost: false } : { on: false } })}
              data-tip={m.hz.ghost ? 'Clears "Always humanize in Ghost". This answer still finishes' : 'Switches the humanizer off. This answer still finishes'}>
              {m.hz.ghost ? 'Stop humanizing in Ghost for faster answers' : 'Turn off the humanizer for faster answers'}
            </button>
          </>
        ) : m.hz.stage === 'done' ? (
          <>
            {[`Humanized by ${by}`, m.hz.words !== undefined && `${m.hz.words.toLocaleString()} words`, m.hz.ms !== undefined && `${Math.max(1, Math.round(m.hz.ms / 1000))} s`].filter(Boolean).join(' · ')} ·
            <button className="link" onClick={onToggle}>{m.showOriginal ? 'Show humanized' : 'Show original'}</button>
          </>
        ) : m.hz.stage === 'short' ? `Too short to humanize (${m.hz.note})` : 'Humanizing stopped'}
      </div>
    )
  }
  const status = thinking ? `Thinking it through · ${secs(Date.now())} s`
    : !m.done ? 'answering'
    : m.smart && m.firstAt ? `smart · thought for ${secs(m.firstAt)} s` : null
  if (!who) return null
  return (
    <div className="reply-head">
      <Icon name={m.smart ? 'bulb' : 'logo'} size={m.smart ? 14 : 13} filled={m.smart} />
      {[m.model ?? PROVIDER_LABELS[who], status].filter(Boolean).join(' · ')}
      {m.hz?.stage === 'replying' && <span className="hz-mark" data-tip={`${HUMANIZER_LABELS[m.hz.service]} rewrites this once it's written`}><Icon name="person" size={13} /></span>}
    </div>
  )
}

/** Which providers failed before this reply, in red, and who is trying or answered instead. */
function FailNote({ m }: { m: Msg }) {
  return (
    <div className="fail-note" role="alert">
      {m.failures!.map((f) => <div key={f.provider}><b>{PROVIDER_LABELS[f.provider]} failed:</b> {f.error}</div>)}
      {m.answeredBy ? <div>Answered by {PROVIDER_LABELS[m.answeredBy]} instead.</div>
        : m.switchingTo && !m.done ? <div>Trying {PROVIDER_LABELS[m.switchingTo]}…</div> : null}
    </div>
  )
}

function Transcript({ items, speakers, people, status, live, liveWords }: {
  items: TranscriptItem[]; speakers?: Record<string, string>; people: State['people']; status: string | null; live: boolean
  liveWords: State['liveWords']
}) {
  /** Line (by `at`) whose speaker menu is open. */
  const [menuAt, setMenuAt] = useState<string | null>(null)
  // What each side is saying right now, before its line is transcribed.
  const speaking = live ? (['them', 'me'] as const).filter((r) => liveWords[r]) : []
  if (!items.length && !speaking.length) return <p className="empty">{status ?? (live ? 'Listening…' : 'Start a session to transcribe the call.')}</p>
  return (
    <>
      {status && <p className="muted">{status}</p>}
      {items.map((t) => {
        const open = menuAt === t.at
        return (
          <TranscriptLine key={lineKey(t)} t={t} fresh={isNewLine(t)} label={lineLabel(t, speakers)} named={people.some((p) => p.id === t.speaker)}
            menu={!!t.speaker && !!speakers?.[t.speaker]} open={open} onMenu={setMenuAt} speakers={speakers} people={people} />
        )
      })}
      {speaking.map((r) => (
        <div key={`live-${r}`} className={`line live ${r}`} aria-live="polite">
          <span className="ts" />
          <p><b className="who">{r === 'me' ? 'Me' : 'Them'}</b> {liveWords[r]}</p>
        </div>
      ))}
    </>
  )
}

/**
 * One transcript line. Memoized on what it shows, since every session update brings each line as a new object: a new
 * line or live words re-render only what changed, not an hour of transcript. The line with its menu open always does.
 */
const TranscriptLine = memo(function TranscriptLine({ t, fresh, label, named, menu, open, onMenu, speakers, people }: {
  t: TranscriptItem; fresh: boolean; label: string; named: boolean; menu: boolean; open: boolean
  onMenu: (at: string | null) => void; speakers?: Record<string, string>; people: State['people']
}) {
  const wrap = useRef<HTMLSpanElement>(null)
  return (
    <div className={`line ${t.status} ${t.role} ${fresh ? 'fresh' : ''} ${t.status === 'pending' && t.text ? 'heard' : ''}`}>
      <span className="ts">{formatElapsed(t.offsetMs)}</span>
      <p>
        {menu ? (
          <span className="who-wrap" ref={wrap}>
            <button className={`who ${named ? '' : 'unnamed'}`} aria-expanded={open}
              data-tip="Name this speaker, hear their voice, or merge them with another" onClick={() => onMenu(open ? null : t.at)}>
              {label}
            </button>
            <Presence open={open}>
              {(closing) => <SpeakerMenu id={t.speaker!} speakers={speakers!} people={people} closing={closing} wrap={wrap} onClose={() => onMenu(null)} />}
            </Presence>
          </span>
        ) : (
          <b className="who">{label}</b>
        )}{' '}
        {t.text ?? '…'}
      </p>
    </div>
  )
}, (a, b) => !a.open && !b.open && a.fresh === b.fresh && a.label === b.label && a.named === b.named && a.menu === b.menu
  && a.t.text === b.t.text && a.t.status === b.t.status && a.t.role === b.t.role && a.t.at === b.t.at
  && a.t.offsetMs === b.t.offsetMs && a.t.speaker === b.t.speaker)

/** A speaker's label, clicked: play their voice, name or rename them, guess their name, or merge them with another. */
function SpeakerMenu({ id, speakers, people, closing, wrap, onClose }: {
  id: string; speakers: Record<string, string>; people: State['people']; closing: boolean
  /** The menu and its label: a click on the label toggles it rather than closing it here and reopening it there. */
  wrap: RefObject<HTMLSpanElement | null>; onClose: () => void
}) {
  const [name, setName] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [why, setWhy] = useState('')
  const isPerson = (k: string) => people.some((p) => p.id === k)
  const others = Object.entries(speakers).filter(([k]) => k !== id)
  const act = (p: Promise<unknown>) => void p.then(onClose, (err: Error) => setError(err.message))
  const player = usePlayback()

  // The panel never has key focus, so Esc can't close this; any click outside does.
  useEffect(() => {
    const onDown = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && onClose()
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [])

  const merge = (into: string) => {
    // Two saved people: the one clicked is deleted, so ask once more.
    if (isPerson(id) && isPerson(into) && confirming !== into) return setConfirming(into)
    act(glint.invoke('voice:merge', id, into))
  }

  return (
    <div className={`menu speaker-menu ${closing ? 'closing' : ''}`} role="menu">
      <button role="menuitem" onClick={() => void player.toggle(id).then((ok) => ok || setError('No recording of this voice.'))}>
        <Icon name={player.playing === id ? 'pause' : 'play'} /> {player.playing === id ? 'Stop' : 'Play a clip'}
      </button>
      {name === null ? (
        <button role="menuitem" onMouseDown={() => void glint.invoke('window:focus-chat')} onClick={() => setName(isPerson(id) ? speakers[id] : '')}>
          <Icon name="edit" /> {isPerson(id) ? 'Rename…' : 'Name…'}
        </button>
      ) : (
        <form className="inline" onSubmit={(e) => (e.preventDefault(), act(glint.invoke(isPerson(id) ? 'people:rename' : 'voice:name', id, name)))}>
          <input type="text" autoFocus maxLength={40} value={name} placeholder="Their name" aria-label="Their name"
            onMouseDown={() => void glint.invoke('window:focus-chat')} onChange={(e) => setName(e.target.value)} />
          <button type="submit" disabled={!name.trim()}>Save</button>
        </form>
      )}
      <GuessButton id={id} role="menuitem" onGuess={(guess, note) => (setName(guess ?? name ?? ''), setWhy(note))} />
      {why && <p className="guess-why">{why}</p>}
      {!!others.length && (
        <>
          <hr />
          <span className="menu-label"><Icon name="merge" size={14} /> Merge with…</span>
          {others.map(([k, n]) => (
            <button key={k} role="menuitem" className={confirming === k ? 'danger' : ''} onClick={() => merge(k)}>
              {confirming === k ? `Merge into ${n}, deleting saved "${speakers[id]}"` : n}
            </button>
          ))}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

/** The note drawn on screenshots right now: the global one plus the active mode's. */
const noteFor = (s: State) => composeNote(s.screenshotNote.text, s.modes.find((m) => m.id === s.activeModeId)?.screenshotNote)

/**
 * Asks the model which name the conversation gives this speaker. It only fills in the name field: the user saves.
 * After a guess it reads "Guess: Priya", so the name shows where it came from.
 */
export function GuessButton({ id, onGuess, className, role }: {
  id: string; onGuess: (name: string | null, note: string) => void; className?: string; role?: string
}) {
  const [busy, setBusy] = useState(false)
  const [found, setFound] = useState<string | null>(null)
  async function guess() {
    setBusy(true)
    try {
      const g = await glint.invoke<{ name: string | null; why: string }>('voice:guess-name', id)
      setFound(g.name)
      onGuess(g.name, g.name ? g.why : 'Nobody has said their name yet.')
    } catch (err) {
      onGuess(null, (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" className={className} role={role} disabled={busy} data-tip="Guess their name from what's been said" onClick={() => void guess()}>
      <Icon name="logo" size={12} /> {busy ? 'Guessing…' : found ? `Guess: ${found}` : 'Guess'}
    </button>
  )
}

/** No speech for a while: the session ends after a countdown unless the user keeps it going. `compact`: Glance's strip. */
function InactivityPrompt({ compact }: { compact?: boolean }) {
  const [left, setLeft] = useState(INACTIVITY_COUNTDOWN_S)
  // Ticks down to 0, then ends the session once.
  useEffect(() => {
    if (left <= 0) return void glint.send('session:stop')
    const t = setTimeout(() => setLeft(left - 1), 1000)
    return () => clearTimeout(t)
  }, [left])
  const clock = formatElapsed(left * 1000)
  const keep = <button className="keep" onClick={() => patch({ inactivityPrompt: false })}>Keep going</button>
  if (compact) return <div className="glance-strip idle-strip">No speech for {INACTIVITY_MS / 60_000} min · ending in {clock}{keep}</div>
  return (
    <Toast className="notice idle">
      <Icon name="hourglass" size={17} />
      <span>No speech for {INACTIVITY_MS / 60_000} minutes. Ending the session in <b className="clock">{clock}</b>.</span>
      {keep}
    </Toast>
  )
}
