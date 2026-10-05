import { app, BrowserWindow, nativeTheme, screen, type BrowserWindowConstructorOptions } from 'electron'
import path from 'node:path'
import { inCorner, phase, type State } from '../shared/state'
import { makeKey, preventActivation, refitGlass } from './mac-panel'
import { getState, patchState } from './state'

/** The dev server's page under `electron-vite dev`. Never in a packaged app: whoever set it would become the trusted origin. */
export const DEV_URL = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
export const originOf = (u: string) => {
  const x = new URL(u)
  return `${x.protocol}//${x.host}`
}
export const APP_ORIGIN = DEV_URL ? originOf(DEV_URL) : 'app://glint'
const routeUrl = (route: string, query = '') => `${DEV_URL ?? 'app://glint/index.html'}#/${route}${query}`

const isMac = process.platform === 'darwin'
const CHAT_W = 646 // 640 of panel, plus the 3 px either side the page keeps for its failure ring
/** The capsule and panel pages each keep 3 px round their surface, which already makes the 6 px gap between them. */
const GAP = 0
/**
 * The capsule's window, sized by its page to what it shows: `flow` is the capsule plus the new-voice tray, which the
 * panel sits under; `h` also covers an open popover, which may overlap the panel's top.
 */
let bar = { w: 163, h: 44, flow: 44 }
/**
 * The capsule's window is at least this wide, so it never resizes sideways as the capsule grows and shrinks: macOS
 * shows a page redrawn for a new width a frame before it moves the window, which shifts the capsule for that frame.
 * The page centres the capsule in it, and the empty room either side lets clicks through (useClickThrough).
 */
const BAR_WIN_W = 960
const barWinW = () => Math.max(bar.w, BAR_WIN_W)
/** The collapsed panel (input and notices) reports its own height; expanded ones are set here. */
let panelH = 60

type Name = 'controlBar' | 'chat' | 'onboarding' | 'settings' | 'followup'
/** Settings and onboarding on macOS: no title bar or title, the window buttons inset over the page (styles.css). */
const CHROMELESS = (name: Name): BrowserWindowConstructorOptions =>
  isMac ? { titleBarStyle: 'hiddenInset' } : { titleBarStyle: 'hidden', titleBarOverlay: captionButtons(name) }
const captionButtons = (name: Name) =>
  ({ color: '#00000000', symbolColor: name === 'followup' || nativeTheme.shouldUseDarkColors ? '#ececf1' : '#1b1c23', height: 36 })
const wins: Partial<Record<Name, BrowserWindow>> = {}
export const getWin = (name: Name) => wins[name]

let protect = false
let quitting = false
app.on('before-quit', () => (quitting = true))

/** What Settings and onboarding paint first, in the theme, so they never flash white while loading. */
const pageBackground = (name: Name) =>
  name === 'followup' ? '#1b1c23' // dark only, like the overlay it opens from
  : name === 'settings' || name === 'onboarding' ? (nativeTheme.shouldUseDarkColors ? '#1b1c23' : '#ffffff')
  : undefined

function create(name: Name, opts: BrowserWindowConstructorOptions, query = '') {
  const win = new BrowserWindow({
    show: false,
    title: 'Glint',
    ...(pageBackground(name) && { backgroundColor: pageBackground(name) }),
    ...opts,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: name !== 'chat', // keeps the inactivity timer honest while hidden
    },
  })
  win.setContentProtection(protect)
  win.on('closed', () => delete wins[name])
  void win.loadURL(routeUrl(name, query))
  wins[name] = win
  return win
}

/** The chat window's level: Ghost's strip goes above the menu bar (updateWindows). */
let chatLevel: 'screen-saver' | 'modal-panel' = 'modal-panel'

function createOverlay(name: 'controlBar' | 'chat') {
  if (name === 'controlBar') barHit = true // a new window takes clicks everywhere
  const win = create(name, {
    width: name === 'chat' ? CHAT_W : barWinW(),
    height: name === 'chat' ? panelH : bar.h,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // macOS otherwise pulls a window back onto the screen when it's shown: the capsule's wide window, whose empty room
    // hangs off a screen edge when the capsule sits near it, would jump toward the middle and back. It also lets Ghost's
    // strip go over the menu bar. The capsule and panel themselves still keep to the work area (place).
    enableLargerThanScreen: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    focusable: false,
    alwaysOnTop: true,
    ...(isMac ? { type: 'panel' } : {}),
  })
  win.setAlwaysOnTop(true, 'modal-panel')
  if (name === 'chat') chatLevel = 'modal-panel'
  // Overlays live as long as the app phase says so. Ctrl+W (the Windows window menu) or Cmd+W while typing would
  // otherwise destroy the chat panel mid-session, taking mic capture and the thread with it.
  win.on('close', (e) => !quitting && e.preventDefault())
  preventActivation(win)
  win.webContents.on('did-finish-load', () => patchState({ windowsLoaded: { [name]: true } }))
  // A crashed overlay is a blank window, and the chat one also captures the mic: reload it rather than
  // keep a "live" session that records nothing.
  win.webContents.on('render-process-gone', (_e, d) => {
    if (quitting || d.reason === 'clean-exit') return
    console.error(`[windows] ${name} renderer gone (${d.reason}); reloading`)
    patchState({ windowsLoaded: { [name]: false } })
    if (name === 'chat' && getState().session) patchState({ audioError: 'The chat panel crashed and was reloaded. Speech during the crash may be missing.' })
    win.reload()
  })
  win.on('blur', () => win.setFocusable(false))
  return win
}

function destroy(name: Name) {
  wins[name]?.destroy()
  delete wins[name]
}

/**
 * A window hidden for a while has dropped its drawn frames, while the Mac's blur behind the page shows at once. It
 * stays see-through until the page has drawn a frame (or 250 ms), so it never flashes an empty box, then two frames
 * more, which the blur needs to catch up. At 1%, not 0: macOS doesn't work out the blur of a fully transparent window.
 */
function setShown(win: BrowserWindow, show: boolean) {
  if (show && !win.isVisible()) {
    win.setOpacity(0.01)
    win.showInactive()
    win.moveTop()
    void afterPaint(win).then(() => setTimeout(() => !win.isDestroyed() && win.isVisible() && win.setOpacity(1), 34))
  } else if (!show && win.isVisible()) {
    win.hide()
  }
}

const painting = new Map<number, () => void>()
function afterPaint(win: BrowserWindow): Promise<void> {
  const id = win.webContents.id
  painting.get(id)?.()
  return new Promise((resolve) => {
    const done = () => (clearTimeout(timer), painting.delete(id), resolve())
    const timer = setTimeout(done, 250)
    painting.set(id, done)
    win.webContents.send('window:paint')
  })
}

/** The page has drawn since it was asked (window:paint). */
export const painted = (webContentsId: number) => painting.get(webContentsId)?.()

export function updateWindows(s: State) {
  if (quitting) return // a state change while quitting mustn't recreate an overlay that just closed
  if (nativeTheme.themeSource !== s.theme) {
    nativeTheme.themeSource = s.theme // each set repaints every window
    if (!isMac) for (const n of ['settings', 'onboarding'] as const) wins[n]?.setTitleBarOverlay(captionButtons(n))
  }
  const inApp = phase(s) === 'app'

  if (!inApp && !wins.onboarding) {
    const w = create('onboarding', { width: 1100, height: 720, minWidth: 760, minHeight: 560, ...CHROMELESS('onboarding') })
    w.on('close', () => app.quit()) // user closed it; destroy() doesn't emit 'close'
    w.once('ready-to-show', () => bringToFront(w))
  }
  if (inApp && !s.practicing) destroy('onboarding')

  if (inApp) {
    wins.controlBar ?? createOverlay('controlBar')
    wins.chat ?? createOverlay('chat')
  } else {
    destroy('controlBar')
    destroy('chat')
  }

  const nextProtect = s.isInvisible || s.isCapturingScreenshot
  if (nextProtect !== protect) {
    protect = nextProtect
    for (const w of BrowserWindow.getAllWindows()) w.setContentProtection(protect)
  }

  if (s.isInvisible && s.lockFocusWhenInvisible) (blurChat(), blurOverlay('controlBar'))
  place()
  const glance = inCorner(s)
  watchHover(inApp && s.overlayVisible) // Glance's hover card and every overlay tooltip need it
  const loaded = s.windowsLoaded.controlBar && s.windowsLoaded.chat
  if (wins.controlBar) {
    const show = s.overlayVisible && loaded && !glance
    if (!show) blurOverlay('controlBar')
    setShown(wins.controlBar, show)
  }
  if (wins.chat) {
    const show = s.overlayVisible && (glance || s.chat.visible) && loaded
    if (!show) blurChat()
    setShown(wins.chat, show)
    // Ghost sits above the menu bar, as the Ghost app's strip does (screen-saver level), so it can be dragged over it.
    const level = s.layout === 'ghost' ? 'screen-saver' : 'modal-panel'
    if (level !== chatLevel) (wins.chat.setAlwaysOnTop(true, level), (chatLevel = level))
  }
}

// With no Dock icon, a newly shown window would otherwise open behind the active app.
function bringToFront(w: BrowserWindow) {
  w.show()
  app.focus({ steal: true })
}

// Overlays only take key focus while the user types: in the chat, or in the capsule's tray and Meeting options.

export function focusOverlay(name: 'chat' | 'controlBar'): boolean {
  const s = getState()
  const win = wins[name]
  if (!win || (s.isInvisible && s.lockFocusWhenInvisible)) return false
  win.setFocusable(true)
  // Always re-assert, even if Electron thinks it's key already: after a click in another overlay (the capsule's
  // chat-box button) macOS can still send the keys elsewhere, and a click into the input must fix that.
  if (makeKey(win)) win.webContents.focus()
  else win.focus() // focus() activates the app; makeKey keeps the user's app frontmost
  return true
}
export const focusChat = () => focusOverlay('chat')

export function blurOverlay(name: 'chat' | 'controlBar') {
  const win = wins[name]
  if (!win?.isFocusable()) return
  win.blur()
  win.setFocusable(false)
}
export const blurChat = () => blurOverlay('chat')

/** The capsule's centre x and top y. */
let pos: { x: number; y: number } | null = null
let chatH = 500

function defaultPos() {
  const wa = screen.getPrimaryDisplay().workArea
  return { x: Math.round(wa.x + wa.width / 2), y: wa.y + 11 } // the capsule 14 px down, less its 3 px margin
}

const displayAt = (p: { x: number; y: number }) => screen.getDisplayNearestPoint({ x: p.x, y: p.y + Math.round(bar.flow / 2) })

function chatHeight(s: State) {
  if (!s.chat.expanded) return panelH
  if (s.chat.view === 'dashboard') return 760 // place() clamps it to the work area
  return chatH
}

const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(clamp(v, lo, hi)) : null)

/**
 * The capsule's window grows past the capsule for a tooltip or popover, over the panel's top, where the chat box's
 * input sits. Its empty part lets clicks through to the panel (the page reports whether the pointer is on something).
 */
let barHit = true
export function setBarHit(hit: unknown) {
  if (typeof hit !== 'boolean' || hit === barHit) return
  barHit = hit
  wins.controlBar?.setIgnoreMouseEvents(!hit, { forward: true })
}

export function setBarSize(size: unknown) {
  const { w, h, flow } = (size ?? {}) as Record<string, unknown>
  const next = { w: num(w, 28, 1600), h: num(h, 28, 900), flow: num(flow, 28, 900) }
  if (next.w === null || next.h === null || next.flow === null) return
  const opening = next.h > next.flow && bar.h <= bar.flow
  bar = { w: next.w, h: Math.max(next.h, next.flow), flow: next.flow }
  place()
  if (opening) wins.controlBar?.moveTop() // a popover overlaps the panel's top, so the capsule's window goes above it
}

export function setPanelHeight(h: unknown) {
  const v = num(h, 40, 600)
  if (v === null || v === panelH) return
  panelH = v
  place()
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))

/** `animate`: macOS slides the frame to its new size instead of snapping. */
function setBoundsIfChanged(win: BrowserWindow | undefined, b: Electron.Rectangle, animate = false) {
  if (!win) return
  const c = win.getBounds()
  if (c.x === b.x && c.y === b.y && c.width === b.width && c.height === b.height) return
  win.setBounds(b, animate && win.isVisible())
  if (c.width !== b.width) refitGlass(win) // the blur moves with the page, which re-centres in the new width
}

/** Clamps into the work area unless a drag or resize is in progress. */
/** Glance: the chat window shrinks to its content (reported by the page) and sits in a corner. */
const GLANCE_INSET = 9 // 12 px from the screen edge to the strip: the page keeps 3 px round it for its halo
let glanceSize = { w: 28, h: 28 }
/** The last size change was the strip's text coming or going, which animates; the hover card snaps. */
let glanceAnimate = false

export function setGlanceSize(size: unknown) {
  const { w, h, animate } = (size ?? {}) as { w?: unknown; h?: unknown; animate?: unknown }
  if (typeof w !== 'number' || typeof h !== 'number') return
  glanceAnimate = animate === true
  glanceSize = { w: Math.round(Math.min(Math.max(w, 28), 500)), h: Math.round(Math.min(Math.max(h, 28), 480)) } // room for the card and its shadow
  place()
}

/**
 * Where Ghost's strip was dragged: the window's corner-side point (its bottom-right for the bottom-right corner), so
 * it grows away from that edge as the Ghost app's panel does. Until then, or after ⌃⌥⌘0, it sits in its corner.
 * Like the Ghost app's, it lasts until Glint quits.
 */
let ghostAt: { x: number; y: number; corner: State['glance']['corner'] } | null = null

function placeGlance(s: State) {
  const { corner } = s.glance
  // The display the overlay was last on, so switching layouts doesn't jump screens.
  const p = pos ?? defaultPos()
  const wa = displayAt(p).workArea
  const { w, h } = glanceSize
  const right = corner.endsWith('right')
  const bottom = corner.startsWith('bottom')
  const dragged = s.layout === 'ghost' && ghostAt?.corner === corner ? ghostAt : null
  let x = dragged ? (right ? dragged.x - w : dragged.x) : right ? wa.x + wa.width - GLANCE_INSET - w : wa.x + GLANCE_INSET
  let y = dragged ? (bottom ? dragged.y - h : dragged.y) : bottom ? wa.y + wa.height - GLANCE_INSET - h : wa.y + GLANCE_INSET
  if (dragged && !tracking) {
    // Kept on the screen it was dropped on, hover card included; the menu bar and Dock areas count, as in the Ghost app.
    const on = screen.getDisplayNearestPoint({ x: Math.round(x + w / 2), y: Math.round(y + h / 2) }).bounds
    x = clamp(x, on.x, on.x + on.width - w)
    y = clamp(y, on.y, on.y + on.height - h)
  }
  setBoundsIfChanged(wins.chat, { x: Math.round(x), y: Math.round(y), width: w, height: h }, glanceAnimate)
  glanceAnimate = false
}

/** Ghost's strip follows the pointer; a click without moving opens the panel (index.ts). */
function startGhostDrag() {
  const s = getState()
  const b = wins.chat?.getBounds()
  if (!b) return
  const { corner } = s.glance
  const from = { x: corner.endsWith('right') ? b.x + b.width : b.x, y: corner.startsWith('bottom') ? b.y + b.height : b.y }
  track((dx, dy) => {
    ghostAt = { x: from.x + dx, y: from.y + dy, corner }
    place()
  })
}

function place() {
  if (!wins.controlBar) return
  const s = getState()
  if (inCorner(s)) return placeGlance(s)
  pos ??= defaultPos()
  const wa = displayAt(pos).workArea
  const cw = Math.min(CHAT_W, wa.width - 32)
  const ch = Math.min(chatHeight(s), wa.height - bar.flow - GAP)
  if (!tracking) {
    const half = Math.max(bar.w, cw) / 2
    const cx = clamp(pos.x, wa.x + half, wa.x + wa.width - half)
    let y = clamp(pos.y, wa.y, wa.y + wa.height - bar.flow)
    const limit = wa.y + wa.height - 150
    if (s.chat.visible && y + bar.flow + GAP + ch > limit) y = Math.max(wa.y, limit - bar.flow - GAP - ch)
    pos = { x: Math.round(cx), y }
  }
  // The capsule stays centred on pos.x as it grows and shrinks with its state. Near a screen edge its window's empty
  // room may hang off the screen.
  setBoundsIfChanged(wins.controlBar, { x: Math.round(pos.x - barWinW() / 2), y: pos.y, width: barWinW(), height: bar.h })
  setChatBounds({ x: Math.round(pos.x - cw / 2), y: pos.y + bar.flow + GAP, width: cw, height: ch }, !s.chat.expanded)
}

/** How long a shorter collapsed panel keeps its window's height: the page's frames reach the screen about 50 ms late. */
const SHRINK_AFTER_MS = 100
let shrinkTimer: NodeJS.Timeout | undefined

/**
 * A collapsed panel is only as tall as its content, from the window's top. When it gets shorter, the window keeps its
 * height until the page has drawn it shorter, then shrinks: shrinking first would show the old page cut off for a
 * frame, while the room it trims later is already transparent. An expanded panel fills the window, so it follows at once.
 */
function setChatBounds(b: Electron.Rectangle, collapsed: boolean) {
  const win = wins.chat
  if (!win) return
  clearTimeout(shrinkTimer)
  const c = win.getBounds()
  if (collapsed && !tracking && win.isVisible() && b.height < c.height && b.x === c.x && b.y === c.y && b.width === c.width) {
    shrinkTimer = setTimeout(() => setBoundsIfChanged(wins.chat, b), SHRINK_AFTER_MS)
  } else setBoundsIfChanged(win, b)
}

// Glance's and Ghost's hover cards and every overlay tooltip follow the pointer. A background app gets no hover events
// on macOS (and a hover in progress when the user switched apps never ends), so main polls the cursor instead.
let hoverTimer: NodeJS.Timeout | null = null
/** The empty room the capsule's page keeps either side of it: its --pad-x less the 3 px ring margin. */
const BAR_SIDE_ROOM = 61

/** How far from an overlay the pointer counts as near: closer, it's polled every 100 ms; further, every 400 ms. */
const HOVER_NEAR_PX = 120

function watchHover(on: boolean) {
  if (!on) {
    if (hoverTimer) clearTimeout(hoverTimer)
    hoverTimer = null
    if (getState().overlayHovered) patchState({ overlayHovered: false })
    tellPointer(undefined, { x: 0, y: 0 })
    return
  }
  if (hoverTimer) return
  const poll = () => {
    const p = screen.getCursorScreenPoint()
    const inside = (w: BrowserWindow, inset = 0, margin = 0) => {
      const b = w.getBounds()
      return p.x >= b.x + inset - margin && p.x < b.x + b.width - inset + margin && p.y >= b.y - margin && p.y < b.y + b.height + margin
    }
    const shown = [wins.controlBar, wins.chat].filter((w): w is BrowserWindow => !!w?.isVisible())
    // The capsule's window keeps empty room either side (styles.css, .island) and can reach down over the panel for a
    // popover or tooltip: a pointer in that room is on whatever is under it, not on the capsule.
    // The capsule's window is wider than its page (barWinW), which is centred in it.
    const inset = (w: BrowserWindow) => (w === wins.controlBar ? (barWinW() - bar.w) / 2 + BAR_SIDE_ROOM : 0)
    const win = shown.find((w) => inside(w, inset(w)))
    const hovered = !!win
    if (hovered !== getState().overlayHovered) patchState({ overlayHovered: hovered })
    tellPointer(win, p)
    // Far from every overlay, a slower poll is enough to notice the pointer coming back.
    const near = hovered || shown.some((w) => inside(w, inset(w), HOVER_NEAR_PX))
    hoverTimer = setTimeout(poll, near ? 100 : 400)
  }
  hoverTimer = setTimeout(poll, 100)
}

/** Where the pointer is in the overlay window under it (null: it left), for the page's tooltips, which get no hover events either. */
let pointer: { win: BrowserWindow; x: number; y: number } | null = null

function tellPointer(win: BrowserWindow | undefined, p: Electron.Point) {
  const b = win?.getBounds()
  const at = win && b ? { win, x: p.x - b.x, y: p.y - b.y } : null
  if (pointer && pointer.win !== win && !pointer.win.isDestroyed()) pointer.win.webContents.send('pointer:at', null)
  const moved = !pointer || pointer.win !== win || pointer.x !== at?.x || pointer.y !== at?.y
  if (at && moved) at.win.webContents.send('pointer:at', { x: at.x, y: at.y })
  pointer = at
}

// Drag and resize poll the cursor from main, so they keep working when the pointer leaves the window.
let tracking: { timer: NodeJS.Timeout; moved: boolean } | null = null

function track(onMove: (dx: number, dy: number) => void) {
  stopTracking()
  const start = screen.getCursorScreenPoint()
  const t = {
    moved: false,
    timer: setInterval(() => {
      const c = screen.getCursorScreenPoint()
      const dx = c.x - start.x
      const dy = c.y - start.y
      if (!t.moved && Math.hypot(dx, dy) < 4) return
      t.moved = true
      onMove(dx, dy)
    }, 16),
  }
  tracking = t
}

/** Returns true if the pointer moved (a drag), false for a plain click. */
export function stopTracking(): boolean {
  if (!tracking) return false
  clearInterval(tracking.timer)
  const moved = tracking.moved
  tracking = null
  place()
  return moved
}

export function startDrag() {
  if (getState().layout === 'ghost') return startGhostDrag()
  const from = pos ?? defaultPos()
  track((dx, dy) => {
    pos = { x: from.x + dx, y: from.y + dy }
    place()
  })
}

export function startResize() {
  // Capped at the room on screen: a height past it wouldn't show, and dragging back up would do nothing at first.
  const room = () => {
    const p = pos ?? defaultPos()
    return displayAt(p).workArea.height - bar.flow - GAP
  }
  const from = Math.min(chatH, room())
  track((_dx, dy) => {
    chatH = clamp(from + dy, 350, room())
    place()
  })
}

export function moveBy(dx: number, dy: number) {
  pos = pos ?? defaultPos()
  pos = { x: pos.x + dx, y: pos.y + dy }
  place()
}

/** The capsule back to the top centre; in Ghost, the strip back to its corner (⌃⌥⌘0). */
export function resetPosition() {
  if (getState().layout === 'ghost') ghostAt = null
  else pos = defaultPos()
  place()
}

let displayTimer: NodeJS.Timeout | undefined
export function onDisplaysChanged() {
  clearTimeout(displayTimer)
  displayTimer = setTimeout(place, 50)
}

/** The Follow-up window, on session `id` (or the newest). */
export function openFollowUp(id?: unknown) {
  const sid = typeof id === 'string' && /^[\w-]+$/.test(id) ? id : undefined
  patchState({ notesReady: null })
  const existing = wins.followup
  if (existing) {
    if (sid) existing.webContents.send('followup:open', sid)
    bringToFront(existing)
    return
  }
  const w = create('followup', { width: 920, height: 640, minWidth: 760, minHeight: 480, ...CHROMELESS('followup') }, sid ? `?id=${sid}` : '')
  w.once('ready-to-show', () => bringToFront(w))
}

/** `page` is optional; callers like menu clicks pass other arguments, so anything but a page name is ignored. */
export function openSettings(page?: unknown) {
  const p = typeof page === 'string' && /^[a-z]+$/.test(page) ? page : undefined
  const existing = wins.settings
  if (existing) {
    if (p) existing.webContents.send('settings:page', p)
    bringToFront(existing)
    return
  }
  const w = create('settings', { width: 920, height: 670, minWidth: 760, minHeight: 480, ...CHROMELESS('settings') }, p ? `?page=${p}` : '')
  w.once('ready-to-show', () => bringToFront(w))
  // Closing mid-recording skips the page's cleanup; without this every global hotkey stays off until relaunch.
  w.on('closed', () => patchState({ isRecordingShortcut: false }))
}
