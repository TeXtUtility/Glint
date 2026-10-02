import {
  app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeImage, net, powerMonitor, protocol, safeStorage,
  session as electronSession, shell, screen, systemPreferences, Tray, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions,
} from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { format } from 'node:util'
import { askEffort, elapsedMs, formatElapsed, GHOST_FONT_RANGE, GHOST_OPACITY_RANGE, isLanguageCode, NOTE_MAX, phase, searchesFiles, type AskPayload, type KeyProvider, type Mode, type Perm, type Session, type ShortcutAction, type State } from '../shared/state'
import { NAME_GUESS_SYSTEM_PROMPT, nameGuessContext, nameGuessQuestion, parseNameGuess, SAMPLE_CALL, systemPrompt } from '../shared/prompt'
import { transcriptText } from '../shared/history'
import { HUMANIZER_LABELS, HUMANIZERS, humanizes, type HumanizerConfig, type HumanizerService } from '../shared/humanize'
import { scrub } from '../shared/markdown'
import { askWithFallbacks, cliStatus, complete, coolClaudeCli, keyStatus, removeLeftoverTemp, setKey, warmCache, warmClaudeCli } from './ai'
import { addModeFiles, passagesFor, prepareSearch, referenceFor, removeModeFile, sweepModeFiles } from './files'
import { bugReport, initLog, logTail, setVerbose, verbose } from './log'
import { modelUsage, removeUnusedModels, sweepModels } from './models'
import { connectHumanizer, disconnectHumanizer, failureLine, humanize, HumanizeError, refreshHumanizerAccount, testHumanizer } from './humanize'
import { PASSAGES_BRIEF_CHARS, searchQuery } from '../shared/search'
import { requestKeys, stopKeys, watchKeys } from './keys'
import { watchCalls } from './meetings'
import { calendarAccess, inviteFor, requestCalendar } from './calendar'
import { inviteContext } from '../shared/meetings'
import { finishAudio, flushAudio, initAudio, prepareModels, pushMic } from './audio'
import { addToCalendar, draftFollowUp, generateNotes, initHistory, listSessions, loadSession, relabelSpeaker, renameSpeaker, resumeSession, saveChat, saveLiveSession, setMessages, trashSession, updateActions, updateNotes } from './history'
import { deleteMe, deletePerson, endVoiceSession, enrollMe, forgetEveryone, initVoice, mergeSpeakers, nameVoice, renamePerson, settleSpeakers, skipVoice, voiceAudio, voiceSessionId } from './voice'
import { setGlass, type GlassRect } from './mac-panel'
import { installedTerminals, runInTerminal } from './run'
import { captureScreen } from './screenshot'
import { updateShortcuts } from './shortcuts'
import { cancelQueuedUpdate, checkForUpdate, initUpdates, installUpdate } from './update'
import { changedKeys, flushState, getState, initState, patchState, resetAllState, subscribe } from './state'
import {
  APP_ORIGIN, blurChat, DEV_URL, focusChat, focusOverlay, getWin, moveBy, onDisplaysChanged, openFollowUp, openSettings, originOf, painted, resetPosition, setBarHit, setBarSize, setGlanceSize, setPanelHeight, startDrag, startResize, stopTracking, updateWindows,
} from './windows'

const isMac = process.platform === 'darwin'
const RENDERER_DIR = path.join(__dirname, '../renderer')

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const logError = console.error
console.error = (...args: unknown[]) => {
  logError(...args)
  if (!app.isReady()) return
  const msg = format(...args)
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send('app:error', msg)
    } catch {} // a closing window; logging must never throw
  }
}
process.on('uncaughtException', (err) => console.error('[main] uncaught exception:', err))
process.on('unhandledRejection', (reason) => console.error('[main] unhandled rejection:', reason))

// ponytail: macOS only routes glint:// to a packaged build whose Info.plist declares the scheme. Add it in the packager config.
if (process.defaultApp) app.setAsDefaultProtocolClient('glint', process.execPath, [path.resolve(process.argv[1] ?? '.')])
else app.setAsDefaultProtocolClient('glint')

if (!app.requestSingleInstanceLock()) app.exit(0)
let booted = false
let pendingLink: string | null = process.argv.find((a) => a.startsWith('glint://')) ?? null // Windows/Linux cold start
app.on('open-url', (e, url) => (e.preventDefault(), handleLink(url))) // macOS; can fire before ready
app.on('second-instance', (_e, argv) => {
  const url = argv.find((a) => a.startsWith('glint://'))
  if (url) handleLink(url)
  else patchState({ overlayVisible: true, chat: { visible: true } })
})
// Opening Glint from Finder, Spotlight or Launchpad while it runs reopens the running app instead. 'activate' is that
// reopen (applicationShouldHandleReopen), not the app becoming active, so Glint focusing itself doesn't send it.
app.on('activate', () => booted && patchState({ overlayVisible: true, chat: { visible: true } }))

function handleLink(raw: string) {
  if (!booted) return void (pendingLink = raw)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return
  }
  if (url.protocol !== 'glint:') return
  const [area, page] = [url.host, ...url.pathname.split('/').filter(Boolean)]
  // Any web page can fire a glint:// link, so only known links do anything, and none shows the overlay (a page could
  // fire one mid screen-share).
  // ponytail: glint://auth/* (spec §17) needs an auth provider to hand the token to, and there isn't one yet.
  if (area !== 'settings') return
  openSettings(page)
}

app.whenReady().then(boot).catch((err) => {
  console.error(err)
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    message: 'Glint failed to start',
    detail: String(err?.stack ?? err),
    buttons: ['Quit', 'Restart'],
  })
  if (choice === 1) relaunch()
  else app.exit(1)
})

/**
 * Restart Glint. Under `electron-vite dev` that can't work: the dev server exits together with Electron, so a
 * relaunched app would load a URL nothing serves and show a blank window. There, quit and say how to restart.
 * `graceful` quits normally, so before-quit saves settings and a live session first.
 */
function relaunch(graceful = false) {
  if (DEV_URL) {
    dialog.showMessageBoxSync({
      type: 'info',
      message: 'Start Glint again from the terminal',
      detail: "In development Glint can't restart itself, because the dev server stops when it quits. Run `npm run dev` again.",
    })
  } else {
    app.relaunch()
  }
  if (graceful) app.quit()
  else app.exit(0) // skips before-quit, so callers save state first where it matters
}

function boot() {
  initLog()
  if (isMac) app.dock?.hide() // packaged builds also set LSUIElement, so the icon never flashes
  protocol.handle('app', (req) => {
    const file = path.join(RENDERER_DIR, decodeURIComponent(new URL(req.url).pathname))
    if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
  // Only our own pages may use the mic, and only audio; every other web permission is denied.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) => {
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? []
    const ownPage = (() => {
      try {
        return originOf(details.requestingUrl) === APP_ORIGIN
      } catch {
        return false
      }
    })()
    cb(perm === 'media' && ownPage && mediaTypes.length > 0 && mediaTypes.every((t) => t === 'audio'))
  })
  // Permission *checks* (e.g. navigator.permissions) default to allowed; answer them the same way.
  electronSession.defaultSession.setPermissionCheckHandler((_wc, perm, origin) => perm === 'media' && origin === APP_ORIGIN)

  // Fetch the keychain key now. If macOS has to ask for it (e.g. after a rebuild), the prompt blocks this process
  // until answered and isn't hidden from screen sharing, so it belongs at launch, not at the first save mid-call.
  // Empty strings skip the keychain, hence 'x'.
  if (safeStorage.isEncryptionAvailable()) safeStorage.encryptString('x')

  const os = isMac ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform
  const systemInfo = `${os} ${process.getSystemVersion()} (${process.arch}) · Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`
  initState({ appVersion: app.getVersion(), systemInfo, platform: process.platform,openAtLogin: app.getLoginItemSettings().openAtLogin, aiKeys: keyStatus() })
  checkPermissions()
  offerMoveToApplications()

  subscribe(onStateChange)
  onStateChange(getState(), getState())
  initVoice()
  initAudio()
  initHistory()
  initUpdates()
  watchCalls()

  screen.on('display-added', onDisplaysChanged)
  screen.on('display-removed', onDisplaysChanged)
  screen.on('display-metrics-changed', onDisplaysChanged)
  app.on('browser-window-focus', checkPermissions)
  app.on('before-quit', flushState)
  // A Mac asleep mid-session records nothing; pausing shows that, instead of a session that looks live.
  powerMonitor.on('suspend', () => {
    const { session, pause } = getState()
    if (session && !pause.paused) togglePause()
  })
  removeLeftoverTemp()
  sweepModeFiles()
  sweepModels()
  void refreshHumanizerAccount()
  // Glint loads nothing over HTTP it needs again; older versions left a downloaded model's second copy in here.
  void electronSession.defaultSession.clearCache()
  subscribe(warmForUse)
  app.on('window-all-closed', () => {}) // overlays come and go; quitting is explicit
  buildAppMenu()
  registerIpc()
  booted = true
  if (pendingLink) handleLink(pendingLink)
  pendingLink = null
}

/** The system prompt for an ask, in cached blocks: the mode's reference files, then the instructions. */
const askSystem = (mode: Mode | undefined) => [referenceFor(mode), systemPrompt(mode)].filter((x): x is string => !!x)

let warmedFor = ''
let warmTimer: NodeJS.Timeout | undefined
/**
 * Gets the next ask ready when one is likely (a session running, or the chat box, Glance or Ghost on screen), and
 * again when the mode, its files or the speed change: a Claude Code process is started and waiting, and a mode's
 * reference files are written into the Claude API's cache (the first ask would otherwise wait for both). A warm-up
 * costs memory, and the cache write costs money, so the capsule alone on screen isn't enough. Out of use, idle
 * Claude Code processes end. Debounced, so typing in the mode editor doesn't start a process per keystroke. The
 * effort must match the next ask's (see the ai:ask handler), or what was warmed isn't what it uses.
 */
function warmForUse(s: State) {
  const mode = s.modes.find((m) => m.id === s.activeModeId)
  const inUse = phase(s) === 'app' && (!!s.session || (s.overlayVisible && (s.chat.visible || s.layout !== 'full')))
  const effort = askEffort(s, { brief: s.layout === 'glance', typeable: s.layout === 'ghost' })
  const sig = inUse ? JSON.stringify([mode?.id, mode?.files?.map((f) => f.id), mode?.prompt, effort, s.ai]) : ''
  if (sig === warmedFor) return
  warmedFor = sig
  clearTimeout(warmTimer)
  if (!sig) return coolClaudeCli()
  warmTimer = setTimeout(() => {
    try {
      prepareSearch(mode)
      const system = askSystem(mode)
      if (mode?.files?.length && !searchesFiles(mode)) void warmCache(s.ai, system, effort) // searched files aren't in the system prompt
      void warmClaudeCli(s.ai, system, effort)
    } catch (err) {
      console.warn('[ai] warm-up skipped:', (err as Error).message) // an unreadable file; the ask will say so
    }
  }, 1000)
}

/**
 * What a bug report starts with: the version, the Mac, and settings that change behaviour. No keys, no mode
 * instructions or file names, nothing that was said.
 */
function reportHeader(): string {
  const s = getState()
  const settings = {
    layout: s.layout, provider: s.ai.provider, fallbacks: s.ai.fallbacks, models: [s.ai.anthropicModel, s.ai.openaiModel, s.ai.cliModel || 'default'],
    smart: s.smart, transcription: s.transcription, speakerLabels: s.speakerLabels, roomMode: s.roomMode, voiceprint: s.voiceprint,
    invisible: s.isInvisible, discreet: s.discreet, compactBar: s.compactBar, screenContext: s.screenContext, permissions: s.permissions,
    modes: s.modes.length, activeModeFiles: s.modes.find((m) => m.id === s.activeModeId)?.files?.length ?? 0, vad: s.vad, voice: s.voice,
  }
  return [`Glint ${s.appVersion} (${__GLINT_COMMIT__ || 'local build'})`, s.systemInfo, `Report made ${new Date().toISOString()}`, '', JSON.stringify(settings, null, 2)].join('\n')
}

declare const __GLINT_COMMIT__: string // electron.vite.config.ts; blank outside a git checkout

const routeOf = (url: string) => url.split('#/')[1]?.split('?')[0] || 'page'

function onStateChange(_s: State, prev: State) {
  // A step may patch state, which runs this again with the newer state first. Each step reads the current state,
  // so this call finishing afterwards can't put the older state back on screen.
  setVerbose(getState().devTools)
  updateWindows(getState())
  updateShortcuts(getState(), runShortcut)
  updateTray(getState())
  syncKeys(getState())
  const s = getState()
  if (s.openAtLogin !== prev.openAtLogin && app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.openAtLogin })
  broadcastState()
}

/** State that changes several times a second, left out of the verbose log. */
const CHATTY = new Set<keyof State>(['voiceActivity', 'liveWords', 'overlayHovered', 'session'])

/** What the windows were last sent; a window that opens later reads the current state itself (preload). */
let sent: State | null = null
/**
 * Sends the windows only the top-level keys changed since the last send. A step above can patch state again, which
 * sends first; this then finds nothing left to send. A live session's transcript goes only when it changes.
 */
function broadcastState() {
  const s = getState()
  const keys = sent ? changedKeys(sent, s) : (Object.keys(s) as (keyof State)[])
  sent = s
  if (!keys.length) return
  const delta = Object.fromEntries(keys.map((k) => [k, s[k]]))
  const told = keys.filter((k) => !CHATTY.has(k))
  if (told.length) verbose('[state] changed:', told.join(', '))
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('state:changed', delta)
}

// Every window must load our own origin.

app.on('web-contents-created', (_e, wc) => {
  const block = (e: Electron.Event, url: string) => {
    if (originOf(url) !== APP_ORIGIN) e.preventDefault()
  }
  wc.on('will-navigate', block)
  wc.on('will-redirect', block)
  wc.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
})

/** Keys a window may patch. Everything else (session, permissions, platform, aiKeys, …) is main's to set. */
const RENDERER_PATCHABLE = new Set([
  'chat', 'overlayVisible', 'isInvisible', 'lockFocusWhenInvisible', 'discreet', 'opacity', 'screenContext', 'screenshotNote', 'theme', 'openAtLogin', 'onboardingDone',
  'ai', 'transcription', 'activeModeId', 'vad', 'shortcuts', 'isRecordingShortcut', 'audioError', 'inactivityPrompt',
  'voice', 'roomMode', 'speakerLabels', 'autoCopy', 'layout', 'glance', 'aiFailure', 'smart', 'practicing', 'teach', 'updateChannel',
  'terminalApp', 'runNewWindow', 'compactBar', 'openAtLoginInitialized', 'devTools', 'humanizer', 'capsule', 'ghostAutoSkip', 'meetingPrompt',
])

function trusted(e: IpcMainEvent | IpcMainInvokeEvent) {
  try {
    return !!e.senderFrame && originOf(e.senderFrame.url) === APP_ORIGIN
  } catch {
    return false
  }
}

function handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error(`rejected ${channel} from untrusted sender`)
    return fn(e, ...args)
  })
}

function on(channel: string, fn: (e: IpcMainEvent, ...args: any[]) => void) {
  ipcMain.on(channel, (e, ...args) => {
    if (trusted(e)) fn(e, ...args)
    else console.warn(`[ipc] rejected ${channel} from untrusted sender`)
  })
}

function registerIpc() {
  handle('state:get', () => getState())
  // Read once by the preload, so a window's first frame already has its content.
  ipcMain.on('state:get-sync', (e) => void (e.returnValue = trusted(e) ? getState() : null))
  handle('state:patch', (_e, patch: unknown) => {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('bad patch')
    const denied = Object.keys(patch).filter((k) => !RENDERER_PATCHABLE.has(k))
    if (denied.length) throw new Error(`not patchable from a window: ${denied.join(', ')}`)
    // A window switches the humanizer on and off; which service and key only change through humanizer:connect.
    const h = (patch as { humanizer?: unknown }).humanizer
    if (h !== undefined && (typeof h !== 'object' || h === null || Object.keys(h).some((k) => !['on', 'ghost', 'apply'].includes(k)))) {
      throw new Error('the humanizer service changes only through Connect')
    }
    patchState(patch as Record<string, unknown>) // throws if a persisted value wouldn't load back
  })
  // Modes change through these, not whole-array patches, so two quick edits can't overwrite each other.
  handle('modes:add', (_e, m: Partial<Mode>) => {
    const id = randomUUID()
    patchState({ modes: [...getState().modes, { id, name: String(m?.name ?? ''), prompt: String(m?.prompt ?? ''), ...(typeof m?.templateId === 'string' ? { templateId: m.templateId } : {}) }] })
    return id
  })
  handle('modes:update', (_e, m: Pick<Mode, 'id' | 'name' | 'prompt' | 'screenshotNote'>) => {
    const { modes } = getState() // a mode deleted meanwhile stays deleted
    const note = typeof m?.screenshotNote === 'string' ? { screenshotNote: m.screenshotNote.slice(0, NOTE_MAX) } : {}
    patchState({ modes: modes.map((x) => (x.id === m?.id ? { ...x, name: String(m.name), prompt: String(m.prompt), ...note } : x)) })
  })
  handle('modes:delete', (_e, id: string) => {
    patchState({ modes: getState().modes.filter((x) => x.id !== id) })
    sweepModeFiles() // its reference files go with it
  })
  handle('modes:add-files', (e, id: string) => addModeFiles(String(id), BrowserWindow.fromWebContents(e.sender)))
  handle('modes:remove-file', (_e, id: string, fileId: string) => removeModeFile(String(id), String(fileId)))

  on('window:painted', (e) => painted(e.sender.id))
  // A code block's Run: the user's terminal, behind a y/N prompt.
  handle('run:commands', (_e, code: unknown) => runInTerminal(String(code ?? '').slice(0, 20_000), getState().terminalApp, getState().runNewWindow))
  handle('run:terminals', () => installedTerminals())
  on('window:drag-start', startDrag)
  on('window:drag-end', () => {
    if (stopTracking()) return
    // A click, not a drag: Ghost's strip opens the full panel; the capsule shows or hides it.
    if (getState().layout === 'ghost') patchState({ layout: 'full', overlayVisible: true, chat: { visible: true, expanded: true, view: 'chat' } })
    else toggleChat()
  })
  on('window:resize-start', startResize)
  on('window:resize-end', () => stopTracking())
  on('window:reset-position', resetPosition)
  on('window:glance-size', (_e, size: unknown) => setGlanceSize(size))
  on('window:glass', (e, msg: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { rects, vw, ax } = (msg ?? {}) as { rects?: unknown; vw?: unknown; ax?: unknown }
    const ok = (g: unknown) => !!g && typeof g === 'object' && ['x', 'y', 'w', 'h', 'r', 'a'].every((k) => Number.isFinite((g as Record<string, unknown>)[k]))
    const share = ax === 0 || ax === 1 ? ax : 0.5
    if (win && Array.isArray(rects) && typeof vw === 'number' && Number.isFinite(vw)) setGlass(win, rects.slice(0, 8).filter(ok) as GlassRect[], vw, share)
  })
  on('window:bar-size', (_e, size: unknown) => setBarSize(size))
  on('window:bar-hit', (_e, hit: unknown) => setBarHit(hit))
  on('window:panel-height', (_e, h: unknown) => setPanelHeight(h))
  handle('window:focus-chat', () => focusChat())
  handle('window:focus-bar', () => focusOverlay('controlBar'))
  // The capsule's Ask and Stop drive the chat panel, which owns the thread.
  on('chat:ask', () => sendToChat('chat:submit'))
  on('chat:stop', () => sendToChat('chat:stop'))
  // The capsule's chat-box button: show the panel ready to type in, or hide it.
  on('chat:toggle', () => {
    const s = getState()
    if (s.overlayVisible && s.chat.visible) return patchState({ chat: { visible: false } })
    patchState({ overlayVisible: true, chat: { visible: true } })
    sendToChat('chat:focus')
  })
  on('window:blur-chat', blurChat)
  on('window:open-settings', (_e, page?: string) => openSettings(page))
  on('window:open-followup', (_e, id?: string) => openFollowUp(id))
  on('notes:dismiss', () => patchState({ notesReady: null }))
  // Onboarding: the speech model downloads while the user reads, and Try it's sample call plays through the speakers.
  handle('stt:prepare', () => prepareModels())
  handle('models:usage', () => modelUsage(getState()))
  handle('log:tail', () => logTail())
  // The humanizer: test a service and key, save them once a test passes, or remove them.
  const humanizerConfig = (c: unknown): HumanizerConfig => {
    const { service, options, custom } = (c ?? {}) as Partial<HumanizerConfig>
    if (!HUMANIZERS.includes(service as HumanizerService)) throw new Error('unknown humanizer service')
    const opts = Object.fromEntries(Object.entries(options ?? {}).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v).slice(0, 100)]))
    if (service !== 'custom') return { service: service as HumanizerService, options: opts, custom: null }
    const cu = (custom ?? {}) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    const out = { url: str(cu.url), header: str(cu.header), body: str(cu.body), result: str(cu.result) }
    if (!/^https:\/\/\S+$/.test(out.url)) throw new HumanizeError('the URL must start with https://')
    if (!/^[\w-]{1,100}$/.test(out.header)) throw new HumanizeError('the header name can only have letters, digits and dashes')
    if (!out.body.includes('{{text}}')) throw new HumanizeError('the body needs {{text}} where the answer goes')
    if (out.body.length > 4000) throw new HumanizeError('the body is too long')
    try {
      JSON.parse(out.body.replaceAll('{{text}}', 'x'))
    } catch {
      throw new HumanizeError('the body must be JSON, with {{text}} inside quotes')
    }
    if (!out.result || out.result.length > 200) throw new HumanizeError('say where the rewritten text is in the reply, like results.0')
    return { service: 'custom', options: {}, custom: out }
  }
  handle('humanizer:test', (_e, c: unknown, key: unknown) => testHumanizer(humanizerConfig(c), String(key ?? '')))
  handle('humanizer:connect', (_e, c: unknown, key: unknown) => connectHumanizer(humanizerConfig(c), String(key ?? '')))
  handle('humanizer:disconnect', () => disconnectHumanizer())
  handle('log:save-report', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const day = new Date().toISOString().slice(0, 10)
    const opts = { defaultPath: path.join(app.getPath('downloads'), `Glint bug report ${day}.txt`), filters: [{ name: 'Text', extensions: ['txt'] }] }
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (canceled || !filePath) return null
    await fs.promises.writeFile(filePath, bugReport(reportHeader()), { mode: 0o600 })
    shell.showItemInFolder(filePath)
    return filePath
  })
  // Window errors land in main's log, with everything else a bug report needs.
  on('app:renderer-error', (e, msg: unknown) => console.error(`[renderer ${routeOf(e.sender.getURL())}]`, String(msg).slice(0, 2000)))
  handle('models:remove-unused', () => removeUnusedModels(getState()))
  handle('practice:say', (_e, i: unknown) => sayLine(Number(i)))
  on('practice:stop', stopSaying)

  on('session:start', startSession)
  on('call:dismiss', () => patchState({ callDetected: null }))
  handle('calendar:status', () => calendarAccess())
  handle('calendar:allow', async () => {
    const access = await requestCalendar()
    if (access === 'denied') void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars')
    return access
  })
  on('session:stop', () => void stopSession())
  on('session:toggle-pause', togglePause)
  // Meeting options: the spoken language applies to the live call from its next line, and to later sessions.
  handle('session:language', (_e, code: unknown) => {
    if (!isLanguageCode(code)) throw new Error('bad language code')
    const { session, transcription } = getState()
    patchState({ transcription: { ...transcription, language: code as string }, ...(session && { session: { ...session, language: code as string } }) })
  })
  on('session:resume', (_e, id?: string) => resume(id))
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const cleanMessages = (list: unknown[]) => list.flatMap((m: any) =>
    (m?.role === 'user' || m?.role === 'assistant') && typeof m.id === 'string' && typeof m.text === 'string'
      ? [{ id: m.id, role: m.role, text: m.text, sent: str(m.sent), typed: str(m.typed),
          sentKeys: Array.isArray(m.sentKeys) ? m.sentKeys.filter((k: unknown) => typeof k === 'string') : undefined }]
      : [],
  )
  on('session:messages', (_e, p: { sessionId: string; messages: unknown[] }) => {
    if (typeof p?.sessionId === 'string' && Array.isArray(p.messages)) setMessages(p.sessionId, cleanMessages(p.messages))
  })
  on('chat:messages', (_e, p: { id: string; messages: unknown[] }) => {
    if (typeof p?.id === 'string' && Array.isArray(p.messages)) saveChat(p.id, cleanMessages(p.messages))
  })
  // null: never saved, e.g. a session that ended with nothing said.
  handle('session:load', (_e, id: string) => {
    try {
      return loadSession(String(id))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  })
  handle('sessions:list', () => listSessions())
  handle('sessions:update', (_e, id: string, fields: { title?: string; summary?: string }) => updateNotes(String(id), fields ?? {}))
  handle('sessions:trash', (_e, id: string) => trashSession(String(id)))
  on('sessions:notes', (_e, id: string) => void generateNotes(String(id)))
  handle('sessions:actions', (_e, id: string, actions: unknown) => updateActions(String(id), actions))
  handle('sessions:calendar', (_e, id: string) => addToCalendar(String(id)))
  handle('sessions:follow-up', (e, id: string) =>
    draftFollowUp(String(id), (d) => !e.sender.isDestroyed() && e.sender.send('sessions:follow-up-partial', { id: String(id), ...d })))
  on('keys:request', () => {
    // The first time, macOS shows its own prompt; after a denial it only lists Glint, so open the right pane too.
    if (!requestKeys()) void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent')
  })
  handle('sessions:rename-speaker', (_e, id: string, speakerId: string, name: string) => renameSpeaker(String(id), String(speakerId), name))
  on('audio:mic', (_e, chunk: unknown) => {
    if (chunk instanceof Uint8Array || chunk instanceof ArrayBuffer) pushMic(new Uint8Array(chunk as ArrayBuffer))
  })
  handle('audio:flush', () => flushAudio())

  handle('screenshot:capture', () => captureScreen())
  on('app:copy', (_e, text: string) => clipboard.writeText(String(text)))
  on('app:quit', () => app.quit())
  on('app:reset', async () => {
    saveLiveSession() // relaunch() skips before-quit, which would otherwise save these
    endVoiceSession()
    // Window storage too (e.g. last Settings page). Session history and API keys are kept.
    await electronSession.defaultSession.clearStorageData().catch((err) => console.warn('[reset] storage:', err))
    resetAllState() // after the wait: a settings write scheduled during it would bring the file back
    relaunch() // no flushState(): that would write the settings we just deleted back
  })

  const asks = new Map<string, AbortController>()
  handle('ai:ask', async (e, p: AskPayload) => {
    const ctrl = new AbortController()
    asks.get(p.id)?.abort()
    asks.set(p.id, ctrl)
    const { ai, modes, activeModeId, smart, layout } = getState()
    const mode = modes.find((m) => m.id === activeModeId)
    const send = (channel: string, payload: unknown) => !e.sender.isDestroyed() && e.sender.send(channel, payload)
    const t0 = Date.now()
    let firstMs = 0
    let outcome = 'ok'
    let answeredBy: string = ai.provider
    let tokens = ''
    let searched = ''
    try {
      const system = askSystem(mode)
      // Fast unless smart mode is on; Glance's one-line answers are always fast.
      p = { ...p, effort: askEffort({ layout, smart }, p) }
      // Files too big to send whole: this ask gets the passages that match it (none when there's nothing to search with).
      const query = mode && searchesFiles(mode) ? searchQuery(p, getState().session?.transcript ?? []) : null
      if (mode && query) {
        const found = passagesFor(mode, query, p.brief ? PASSAGES_BRIEF_CHARS : undefined) // a one-line answer needs less
        p = { ...p, reference: found.text }
        send('ai:searched', { id: p.id, count: found.count, pages: found.pages, text: found.count ? found.text : '' })
        searched = ` passages=${found.count} chars=${found.text.length}`
      }
      let reply = ''
      const r = await askWithFallbacks(ai, system, p, (text) => {
        firstMs ||= Date.now() - t0
        reply += text
        send('ai:delta', { id: p.id, text })
      }, ctrl.signal, (failures, next) => send('ai:switch', { id: p.id, failures, next }))
      answeredBy = r.provider
      if (r.usage) tokens = ` tokens in=${r.usage.input} cache-read=${r.usage.cacheRead} cache-write=${r.usage.cacheWrite} out=${r.usage.output}`
      if (ctrl.signal.aborted) outcome = 'cancelled'
      else if (r.failures.length) outcome = `ok after ${r.failures.map((f) => `${f.provider} failed (${f.error})`).join(', ')}`
      // Replied, finished; now the humanizer, if this answer is one it rewrites (see humanizes).
      const h = getState().humanizer
      if (ctrl.signal.aborted || !reply.trim() || !humanizes(h, p)) return r
      send('ai:humanizing', { id: p.id, service: h.service })
      try {
        const out = await humanize(scrub(reply), ctrl.signal)
        if ('short' in out) return { ...r, humanized: { short: out.short } }
        if (getState().aiFailure?.startsWith(`${HUMANIZER_LABELS[h.service as HumanizerService]} failed`)) patchState({ aiFailure: null })
        return { ...r, humanized: { text: out.text, words: out.words, ms: out.ms } }
      } catch (err) {
        if (ctrl.signal.aborted) return { ...r, humanized: { stopped: true } }
        const reason = err instanceof HumanizeError ? err.message : (err as Error).message
        patchState({ aiFailure: failureLine(reason) }) // loud, like a failing provider: red capsule and menu bar
        return { ...r, humanized: { error: reason } }
      }
    } catch (err) {
      outcome = `error: ${(err as Error).message}`
      throw err
    } finally {
      if (asks.get(p.id) === ctrl) asks.delete(p.id)
      console.log(`[ask] ${answeredBy} screenshot=${!!p.screenshot}${searched} first-text=${firstMs ? `${firstMs}ms` : 'none'} total=${Date.now() - t0}ms${tokens} ${outcome}`)
    }
  })
  on('ai:cancel', (_e, id: string) => asks.get(id)?.abort())
  handle('ai:cli-status', (_e, provider: string) => {
    if (provider !== 'claude-cli' && provider !== 'codex-cli') throw new Error('unknown provider')
    return cliStatus(provider)
  })
  handle('ai:set-key', (_e, provider: KeyProvider, key: string | null) => {
    if (provider !== 'anthropic' && provider !== 'openai') throw new Error('unknown provider')
    const clean = typeof key === 'string' ? key.trim() : ''
    if (clean.length > 500) throw new Error('That key is too long.')
    setKey(provider, clean || null)
    patchState({ aiKeys: keyStatus() })
  })

  handle('permissions:request', (_e, kind: 'mic' | 'screen') => requestPermission(kind))

  // Voices: the user's voiceprint, naming voices heard in a session, and saved people.
  handle('voice:enroll', (_e, pcm16: unknown) => {
    if (!(pcm16 instanceof Uint8Array)) throw new Error('bad recording')
    return enrollMe(pcm16)
  })
  handle('voice:delete-me', () => deleteMe())
  handle('voice:name', (_e, id: string, name: string) => {
    const r = nameVoice(String(id), name)
    if (getState().session?.id !== r.sessionId) relabelSpeaker(r.sessionId, r.voiceId, r.personId, r.name)
  })
  handle('voice:skip', (_e, id: string) => skipVoice(String(id)))
  // "Guess": ask the model which name the transcript gives this speaker. The user still confirms it.
  handle('voice:guess-name', async (_e, id: string) => {
    const live = getState().session
    const sessionId = live?.id ?? voiceSessionId()
    if (!sessionId) throw new Error('No session to guess from.')
    const r = live?.id === sessionId ? live : loadSession(sessionId)
    const label = r.speakers?.[String(id)]
    if (!label) throw new Error("That speaker isn't in this session.")
    const text = transcriptText(r.transcript, r.speakers)
    if (!text) return { name: null, why: 'Nothing has been said yet.' }
    // Who was invited, when the Mac's calendars have this meeting (the first Guess asks macOS for access).
    const invite = inviteContext(await inviteFor(sessionId, r.startedAt))
    // The transcript is the shared, cached part: guessing about several speakers reuses it.
    return parseNameGuess(await complete(getState().ai, [NAME_GUESS_SYSTEM_PROMPT], nameGuessQuestion(label), { context: nameGuessContext(text, invite), effort: 'fast' }))
  })
  handle('voice:merge', (_e, fromId: string, intoId: string) => {
    const r = mergeSpeakers(String(fromId), String(intoId))
    if (getState().session?.id !== r.sessionId) relabelSpeaker(r.sessionId, r.drop, r.keep, r.name)
  })
  handle('voice:audio', (_e, id: string) => voiceAudio(String(id)))
  handle('people:rename', (_e, id: string, name: string) => renamePerson(String(id), name))
  handle('people:delete', (_e, id: string) => deletePerson(String(id)))
  handle('people:forget-all', () => forgetEveryone())
  on('app:relaunch', () => relaunch(true))
  on('update:check', () => void checkForUpdate(true))
  on('update:install', () => void installUpdate())
  on('update:cancel', cancelQueuedUpdate)
}

function toggleChat() {
  const s = getState()
  patchState({ overlayVisible: true, chat: { visible: !(s.overlayVisible && s.chat.visible) } })
}

function toggleOverlay() {
  patchState({ overlayVisible: !getState().overlayVisible })
}

/** Ghost's ⌃⌥⌘↑ and ↓: 5% at a time, never below 5%, so it can't vanish by accident (as in the Ghost app). */
function fadeGhost(by: number) {
  const [lo, hi] = GHOST_OPACITY_RANGE
  patchState({ ghostOpacity: Math.round(Math.min(hi, Math.max(lo, getState().ghostOpacity + by)) * 100) / 100 })
}

/** Ghost's ⌃⌥⌘= and -: a point at a time. */
function sizeGhost(by: number) {
  const [lo, hi] = GHOST_FONT_RANGE
  patchState({ ghostFontSize: Math.min(hi, Math.max(lo, getState().ghostFontSize + by)) })
}

const sendToChat = (channel: string, payload?: unknown) => getWin('chat')?.webContents.send(channel, payload)

function runShortcut(action: ShortcutAction) {
  const step = 80
  const actions: Record<ShortcutAction, () => void> = {
    toggleOverlay,
    toggleSession,
    togglePause,
    toggleInvisible: () => patchState({ isInvisible: !getState().isInvisible }),
    ask: () => sendToChat('chat:submit'),
    openSettings,
    moveUp: () => moveBy(0, -step),
    moveDown: () => moveBy(0, step),
    moveLeft: () => moveBy(-step, 0),
    moveRight: () => moveBy(step, 0),
    scrollUp: () => sendToChat('chat:scroll', -240),
    scrollDown: () => sendToChat('chat:scroll', 240),
    toggleDiscreet: () => patchState({ discreet: !getState().discreet }),
    toggleGlance: () => patchState({ layout: getState().layout === 'glance' ? 'full' : 'glance', overlayVisible: true }),
    toggleGhost: () => patchState({ layout: getState().layout === 'ghost' ? 'full' : 'ghost', overlayVisible: true }),
    ghostAsk: () => sendToChat('chat:submit'), // the same ask as ⌘↩: Ghost answers what's on screen
    ghostPrompt: () => focusChat() && sendToChat('ghost:prompt'), // a box that can't take the keys (focus locked) never opens
    ghostPrev: () => sendToChat('ghost:browse', -1),
    ghostNext: () => sendToChat('ghost:browse', 1),
    ghostBack: () => sendToChat('ghost:word', -1),
    ghostSkip: () => sendToChat('ghost:word', 1),
    ghostHide: toggleOverlay,
    ghostFadeIn: () => fadeGhost(0.05),
    ghostFadeOut: () => fadeGhost(-0.05),
    ghostBigger: () => sizeGhost(1),
    ghostSmaller: () => sizeGhost(-1),
    ghostCorner: resetPosition,
  }
  actions[action]()
}

let keysPoll: NodeJS.Timeout | undefined
/**
 * Ghost follows the user's typing only while it's on screen. Keys go to the chat window (the Ghost strip) and
 * nowhere else. While Ghost is hidden the tap stays on for double-tap Control alone, as in the Ghost app, so that
 * gesture can bring it back; typed keys go nowhere then. Until macOS allows it (Input Monitoring), check again every
 * few seconds, so allowing it in System Settings takes effect without a restart.
 */
function syncKeys(s: State) {
  const want = s.layout === 'ghost' && phase(s) === 'app' && isMac
  clearInterval(keysPoll)
  if (!want) return stopKeys()
  const start = () => {
    const ok = watchKeys((k) => getState().overlayVisible && sendToChat('ghost:key', k), toggleOverlay)
    if (getState().keysAllowed !== ok) patchState({ keysAllowed: ok })
    if (ok) clearInterval(keysPoll)
    return ok
  }
  // The poll is set first: start's patch runs this again, and that newer run must replace it, not be overwritten.
  keysPoll = setInterval(start, 3000)
  start()
}

const canBegin = () => phase(getState()) === 'app' && !getState().session && !stopping

function beginSession(session: Session, expanded: boolean) {
  patchState({ session, callDetected: null, audioError: null, pause: { paused: false, pausedTotalMs: 0 }, overlayVisible: true, chat: { visible: true, expanded, view: 'chat' } })
}

function startSession() {
  if (!canBegin()) return
  const s = getState()
  const language = s.transcription.language || 'en'
  const mode = s.modes.find((m) => m.id === s.activeModeId)?.name || undefined
  beginSession({ id: randomUUID(), chatId: randomUUID(), language, transcript: [], startedAt: Date.now(), isResumed: false, priorElapsedMs: 0, mode }, false)
}

function resume(id = getState().lastSessionId) {
  if (!canBegin() || !id) return
  try {
    beginSession(resumeSession(id), true)
  } catch (err) {
    console.error('[history] resume failed:', err)
    patchState({ audioError: `Couldn't open that session: ${(err as Error).message}`, overlayVisible: true, chat: { visible: true } })
  }
}

let stopping = false

/** Waits (bounded) for the last words to be transcribed, so ending a session doesn't drop its tail. */
async function stopSession() {
  if (!getState().session || stopping) return
  stopping = true
  try {
    await finishAudio() // stops capture, then waits for the last lines' text
    settleSpeakers() // before the session is saved and its notes written
  } finally {
    stopping = false
    patchState({ session: null, chat: { expanded: true, view: 'dashboard' } })
  }
}

function showHistory() {
  patchState({ overlayVisible: true, chat: { visible: true, expanded: true, view: 'dashboard' } })
}

function toggleSession() {
  if (getState().session) void stopSession()
  else startSession()
}

function togglePause() {
  const { pause, session } = getState()
  if (!session) return
  const now = Date.now()
  patchState({
    pause: pause.paused
      ? { paused: false, pausedTotalMs: pause.pausedTotalMs + (now - (pause.pausedAt ?? now)) }
      : { paused: true, pausedAt: now, pausedTotalMs: pause.pausedTotalMs },
  })
}

function checkPermissions() {
  if (!isMac) return patchState({ permissions: { mic: 'granted', screen: 'granted' } })
  const map = (st: string): Perm => (st === 'granted' ? 'granted' : st === 'not-determined' ? 'unknown' : 'denied')
  patchState({
    permissions: {
      mic: map(systemPreferences.getMediaAccessStatus('microphone')),
      screen: map(systemPreferences.getMediaAccessStatus('screen')),
    },
  })
}

const PRIVACY_PANE = {
  mic: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
}

async function requestPermission(kind: 'mic' | 'screen') {
  if (!isMac) return
  if (kind === 'mic' && systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
    await systemPreferences.askForMediaAccess('microphone')
  } else if (kind === 'screen') {
    // A throwaway capture registers the app in the Screen Recording list and triggers the prompt.
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {})
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') await shell.openExternal(PRIVACY_PANE.screen)
  } else {
    await shell.openExternal(PRIVACY_PANE[kind])
  }
  checkPermissions()
}

/** Offered once: running from Downloads or a disk image breaks permissions and updates. Moving relaunches. */
function offerMoveToApplications() {
  if (!isMac || !app.isPackaged || getState().movePromptShown || app.isInApplicationsFolder()) return
  patchState({ movePromptShown: true })
  flushState() // keep "asked once" even though moving relaunches immediately
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    message: 'Move Glint to your Applications folder?',
    detail: 'Running it from another folder, like Downloads, can break its permissions and updates.',
    buttons: ['Move to Applications', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  })
  if (choice !== 0) return
  try {
    app.moveToApplicationsFolder()
  } catch (err) {
    console.error('[move] failed:', err)
    dialog.showMessageBoxSync({ type: 'error', message: "Couldn't move Glint", detail: String((err as Error).message) })
  }
}

// Menu bar only: the tray is the way into the app.

let tray: Tray | null = null
let trayFailing: boolean | null = null
let trayTitle = ''
let trayClock: NodeJS.Timeout | undefined

/**
 * A round dot or ring, drawn at 2x. Black (a template image, which macOS tints for the menu bar) unless given a colour,
 * which macOS leaves alone. `ring`: the stroke width, in points, for an outline instead of a disc.
 */
function dot(pt: number, bgr?: [number, number, number], ring = 0) {
  const size = pt * 2
  const r = size / 2
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r)
      const clamp = (v: number) => Math.min(1, Math.max(0, v))
      const a = clamp(r - d) * (ring ? clamp(d - (r - ring * 2) + 1) : 1) // soft edges
      const i = (y * size + x) * 4 // BGRA
      if (bgr) buf.set(bgr, i)
      buf[i + 3] = Math.round(a * 255)
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 })
  img.setTemplateImage(!bgr)
  return img
}
const RED: [number, number, number] = [0x5d, 0x5d, 0xff] // #ff5d5d
const BLUE: [number, number, number] = [0xff, 0x8f, 0x7b] // #7b8fff

/**
 * The menu bar item: a ring, with the timer beside it while a session runs, so recording shows even with the overlay
 * hidden; a solid red dot while something is failing. The menu is built when it opens, so its header is current.
 */
function updateTray(s: State) {
  const failing = !!(s.aiFailure ?? s.audioError)
  if (!tray) {
    tray = new Tray(dot(10, undefined, 2))
    const open = () => tray?.popUpContextMenu(trayMenu(getState()))
    tray.on('click', open)
    tray.on('right-click', open)
  }
  if (failing !== trayFailing) {
    trayFailing = failing
    tray.setImage(failing ? dot(10, RED) : dot(10, undefined, 2))
  }
  tray.setToolTip(failing ? `Glint: ${s.aiFailure ?? s.audioError}` : 'Glint')
  const ticking = !!s.session && !s.pause.paused
  if (ticking && !trayClock) trayClock = setInterval(() => updateTrayTitle(getState()), 1000)
  if (!ticking && trayClock) (clearInterval(trayClock), (trayClock = undefined))
  updateTrayTitle(s)
}

function updateTrayTitle(s: State) {
  const title = s.session ? ` ${formatElapsed(elapsedMs(s, Date.now()))}` : ''
  if (title === trayTitle || !tray) return
  trayTitle = title
  tray.setTitle(title, { fontType: 'monospacedDigit' })
}

const shorten = (text: string, n = 70) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

/**
 * Toggles show their tick in the label rather than macOS's checkmark column, with blank space the same width when
 * unticked, so they're indented under the other items (as in the design) instead of every item being indented.
 * An em space plus a thin space measures within 0.1 pt of "✓ " in the menu font at 13 and 14 pt.
 */
const TICK = '✓ '
const NO_TICK = '  '

function trayMenu(s: State) {
  const inApp = phase(s) === 'app'
  const live = !!s.session
  const paused = live && s.pause.paused
  const failure = s.aiFailure ?? s.audioError
  const mode = s.modes.find((m) => m.id === s.activeModeId)?.name || 'General'
  // Shown beside the item; the shortcut itself is registered globally (shortcuts.ts), not by the menu.
  const key = (a: ShortcutAction) => (s.shortcuts[a] ? { accelerator: s.shortcuts[a], registerAccelerator: false } : {})
  const toggle = (label: string, on: boolean, click: () => void, rest: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions =>
    ({ label: `${on ? TICK : NO_TICK}${label}`, click, ...rest })
  const layout = (l: State['layout']) => () => patchState({ layout: getState().layout === l ? 'full' : l, overlayVisible: true })
  const sep: MenuItemConstructorOptions = { type: 'separator' }
  const showPanel = () => patchState({ overlayVisible: true, chat: { visible: true } })

  return Menu.buildFromTemplate([
    // Status lines are enabled so macOS doesn't grey them; clicking one shows the panel.
    ...(failure ? [{ label: s.aiFailure ? 'The AI is failing' : 'Audio stopped', sublabel: shorten(failure), icon: dot(7, RED), enabled: inApp, click: showPanel }] : []),
    live
      ? { label: `${paused ? 'Session paused' : 'Session live'} · ${formatElapsed(elapsedMs(s, Date.now()))}`, sublabel: mode, icon: paused ? undefined : dot(7, RED), click: showPanel }
      : { label: inApp ? 'No session' : 'Finish setting up Glint', sublabel: inApp ? mode : undefined, enabled: inApp, click: showPanel },
    sep,
    { label: live ? 'End session' : 'Start session', enabled: inApp, click: toggleSession, ...key('toggleSession') },
    ...(live ? [{ label: paused ? 'Resume session' : 'Pause session', click: togglePause, ...key('togglePause') }] : []),
    { label: 'Resume last session', enabled: inApp && !live && !!s.lastSessionId, click: () => resume() },
    sep,
    { label: s.overlayVisible ? 'Hide overlay' : 'Show overlay', enabled: inApp, click: toggleOverlay, ...key('toggleOverlay') },
    toggle('Invisible mode', s.isInvisible, () => patchState({ isInvisible: !getState().isInvisible }), key('toggleInvisible')),
    toggle('Discreet overlay', s.discreet, () => patchState({ discreet: !getState().discreet }), key('toggleDiscreet')),
    toggle('Glance', s.layout === 'glance', layout('glance'), { enabled: inApp, ...key('toggleGlance') }),
    toggle('Ghost', s.layout === 'ghost', layout('ghost'), { enabled: inApp, ...key('toggleGhost') }),
    sep,
    { label: 'Session history…', enabled: inApp, click: showHistory },
    ...(s.update.status === 'available' ? [{ label: `Update to ${s.update.channel === 'beta' ? 'beta ' : ''}${s.update.version}…`, icon: dot(6, BLUE), click: () => openSettings('general') }] : []),
    { label: 'Settings…', enabled: inApp, click: () => openSettings(), ...key('openSettings') },
    sep,
    { label: 'Restart Glint', click: () => relaunch(true) },
    { label: 'Quit Glint', sublabel: live ? 'Ends the session' : undefined, click: () => app.quit() },
  ])
}

// Cmd+H and Cmd+Q hide the overlay. Quit lives in the tray.

function buildAppMenu() {
  const hideOrQuit = (quit: boolean) => () => {
    if (phase(getState()) === 'app') patchState({ overlayVisible: false })
    else if (quit) app.quit()
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac
        ? [{
            label: app.name,
            submenu: [
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
              { type: 'separator' as const },
              { role: 'close' as const }, // Cmd+W closes Settings; overlays ignore it
              { label: 'Hide Glint', accelerator: 'CmdOrCtrl+H', click: hideOrQuit(false) },
              { label: 'Quit Glint', accelerator: 'CmdOrCtrl+Q', click: hideOrQuit(true) },
            ],
          }]
        : []),
      { role: 'editMenu' as const },
      { role: 'windowMenu' as const },
      ...(app.isPackaged ? [] : [{ label: 'Developer', submenu: [{ role: 'toggleDevTools' as const }, { role: 'forceReload' as const }] }]),
    ]),
  )
}

/** "Jordan", the sample call's other side, spoken with the Mac's own voice so the call capture hears it. */
let saying: ChildProcess | null = null
function sayLine(i: number): Promise<void> {
  stopSaying()
  const line = SAMPLE_CALL[i]
  if (!line || !isMac) return Promise.resolve()
  return new Promise((resolve) => {
    const p = spawn('/usr/bin/say', ['-r', '185', line.text])
    saying = p
    p.on('close', () => resolve())
    p.on('error', () => resolve())
  })
}
function stopSaying() {
  saying?.kill()
  saying = null
}
