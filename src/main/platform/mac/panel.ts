import type { BrowserWindow } from 'electron'
import koffi from 'koffi'
import type { GlassRect } from '../types'

// Electron's `type: 'panel'` still builds a plain NSWindow, and AppKit ignores the nonactivating-panel
// mask on those (electron/electron#35815), so clicking an overlay activates Glint and greys out the app
// the user was in. What actually blocks activation is a WindowServer tag that AppKit sets through the
// private -[NSWindow _setPreventsActivation:]; we call it directly via the Objective-C runtime.

type Fn = (...args: unknown[]) => any
type Runtime = Record<'sel' | 'cls' | 'send' | 'sendBool' | 'responds' | 'performLater' | 'initRect' | 'setRect' | 'sendInt' | 'sendDouble' | 'sendObj' | 'sendStr' | 'addSub' | 'isTrue', Fn>
let rt: Runtime | null = null

function runtime() {
  if (rt) return rt
  const objc = koffi.load('/usr/lib/libobjc.A.dylib')
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit') // NSVisualEffectView, NSAppearance
  const NSRect = koffi.struct('NSRect', { x: 'double', y: 'double', w: 'double', h: 'double' })
  // Pointers travel as uint64 (same register on arm64/x64), avoiding koffi pointer wrappers. objc_msgSend takes each
  // method's own signature, so it's declared once per shape.
  rt = {
    sel: objc.func('sel_registerName', 'uint64_t', ['str']),
    cls: objc.func('objc_getClass', 'uint64_t', ['str']),
    send: objc.func('objc_msgSend', 'uint64_t', ['uint64_t', 'uint64_t']),
    sendBool: objc.func('objc_msgSend', 'void', ['uint64_t', 'uint64_t', 'bool']),
    responds: objc.func('objc_msgSend', 'bool', ['uint64_t', 'uint64_t', 'uint64_t']),
    // -performSelector:withObject:afterDelay:
    performLater: objc.func('objc_msgSend', 'void', ['uint64_t', 'uint64_t', 'uint64_t', 'uint64_t', 'double']),
    initRect: objc.func('objc_msgSend', 'uint64_t', ['uint64_t', 'uint64_t', NSRect]),
    setRect: objc.func('objc_msgSend', 'void', ['uint64_t', 'uint64_t', NSRect]),
    sendInt: objc.func('objc_msgSend', 'void', ['uint64_t', 'uint64_t', 'int64_t']),
    sendDouble: objc.func('objc_msgSend', 'void', ['uint64_t', 'uint64_t', 'double']),
    sendObj: objc.func('objc_msgSend', 'uint64_t', ['uint64_t', 'uint64_t', 'uint64_t']),
    sendStr: objc.func('objc_msgSend', 'uint64_t', ['uint64_t', 'uint64_t', 'str']),
    // -addSubview:positioned:relativeTo:
    addSub: objc.func('objc_msgSend', 'void', ['uint64_t', 'uint64_t', 'uint64_t', 'int64_t', 'uint64_t']),
    isTrue: objc.func('objc_msgSend', 'bool', ['uint64_t', 'uint64_t']),
  }
  return rt
}

function nsWindowOf(win: BrowserWindow) {
  const r = runtime()
  return r.send(win.getNativeWindowHandle().readBigUInt64LE(0), r.sel('window')) as bigint // [NSView window]
}

/** Give the panel key focus without activating the app (Spotlight-style). Returns false if the caller should fall back. */
export function makeKey(win: BrowserWindow): boolean {
  try {
    const r = runtime()
    // Must not run inline: becoming key fires Electron's 'focus' handler, which re-enters JS while we're
    // still inside this FFI call and trips a V8 check (SIGTRAP). Queue it for the next run-loop pass.
    r.performLater(nsWindowOf(win), r.sel('performSelector:withObject:afterDelay:'), r.sel('makeKeyWindow'), 0, 0)
    return true
  } catch (err) {
    console.warn('[panel] makeKeyWindow failed:', err)
    return false
  }
}

/** Stop clicks on this window from activating the app. Returns false if unsupported (logged, not thrown). */
export function preventActivation(win: BrowserWindow): boolean {
  try {
    const r = runtime()
    const nsWindow = nsWindowOf(win)
    const setter = r.sel('_setPreventsActivation:')
    if (!nsWindow || !r.responds(nsWindow, r.sel('respondsToSelector:'), setter)) {
      console.warn('[panel] _setPreventsActivation: unavailable; overlay clicks will activate Glint')
      return false
    }
    r.sendBool(nsWindow, setter, true)
    return true
  } catch (err) {
    console.warn('[panel] could not make overlay nonactivating:', err)
    return false
  }
}

const glass = new WeakMap<BrowserWindow, unknown[]>()
/**
 * Each window's last rects, the page width they were measured at, and how much of a width change moves them: 0.5 for
 * pages that centre their surfaces, 1 or 0 for Ghost's strip, pinned to a right or left corner.
 */
const shapes = new WeakMap<BrowserWindow, { rects: GlassRect[]; vw: number; ax: number }>()

/**
 * Blurs what's behind each surface of a transparent window: a macOS vibrancy view per rect, clipped to its corners,
 * under the page, which paints its own translucent glass on top. CSS backdrop-filter can't see other apps, and
 * whole-window vibrancy would show in the window's empty margins.
 */
export function setGlass(win: BrowserWindow, rects: GlassRect[], vw: number, ax = 0.5) {
  shapes.set(win, { rects, vw, ax })
  refitGlass(win)
}

/**
 * Places the last rects in the window as it is now. A window that has changed width since they were measured moves
 * them by their share of the change (see shapes); main calls this as it resizes, in the same frame.
 */
export function refitGlass(win: BrowserWindow) {
  const last = shapes.get(win)
  if (!last) return
  const { rects } = last
  try {
    const r = runtime()
    const content = r.send(nsWindowOf(win), r.sel('contentView'))
    if (!content) return
    const flipped = r.isTrue(content, r.sel('isFlipped'))
    const [width, height] = win.getContentSize()
    const dx = (width - last.vw) * last.ax
    const views = glass.get(win) ?? []
    while (views.length < rects.length) views.push(effectView(r, content, flipped))
    views.forEach((v, i) => {
      const g = rects[i]
      r.sendBool(v, r.sel('setHidden:'), !g)
      if (!g) return
      r.setRect(v, r.sel('setFrame:'), { x: g.x + dx, y: flipped ? g.y : height - g.y - g.h, w: g.w, h: g.h })
      r.sendDouble(r.send(v, r.sel('layer')), r.sel('setCornerRadius:'), g.r)
      r.sendDouble(v, r.sel('setAlphaValue:'), g.a)
    })
    glass.set(win, views)
  } catch (err) {
    console.warn('[panel] glass blur failed:', err)
  }
}

function effectView(r: Runtime, content: unknown, flipped: boolean) {
  const v = r.initRect(r.send(r.cls('NSVisualEffectView'), r.sel('alloc')), r.sel('initWithFrame:'), { x: 0, y: 0, w: 0, h: 0 })
  // Stay put under the page when the window grows or shrinks: the page's rects are from its top, and they aren't
  // re-sent when only the window changes (a menu or tooltip making it taller). An unflipped view is laid out from the
  // bottom, so its bottom margin must be the one that stretches (NSViewMinYMargin); a flipped one already keeps its top.
  if (!flipped) r.sendInt(v, r.sel('setAutoresizingMask:'), 8)
  r.sendInt(v, r.sel('setMaterial:'), 13) // NSVisualEffectMaterialHUDWindow
  r.sendInt(v, r.sel('setBlendingMode:'), 0) // behind the window
  r.sendInt(v, r.sel('setState:'), 1) // always active: the overlay's app is never the frontmost one
  const name = r.sendStr(r.cls('NSString'), r.sel('stringWithUTF8String:'), 'NSAppearanceNameDarkAqua')
  r.sendObj(v, r.sel('setAppearance:'), r.sendObj(r.cls('NSAppearance'), r.sel('appearanceNamed:'), name))
  r.sendBool(v, r.sel('setWantsLayer:'), true)
  r.sendBool(r.send(v, r.sel('layer')), r.sel('setMasksToBounds:'), true)
  r.addSub(content, r.sel('addSubview:positioned:relativeTo:'), v, -1, 0) // NSWindowBelow everything: under the page
  return v
}

