// Imports only shared files that import nothing themselves: main, renderer and tests all use this file.
import { HUMANIZERS, type HumanizerAccount, type HumanizerCustom, type HumanizerService } from './humanize.ts'

export type Perm = 'unknown' | 'granted' | 'denied'
export type Role = 'me' | 'them'

export interface TranscriptItem {
  role: Role
  at: string // ISO time
  offsetMs: number
  status: 'pending' | 'ready'
  text?: string
  /** Who said it, as a key of Session.speakers. Absent: the user, or someone not recognised. */
  speaker?: string
  /** Room mode: couldn't tell whether this was the user; `role` is the best guess. */
  sure?: false
}

export interface Session {
  id: string
  chatId: string
  language: string
  transcript: TranscriptItem[]
  startedAt: number
  isResumed: boolean
  priorElapsedMs: number
  /** Display names for TranscriptItem.speaker: saved people by name, unnamed voices as "Speaker 1", … */
  speakers?: Record<string, string>
  /** The mode active when the session started, by name. */
  mode?: string
}

/** Blank: no shortcut until the user records one. */
export const DEFAULT_SHORTCUTS = {
  toggleOverlay: 'CommandOrControl+\\',
  toggleSession: 'CommandOrControl+Shift+\\',
  togglePause: '',
  toggleInvisible: '',
  ask: 'CommandOrControl+Enter',
  openSettings: 'CommandOrControl+,',
  moveUp: 'CommandOrControl+Up',
  moveDown: 'CommandOrControl+Down',
  moveLeft: 'CommandOrControl+Left',
  moveRight: 'CommandOrControl+Right',
  scrollUp: 'CommandOrControl+Shift+Up',
  scrollDown: 'CommandOrControl+Shift+Down',
  toggleDiscreet: 'CommandOrControl+Alt+\\',
  toggleGlance: 'CommandOrControl+Control+\\',
  toggleGhost: 'CommandOrControl+Control+G',
  ghostAsk: 'CommandOrControl+Control+Alt+Enter',
  ghostPrompt: 'CommandOrControl+Shift+Enter',
  ghostPrev: 'CommandOrControl+Control+Alt+[',
  ghostNext: 'CommandOrControl+Control+Alt+]',
  ghostBack: 'CommandOrControl+Control+Alt+Left',
  ghostSkip: 'CommandOrControl+Control+Alt+Right',
  // The standalone Ghost app's own keys, the same in Glint's Ghost.
  ghostHide: 'CommandOrControl+Control+Alt+H',
  ghostFadeIn: 'CommandOrControl+Control+Alt+Up',
  ghostFadeOut: 'CommandOrControl+Control+Alt+Down',
  ghostBigger: 'CommandOrControl+Control+Alt+=',
  ghostSmaller: 'CommandOrControl+Control+Alt+-',
  ghostCorner: 'CommandOrControl+Control+Alt+0',
}
export type ShortcutAction = keyof typeof DEFAULT_SHORTCUTS

export type AiProvider = 'anthropic' | 'openai' | 'claude-cli' | 'codex-cli'
export const AI_PROVIDERS: AiProvider[] = ['anthropic', 'openai', 'claude-cli', 'codex-cli']
export type KeyProvider = 'anthropic' | 'openai'
/** 'unreadable': saved, but the keychain key that encrypted it is gone (keychain reset, access denied, another Mac). */
export type KeyStatus = 'none' | 'saved' | 'unreadable'

/** These need tuning on real meetings, so they're editable in Settings > Developer. */
export const VAD_DEFAULTS = {
  positive: 0.3,
  negative: 0.25,
  preSpeechPadMs: 500,
  redemptionMs: 800, // lower splits more, higher merges pauses
  minSpeechMs: 400,
  maxSegmentMs: 20_000,
}
export type VadSettings = typeof VAD_DEFAULTS
/** [min, max, step] per setting; state.json values outside these are rejected. */
export const VAD_RANGES: Record<keyof VadSettings, [number, number, number]> = {
  positive: [0.05, 0.95, 0.05],
  negative: [0.05, 0.95, 0.05],
  preSpeechPadMs: [0, 1500, 50],
  redemptionMs: [100, 3000, 50],
  minSpeechMs: [0, 2000, 50],
  maxSegmentMs: [2000, 28_000, 1000], // Whisper drops audio past 30 s
}

/** Ghost's text size and opacity, as the Ghost app has them: 11 pt (7 to 28), 85% (5% to 100%, 5% a step). */
export const GHOST_FONT_DEFAULT = 11
export const GHOST_FONT_RANGE = [7, 28] as const
export const GHOST_OPACITY_DEFAULT = 0.85
export const GHOST_OPACITY_RANGE = [0.05, 1] as const

export const OPACITY_DEFAULTS = {
  /** The whole overlay, text included. */
  overlay: 1,
  /** The glass behind the text. */
  background: 0.9,
  /** The controls in discreet mode. */
  idle: 0.35,
}
export type OpacitySettings = typeof OPACITY_DEFAULTS
export const OPACITY_RANGES: Record<keyof OpacitySettings, [number, number, number]> = {
  overlay: [0.3, 1, 0.05],
  background: [0.2, 1, 0.05],
  idle: [0.1, 0.8, 0.05],
}

/**
 * Voice matching thresholds (cosine similarity of TitaNet-small embeddings). Starting values come from LibriSpeech
 * test-clean against a voiceprint of two utterances: the same person scored at least 0.57 on 1.5 s clips (5th
 * percentile) and anyone else at most 0.25 (95th). Editable in Settings > Developer.
 */
export const VOICE_DEFAULTS = {
  /** Mic speech scoring at least this against the user's voice is the user... */
  meKeep: 0.4,
  /** ...and at most this is someone else (or echo of the call). Between the two it's unsure. */
  notMe: 0.25,
  /** A saved person or a voice from this session matches at this or above (0.45 let 3% of strangers pass as saved people; 0.5 let none, same recall)... */
  match: 0.5,
  /** ...with this lead over the runner-up, so two similar voices don't swap. */
  margin: 0.08,
  /** A long enough line scoring below this against every known voice starts a new one. */
  newBelow: 0.3,
}
export type VoiceSettings = typeof VOICE_DEFAULTS
export const VOICE_RANGES: Record<keyof VoiceSettings, [number, number, number]> = {
  meKeep: [0.2, 0.9, 0.01],
  notMe: [0, 0.6, 0.01],
  match: [0.2, 0.9, 0.01],
  margin: [0, 0.3, 0.01],
  newBelow: [0, 0.6, 0.01],
}

export type AutoCopy = 'off' | 'reply' | 'code'
/** Where a code block's Run opens; 'auto' is one already open, else the first installed. */
export type TerminalApp = 'auto' | 'Terminal' | 'iTerm' | 'Ghostty' | 'kitty' | 'WezTerm' | 'Alacritty' | 'Windows Terminal' | 'PowerShell'
export const TERMINAL_APPS: TerminalApp[] = ['auto', 'Terminal', 'iTerm', 'Ghostty', 'kitty', 'WezTerm', 'Alacritty', 'Windows Terminal', 'PowerShell']
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
/** Glance: seconds between automatic answers, [min, max, step]. */
export const GLANCE_COOLDOWN_RANGE: [number, number, number] = [10, 120, 5]

export interface Mode {
  id: string
  name: string
  prompt: string
  templateId?: string
  /** Added to the screenshot note while this mode is active. */
  screenshotNote?: string
  /** Reference files: sent whole with every ask while the mode is active, or searched when too big (see searchesFiles). */
  files?: ModeFile[]
}

/** `chars`: length of the text taken from the file, which lives encrypted on disk, not in settings. */
export interface ModeFile { id: string; name: string; chars: number; /** PDFs */ pages?: number }

/**
 * A mode's reference files are sent whole up to this many characters together (about 4 per token): ~375k tokens,
 * which leaves room in a 1M token context for the conversation and the answer. Past it, each ask gets the passages
 * that best match it instead (src/shared/search.ts).
 */
export const MODE_FILES_WHOLE_CHARS = 1_500_000
/** What a mode can hold: its files' text is kept decrypted in memory while in use, with its search index. */
export const MODE_FILES_MAX_CHARS = 15_000_000

/** Too big to send whole: each ask searches the mode's files. */
export const searchesFiles = (mode: Pick<Mode, 'files'> | null | undefined) =>
  (mode?.files ?? []).reduce((n, f) => n + f.chars, 0) > MODE_FILES_WHOLE_CHARS

/** Max characters for each screenshot note (the global one and each mode's). */
export const NOTE_MAX = 1000

export interface AskPayload {
  id: string
  text: string
  screenshot: string | null // data URL
  /** `name`: who said it when known (a person, "Speaker 2", or "Unclear"); otherwise Me / Them by role. */
  transcript: { role: Role; text: string; name?: string }[]
  /** Glance: reply in one short line. Asked for in the new turn, never in the system prompt, so the cache holds. */
  brief?: boolean
  /** Large context that leads the new turn and repeats across calls (a transcript asked about several times): cached separately. */
  context?: string
  /** Passages from the mode's reference files that match this ask (set by main, when they're searched). Never cached. */
  reference?: string
  /** A typed retry ("try again"): the instruction before it, which a mode's file search looks for again. */
  repeat?: string
  /** Screen context was on but the screenshot failed, so the model is told it can't see the screen. */
  screenshotFailed?: boolean
  /** Ghost: the reply is typed out by hand, so it must be only the text to type (see GHOST_PROMPT). */
  typeable?: boolean
  /** 'fast': least reasoning that still answers well (the default for anything the user waits on). 'smart': think it through. Unset: the provider's default. */
  effort?: 'fast' | 'smart'
  history: { role: 'user' | 'assistant'; text: string }[]
  hasSession: boolean
}

/**
 * The capsule's movable items, in their default order (the 0.11 capsule). Logo, status and Meeting options never move.
 * The humanizer's switch starts in Meeting options, and shows only while a service is connected.
 */
export const CAPSULE_ITEMS = [
  'activity', 'divider-1', 'mode', 'divider-2', 'screen', 'humanize', 'invisible', 'room', 'labels', 'divider-3', 'session', 'divider-4', 'chat', 'ask',
] as const
export type CapsuleItem = (typeof CAPSULE_ITEMS)[number]
export const isDivider = (id: CapsuleItem) => id.startsWith('divider')
/** Drops the dividers a layout leaves at the end or next to another divider. A leading one stays: it follows the status. */
export const tidyDividers = (ids: CapsuleItem[]) => ids.filter((id, i) => !isDivider(id) || (i < ids.length - 1 && !isDivider(ids[i + 1])))

export interface Persisted {
  onboardingDone: boolean
  permissions: { mic: Perm; screen: Perm }
  isInvisible: boolean
  lockFocusWhenInvisible: boolean
  /** Overlays fade until hovered, with no pulse or "hidden" note, so they draw less attention on your own screen. */
  discreet: boolean
  opacity: OpacitySettings
  screenContext: 'off' | 'on'
  /** Drawn on a band above or below every screenshot sent to the model. Blank = no band. */
  screenshotNote: { text: string; position: 'top' | 'bottom' }
  shortcuts: Record<ShortcutAction, string>
  theme: 'system' | 'light' | 'dark'
  /** Which branch updates build from: main (releases) or beta (the newest work, before it's released). */
  updateChannel: 'stable' | 'beta'
  openAtLoginInitialized: boolean
  ai: {
    provider: AiProvider
    /** Models for fast answers (the default), then for smart mode. Blank CLI models: see cliModelFor. */
    anthropicModel: string; openaiModel: string; cliModel: string
    anthropicSmartModel: string; openaiSmartModel: string; cliSmartModel: string
    /** Let the model think before fast answers: more careful on hard questions, slower to start. Smart mode always thinks. */
    fastThinking: boolean
    /** Tried in order when the chosen one fails. */
    fallbacks: AiProvider[]
  }
  /** `liveWords`: show English speech word by word while it's spoken (a second, streaming model). */
  transcription: { engine: SttEngine; localModel: LocalWhisper; openaiModel: string; language: string; liveWords: boolean }
  modes: Mode[]
  /** null = General (no mode). */
  activeModeId: string | null
  vad: VadSettings
  voice: VoiceSettings
  /** In person: one mic hears everyone, and the user's voiceprint tells them apart. */
  roomMode: boolean
  /** Split "Them" into people by voice, and offer to save new voices. */
  speakerLabels: boolean
  /** Put each finished reply to a typed or hotkey ask on the clipboard. */
  autoCopy: AutoCopy
  terminalApp: TerminalApp
  /** Run opens a new terminal window every time, instead of using an idle one that's open. */
  runNewWindow: boolean
  /** Developer tools: the Developer page (tuning, live log, bug report) and verbose logging. */
  devTools: boolean
  /**
   * Rewriting answers with a humanizer service. `service`, `options` and `custom` change only
   * through humanizer:connect, after a passing test. `on` and `apply` cover Chat, Glance and follow-up emails;
   * `ghost` covers Ghost, whenever a service is connected.
   */
  humanizer: {
    service: HumanizerService | 'none'; on: boolean; ghost: boolean
    apply: { chat: boolean; email: boolean; glance: boolean }
    options: Record<string, string>; custom: HumanizerCustom | null
  }
  /** The capsule shows only the dot, the chat box, Ask and Meeting options. */
  compactBar: boolean
  /** Think deeply and answer thoroughly. Off: the fastest answer that is still reliable. */
  smart: boolean
  /** The session "Resume" continues. Kept in settings: file dates change when old sessions are edited. */
  lastSessionId: string | null
  /**
   * 'glance': the overlay shrinks to a strip in a corner that shows one-line answers. 'ghost': the same corner strip
   * shows an answer to type out by hand, moving along as the user types it anywhere (Ghost).
   */
  layout: 'full' | 'glance' | 'ghost'
  glance: { corner: Corner; autoAnswer: boolean; cooldownS: number }
  /** Ghost's text size in points, as in the Ghost app (⌃⌥⌘= and -). */
  ghostFontSize: number
  /** When a call app starts using the mic, a small prompt offers to take notes. */
  meetingPrompt: boolean
  /** Ghost jumps ahead by itself when the user skips, swaps or adds words, or clicks into the next field. Off: only ⌃⌥⌘← → skip. */
  ghostAutoSkip: boolean
  /** macOS: the "move to Applications?" offer is made once. */
  movePromptShown: boolean
  /** Which capsule items show, in order; the hidden ones sit in Meeting options. */
  capsule: { shown: CapsuleItem[]; hidden: CapsuleItem[] }
}

/** Glance and Ghost shrink the overlay to a strip in a corner (the Glance corner), with no control bar. */
export const inCorner = (s: Pick<Persisted, 'layout'>) => s.layout !== 'full'

/**
 * How hard the next ask thinks. Ghost answers are typed out by hand, so they think it through; Glance's one-liners
 * stay fast; everything else follows smart mode.
 */
export const askEffort = (s: Pick<Persisted, 'layout' | 'smart'>, p: { brief?: boolean; typeable?: boolean }): 'fast' | 'smart' =>
  p.typeable || (s.smart && !p.brief) ? 'smart' : 'fast'

export type SttEngine = 'local' | 'openai'
export const LOCAL_WHISPER_MODELS = ['tiny', 'base', 'small'] as const

/** Parakeet v3's languages besides English (ISO 639-1). */
const EUROPEAN = new Set(['bg', 'hr', 'cs', 'da', 'nl', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk'])

/**
 * The on-device model a language is transcribed with, and its name for the UI: NVIDIA Parakeet TDT 0.6B v2 for
 * English, v3 for the 24 other European languages it covers (sherpa-onnx packages), Whisper for the rest.
 */
/** The on-device speech model for a language, with its download size. */
export function speechModelFor(language: string, size: LocalWhisper): { id: string; label: string; mb: number } {
  if (language === 'en') return { id: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', label: 'Parakeet v2', mb: 460 }
  if (EUROPEAN.has(language)) return { id: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', label: 'Parakeet v3', mb: 465 }
  return { id: `onnx-community/whisper-${size}`, label: `Whisper ${size}`, mb: WHISPER_MB[size] }
}
const WHISPER_MB: Record<LocalWhisper, number> = { tiny: 75, base: 150, small: 500 }
export type LocalWhisper = (typeof LOCAL_WHISPER_MODELS)[number]

export interface State extends Persisted {
  appVersion: string
  /** OS, architecture and Electron/Chromium versions, for bug reports. */
  systemInfo: string
  platform: string
  openAtLogin: boolean
  overlayVisible: boolean
  windowsLoaded: { controlBar: boolean; chat: boolean }
  /** macOS lets Glint see keystrokes (Input Monitoring), which Ghost needs to follow the user's typing. */
  keysAllowed: boolean
  /** Ghost's opacity, faded with ⌃⌥⌘↑ and ↓; like the Ghost app's, it starts at 85% each launch. */
  ghostOpacity: number
  /** A call that just started ("Zoom", "Google Meet"), offered notes; null once taken up, dismissed or over. */
  callDetected: string | null
  isRecordingShortcut: boolean
  /** Shortcuts whose keys wouldn't register (another app has them, or macOS refuses them); Settings flags them. */
  shortcutFailures: ShortcutAction[]
  chat: { visible: boolean; expanded: boolean; view: 'chat' | 'transcript' | 'dashboard'; isStreaming: boolean }
  session: Session | null
  voiceActivity: { me: boolean; them: boolean }
  pause: { paused: boolean; pausedAt?: number; pausedTotalMs: number }
  inactivityPrompt: boolean
  isCapturingScreenshot: boolean
  /** Whether an API key is saved. The keys themselves never leave main. */
  aiKeys: Record<KeyProvider, KeyStatus>
  /** The connected humanizer's plan and words left, from the last test, account check or rewrite. */
  humanizerAccount: HumanizerAccount | null
  /** Capture/transcription failure to show the user; null when fine. */
  audioError: string | null
  /** e.g. "Downloading speech model… 40%"; null when ready or idle. */
  sttStatus: string | null
  /** Bumped whenever a saved session changes on disk, so the history view refetches. */
  historyVersion: number
  /** What each side is saying right now, word by word, before its line is transcribed; '' when quiet. */
  liveWords: { me: string; them: string }
  /** Onboarding's Try it step is showing: the overlays run as in the app, with onboarding still open. */
  practicing: boolean
  /** The capsule control Try it is teaching, which gets a halo. */
  teach: 'start' | 'ask' | 'invisible' | 'stop' | null
  /** A session's notes just finished: the panel offers to open them in the Follow-up window. */
  notesReady: { id: string; title: string } | null
  /** The AI's last failure, kept until the chosen provider answers again or the user dismisses it. Turns the UI red. */
  aiFailure: string | null
  /** The pointer is over an overlay window. Main tracks this: macOS sends no hover events to a background app. */
  overlayHovered: boolean
  /** `version`: the newer version on GitHub, once seen. `message`: why the last check or install failed. */
  /** ready: built and copied in; Glint quits for it as soon as no session is live. */
  /**
   * `channel`: the branch the offered build comes from. A beta build's `version` is its short commit, and `commits`
   * lists what it adds (beta builds don't bump the version or write release notes). `queued`: asked for during a
   * session; it starts building when the session ends, so the build doesn't compete with the call.
   */
  update: {
    status: 'idle' | 'checking' | 'current' | 'available' | 'queued' | 'installing' | 'ready' | 'failed'
    version?: string; message?: string; channel?: 'stable' | 'beta'; commits?: string[]
  }
  /** Voice model (speaker recognition) availability. */
  voiceModel: 'missing' | 'downloading' | 'ready' | 'failed'
  /** Download progress while `voiceModel` is 'downloading'. */
  voiceModelPct: number | null
  /** Whether the user's own voiceprint is saved and readable. */
  voiceprint: 'none' | 'enrolled' | 'unreadable'
  /** How long the user's voice recording was, in seconds. */
  voiceprintSeconds: number | null
  /** Files being read into a mode; `ocr` once text recognition runs, when pages done / total is worth showing. */
  modeFileJobs: { modeId: string; id: string; name: string; done: number; total: number; ocr: boolean }[]
  /** Saved people, for Settings. Voiceprints themselves stay in main. */
  people: { id: string; name: string; lastHeard: number; hasSample: boolean; sessions: number }[]
  /** A voice from this session heard enough to be worth naming; null when none is waiting. */
  namePrompt: { id: string; label: string; seconds: number } | null
}

export const PERSISTED_DEFAULTS: Persisted = {
  onboardingDone: false,
  permissions: { mic: 'unknown', screen: 'unknown' },
  isInvisible: true,
  lockFocusWhenInvisible: false,
  discreet: false,
  opacity: { ...OPACITY_DEFAULTS },
  screenContext: 'on',
  screenshotNote: { text: '', position: 'top' },
  shortcuts: { ...DEFAULT_SHORTCUTS },
  theme: 'system',
  updateChannel: 'stable',
  openAtLoginInitialized: false,
  ai: {
    provider: 'anthropic',
    anthropicModel: 'claude-sonnet-5-5', openaiModel: 'gpt-5.5', cliModel: '',
    anthropicSmartModel: 'claude-opus-5-5', openaiSmartModel: 'gpt-5.5', cliSmartModel: '',
    fastThinking: false,
    // Subscriptions only: a key saved for one thing (OpenAI transcription) shouldn't start paying for answers when
    // the chosen provider fails. Paid APIs can be added as fallbacks in Settings → AI.
    fallbacks: ['claude-cli', 'codex-cli'],
  },
  transcription: { engine: 'local', localModel: 'base', openaiModel: 'gpt-4o-mini-transcribe', language: 'en', liveWords: true },
  modes: [],
  activeModeId: null,
  vad: { ...VAD_DEFAULTS },
  voice: { ...VOICE_DEFAULTS },
  roomMode: false,
  speakerLabels: true,
  autoCopy: 'off',
  terminalApp: 'auto',
  runNewWindow: false,
  devTools: false,
  humanizer: { service: 'none', on: false, ghost: true, apply: { chat: true, email: true, glance: false }, options: {}, custom: null },
  compactBar: false,
  smart: false,
  lastSessionId: null,
  layout: 'full',
  glance: { corner: 'bottom-right', autoAnswer: true, cooldownS: 20 },
  ghostFontSize: GHOST_FONT_DEFAULT,
  ghostAutoSkip: true,
  meetingPrompt: true,
  movePromptShown: false,
  capsule: { shown: CAPSULE_ITEMS.filter((id) => id !== 'humanize'), hidden: ['humanize'] },
}

const CHAT_DEFAULT: State['chat'] = { visible: false, expanded: false, view: 'chat', isStreaming: false }
const PAUSE_DEFAULT: State['pause'] = { paused: false, pausedTotalMs: 0 }

export const RUNTIME_DEFAULTS: Omit<State, keyof Persisted> = {
  appVersion: '',
  systemInfo: '',
  platform: '',
  openAtLogin: false,
  overlayVisible: true,
  windowsLoaded: { controlBar: false, chat: false },
  keysAllowed: false,
  ghostOpacity: GHOST_OPACITY_DEFAULT,
  callDetected: null,
  isRecordingShortcut: false,
  shortcutFailures: [],
  chat: CHAT_DEFAULT,
  session: null,
  voiceActivity: { me: false, them: false },
  pause: PAUSE_DEFAULT,
  inactivityPrompt: false,
  isCapturingScreenshot: false,
  aiKeys: { anthropic: 'none', openai: 'none' },
  humanizerAccount: null,
  audioError: null,
  sttStatus: null,
  historyVersion: 0,
  liveWords: { me: '', them: '' },
  practicing: false,
  teach: null,
  notesReady: null,
  aiFailure: null,
  overlayHovered: false,
  update: { status: 'idle' },
  voiceModel: 'missing',
  voiceModelPct: null,
  voiceprint: 'none',
  voiceprintSeconds: null,
  modeFileJobs: [],
  people: [],
  namePrompt: null,
}

/** Compares dotted versions numerically, so 0.10.0 is newer than 0.9.0. */
export function isNewer(latest: string, current: string): boolean {
  const a = latest.split('.').map((n) => parseInt(n, 10) || 0)
  const b = current.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

export const INACTIVITY_MS = 10 * 60_000
export const INACTIVITY_COUNTDOWN_S = 40

// ponytail: no auth yet, so no splash phase and no signed-out check. Add both with the auth provider.
export function phase(s: State): 'onboarding' | 'app' {
  const permsOk = s.platform !== 'darwin' || (s.permissions.mic === 'granted' && s.permissions.screen === 'granted')
  return (s.onboardingDone || s.practicing) && permsOk ? 'app' : 'onboarding'
}

export function normalize(s: State): State {
  if (phase(s) !== 'app') s = { ...s, chat: CHAT_DEFAULT, session: null, windowsLoaded: { controlBar: false, chat: false } }
  if (!s.session) s = { ...s, pause: PAUSE_DEFAULT, voiceActivity: { me: false, them: false }, inactivityPrompt: false }
  if (!s.pause.paused && s.pause.pausedAt !== undefined) s = { ...s, pause: { paused: false, pausedTotalMs: s.pause.pausedTotalMs } }
  if (!s.chat.expanded && s.chat.view !== 'chat') s = { ...s, chat: { ...s.chat, view: 'chat' } }
  if (s.activeModeId && !s.modes.some((m) => m.id === s.activeModeId)) s = { ...s, activeModeId: null }
  if (s.vad.negative > s.vad.positive) s = { ...s, vad: { ...s.vad, negative: s.vad.positive } } // hysteresis needs neg ≤ pos
  return s
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Top-level keys replace; plain objects merge one level deep so `{chat: {expanded: true}}` works. */
export function applyPatch(s: State, patch: Record<string, unknown>): State {
  const next: Record<string, unknown> = { ...s }
  for (const [k, v] of Object.entries(patch)) {
    const cur = next[k]
    next[k] = isObj(v) && isObj(cur) && k !== 'session' ? { ...cur, ...v } : v
  }
  return next as unknown as State
}

/** ISO 639-1/-3 code, as Whisper and the OpenAI API take it ("en", not "English"). */
export const isLanguageCode = (v: unknown) => typeof v === 'string' && /^[a-z]{2,3}$/.test(v)
const perm = (v: unknown) => v === 'unknown' || v === 'granted' || v === 'denied'
const note = (v: unknown) => typeof v === 'string' && v.length <= NOTE_MAX
const bool = (v: unknown) => typeof v === 'boolean'

const VALID: { [K in keyof Persisted]: (v: Persisted[K]) => boolean } = {
  onboardingDone: bool,
  permissions: (p) => perm(p.mic) && perm(p.screen),
  isInvisible: bool,
  lockFocusWhenInvisible: bool,
  discreet: bool,
  opacity: (o) => inRanges(o, OPACITY_RANGES),
  screenContext: (v) => v === 'on' || v === 'off',
  screenshotNote: (n) => note(n.text) && (n.position === 'top' || n.position === 'bottom'),
  shortcuts: (sc) => Object.values(sc).every((a) => typeof a === 'string'), // blank: not set
  theme: (v) => ['system', 'light', 'dark'].includes(v),
  updateChannel: (v) => v === 'stable' || v === 'beta',
  openAtLoginInitialized: bool,
  ai: (a) =>
    AI_PROVIDERS.includes(a.provider) &&
    [a.anthropicModel, a.openaiModel, a.cliModel, a.anthropicSmartModel, a.openaiSmartModel, a.cliSmartModel].every((m) => typeof m === 'string') &&
    typeof a.fastThinking === 'boolean' &&
    Array.isArray(a.fallbacks) && a.fallbacks.every((p) => AI_PROVIDERS.includes(p)),
  transcription: (t) =>
    (t.engine === 'local' || t.engine === 'openai') &&
    LOCAL_WHISPER_MODELS.includes(t.localModel) &&
    typeof t.openaiModel === 'string' &&
    isLanguageCode(t.language) &&
    typeof t.liveWords === 'boolean',
  modes: (ms) =>
    Array.isArray(ms) &&
    ms.every((m) => isObj(m) && typeof m.id === 'string' && typeof m.name === 'string' && typeof m.prompt === 'string' &&
      (m.screenshotNote === undefined || note(m.screenshotNote)) &&
      (m.files === undefined || (Array.isArray(m.files) && m.files.every((f) => isObj(f) && typeof f.id === 'string' && typeof f.name === 'string' && typeof f.chars === 'number')))),
  activeModeId: (v) => v === null || typeof v === 'string',
  vad: (v) => inRanges(v, VAD_RANGES),
  voice: (v) => inRanges(v, VOICE_RANGES),
  roomMode: bool,
  speakerLabels: bool,
  autoCopy: (v) => ['off', 'reply', 'code'].includes(v),
  terminalApp: (v) => TERMINAL_APPS.includes(v),
  runNewWindow: bool,
  devTools: bool,
  humanizer: (h) =>
    (h.service === 'none' || HUMANIZERS.includes(h.service)) && bool(h.on) && bool(h.ghost) &&
    isObj(h.apply) && bool(h.apply.chat) && bool(h.apply.email) && bool(h.apply.glance) &&
    isObj(h.options) && Object.values(h.options).every((v) => typeof v === 'string' && v.length <= 100) &&
    (h.custom === null || (isObj(h.custom) && /^https:\/\/\S+$/.test(h.custom.url) && /^[\w-]{1,100}$/.test(h.custom.header) &&
      typeof h.custom.body === 'string' && h.custom.body.includes('{{text}}') && h.custom.body.length <= 4000 &&
      typeof h.custom.result === 'string' && h.custom.result.length <= 200)) &&
    (h.service !== 'custom' || h.custom !== null),
  compactBar: bool,
  smart: bool,
  lastSessionId: (v) => v === null || (typeof v === 'string' && /^[\w-]+$/.test(v)),
  layout: (v) => v === 'full' || v === 'glance' || v === 'ghost',
  glance: (g) =>
    CORNERS.includes(g.corner) &&
    typeof g.autoAnswer === 'boolean' &&
    typeof g.cooldownS === 'number' && g.cooldownS >= GLANCE_COOLDOWN_RANGE[0] && g.cooldownS <= GLANCE_COOLDOWN_RANGE[1],
  ghostFontSize: (v) => Number.isInteger(v) && v >= GHOST_FONT_RANGE[0] && v <= GHOST_FONT_RANGE[1],
  ghostAutoSkip: bool,
  meetingPrompt: bool,
  movePromptShown: bool,
  capsule: (c) => {
    if (!isObj(c) || !Array.isArray(c.shown) || !Array.isArray(c.hidden)) return false
    const ids = [...c.shown, ...c.hidden]
    return ids.every((id) => CAPSULE_ITEMS.includes(id)) && new Set(ids).size === ids.length
  },
}

/**
 * Read state.json leniently: missing keys take defaults, and a key that fails validation falls back to its
 * default on its own (listed in `rejected`), so one bad value doesn't reset every other setting.
 */
export function loadPersisted(json: string): { value: Persisted; rejected: string[] } {
  const raw = JSON.parse(json)
  if (!isObj(raw)) throw new Error('state.json is not an object')
  const d = PERSISTED_DEFAULTS
  const group = <K extends keyof Persisted>(k: K) => ({ ...(d[k] as object), ...(isObj(raw[k]) ? pick(raw[k], Object.keys(d[k] as object)) : {}) })
  const out: Record<string, unknown> = {
    ...d,
    ...pick(raw, Object.keys(d)),
    permissions: { ...d.permissions, ...(isObj(raw.permissions) ? raw.permissions : {}) },
    shortcuts: group('shortcuts'),
    ai: group('ai'),
    transcription: group('transcription'),
    vad: group('vad'),
    voice: group('voice'),
    glance: group('glance'),
    opacity: group('opacity'),
    screenshotNote: group('screenshotNote'),
    humanizer: group('humanizer'),
  }
  // Settings from before fast and smart models were separate: the old default (Opus) is now the smart model's, and
  // fast answers get the fast default. A model the user picked stays their fast model.
  if (isObj(raw.ai) && !('anthropicSmartModel' in raw.ai) && raw.ai.anthropicModel === 'claude-opus-5') out.ai = { ...(out.ai as object), anthropicModel: d.ai.anthropicModel }
  // Ghost's first defaults were written with "Command", which Settings neither shows as ⌘ nor matches against a
  // recorded shortcut: the same keys, written as recording writes them.
  const sc = out.shortcuts as Record<string, unknown>
  for (const k of Object.keys(sc)) if (typeof sc[k] === 'string') sc[k] = sc[k].replace(/^Control\+Alt\+Command\+/, 'CommandOrControl+Control+Alt+')
  const rejected = (Object.keys(VALID) as (keyof Persisted)[]).filter((k) => !(VALID[k] as (v: unknown) => boolean)(out[k]))
  for (const k of rejected) out[k] = d[k]
  // A control added since the file was written goes where a new install has it, at the end, rather than in neither list.
  const cap = out.capsule as Persisted['capsule']
  const missing = CAPSULE_ITEMS.filter((id) => !cap.shown.includes(id) && !cap.hidden.includes(id))
  const hide = (id: CapsuleItem) => d.capsule.hidden.includes(id)
  if (missing.length) out.capsule = { shown: [...cap.shown, ...missing.filter((id) => !hide(id))], hidden: [...cap.hidden, ...missing.filter(hide)] }
  return { value: out as unknown as Persisted, rejected }
}

/** Strict parse: missing keys take defaults; any wrongly typed key throws. */
export function parsePersisted(json: string): Persisted {
  const { value, rejected } = loadPersisted(json)
  if (rejected.length) throw new Error(`invalid settings: ${rejected.join(', ')}`)
  return value
}

function inRanges<K extends string>(o: Record<K, unknown>, ranges: Record<K, [number, number, number]>) {
  return (Object.keys(ranges) as K[]).every((k) => {
    const v = o[k]
    return typeof v === 'number' && v >= ranges[k][0] && v <= ranges[k][1]
  })
}

export function pickPersisted(s: State): Persisted {
  return pick(s as unknown as Record<string, unknown>, Object.keys(PERSISTED_DEFAULTS)) as unknown as Persisted
}

function pick(o: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]))
}

export function elapsedMs(s: Pick<State, 'session' | 'pause'>, now: number): number {
  if (!s.session) return 0
  // Only time after the pause began counts as paused (speech flushed at pause time predates it).
  const pausedNow = s.pause.paused && s.pause.pausedAt ? Math.max(0, now - s.pause.pausedAt) : 0
  return Math.max(0, now - s.session.startedAt - s.pause.pausedTotalMs - pausedNow + s.session.priorElapsedMs)
}

export function formatElapsed(ms: number): string {
  const t = Math.floor(ms / 1000)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

const CODE_KEYS: Record<string, string> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Enter: 'Enter', Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Escape: 'Escape',
  Backslash: '\\', Slash: '/', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Minus: '-', Equal: '=', Backquote: '`', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
}

export interface KeyLike { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

/** Shortcuts are stored as on a Mac. Elsewhere ⌘ is Ctrl and the Win key stands in for ⌃, so ⌃⌘\ doesn't become ⌘\. */
export function nativeAccelerator(acc: string, isMac: boolean): string {
  return isMac ? acc : acc.split('+').map((p) => (p === 'Control' ? 'Super' : p)).join('+')
}

/** null = modifier-only press; 'no-modifier' = rejected (on a Mac, anything without ⌘ or ⌃). */
export function toAccelerator(e: KeyLike, isMac: boolean): string | null | 'no-modifier' {
  let key: string | undefined = CODE_KEYS[e.code]
  if (!key && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  if (!key && /^Digit\d$/.test(e.code)) key = e.code.slice(5)
  if (!key && /^F\d{1,2}$/.test(e.code)) key = e.code
  if (!key) return null
  const mods: string[] = []
  if (isMac ? e.metaKey : e.ctrlKey) mods.push('CommandOrControl')
  if (isMac ? e.ctrlKey : e.metaKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  // macOS 15 won't register ⌥ or ⌥⇧ alone, and taking them would break the accents ⌥ types in every app.
  if (isMac ? !e.metaKey && !e.ctrlKey : !mods.length || (mods.length === 1 && mods[0] === 'Shift')) return 'no-modifier'
  return [...mods, key].join('+')
}

const EDITING = ['A', 'C', 'V', 'X', 'Z', 'S', 'F', 'Shift+Z', 'Left', 'Right', 'Backspace'].map((k) => `CommandOrControl+${k}`)
export const clashesWithEditing = (acc: string) => EDITING.includes(acc)
/** Quit, close, hide, minimise and Force Quit: macOS's own in every app, so never recorded. */
const MAC_SYSTEM = ['Q', 'W', 'H', 'M', 'Alt+Escape'].map((k) => `CommandOrControl+${k}`)
/** Windows' own (Control is the Win key): window switching, Start, Task Manager, desktops, Narrator, Game Bar. */
const WIN_SYSTEM = [
  'Alt+F4', 'Alt+Tab', 'Alt+Shift+Tab', 'Alt+Escape', 'Alt+Space',
  'CommandOrControl+Escape', 'CommandOrControl+Shift+Escape', 'CommandOrControl+Alt+Delete', 'CommandOrControl+Alt+Tab',
  ...['Left', 'Right', 'D', 'F4', 'O', 'Enter', 'C', 'S', 'N', 'Shift+B'].map((k) => `CommandOrControl+Control+${k}`),
  ...['R', 'K', 'B', 'D', 'G'].map((k) => `Control+Alt+${k}`),
]
export function isSystemShortcut(acc: string, isMac: boolean): boolean {
  if (isMac) return MAC_SYSTEM.includes(acc)
  const mods = acc.split('+').slice(0, -1).join('+')
  return mods === 'Control' || mods === 'Control+Shift' || WIN_SYSTEM.includes(acc) // Windows keeps nearly every Win+key
}

export function prettyAccelerator(acc: string, isMac: boolean): string {
  const map: Record<string, string> = isMac
    ? { CommandOrControl: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧', Up: '↑', Down: '↓', Left: '←', Right: '→', Enter: '↩' }
    : { CommandOrControl: 'Ctrl', Control: 'Win', Super: 'Win', Up: '↑', Down: '↓', Left: '←', Right: '→' }
  const parts = acc.split('+')
  // macOS writes modifiers in a fixed order, ⌃⌥⇧⌘, whatever order the accelerator lists them in.
  const ORDER = isMac ? ['Control', 'Alt', 'Shift', 'CommandOrControl'] : ['CommandOrControl', 'Control', 'Super', 'Alt', 'Shift']
  parts.sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99))
  return parts.map((p) => map[p] ?? p).join(isMac ? '' : '+')
}

/**
 * Ghost's keys as the user has them set, for its hover card: "⌘↩ or ⌃⌥⌘↩ answers what's on screen", "⌃⌥⌘[ ] earlier
 * and later answers". A pair that differs only in its last key is written once; a blank shortcut is left out.
 */
export function ghostHints(sc: Record<ShortcutAction, string>, isMac: boolean): string[] {
  const k = (a: ShortcutAction) => (sc[a] ? prettyAccelerator(sc[a], isMac) : '')
  const pair = (a: ShortcutAction, b: ShortcutAction, both: string, one: [string, string]) => {
    const mods = (acc: string) => acc.slice(0, acc.lastIndexOf('+'))
    if (sc[a] && sc[b] && mods(sc[a]) === mods(sc[b])) return [`${k(a)} ${prettyAccelerator(sc[b].slice(mods(sc[b]).length + 1), isMac)} ${both}`]
    return [k(a) && `${k(a)} ${one[0]}`, k(b) && `${k(b)} ${one[1]}`]
  }
  const ask = [k('ask'), k('ghostAsk')].filter(Boolean).join(' or ')
  return [
    ask && `${ask} answers what's on screen`,
    k('ghostPrompt') && `${k('ghostPrompt')} types a question`,
    ...pair('ghostPrev', 'ghostNext', 'earlier and later answers', ['earlier answer', 'later answer']),
    ...pair('ghostBack', 'ghostSkip', 'back or skip a word', ['back a word', 'skip a word']),
    ...pair('ghostFadeIn', 'ghostFadeOut', 'fade', ['less faded', 'more faded']),
    ...pair('ghostBigger', 'ghostSmaller', 'text size', ['bigger text', 'smaller text']),
    k('ghostHide') && `${k('ghostHide')} or double-tap ${isMac ? '⌃' : 'Ctrl'} hides`,
    `drag to move${k('ghostCorner') && `, ${k('ghostCorner')} back to the corner`}`,
  ].filter(Boolean)
}
