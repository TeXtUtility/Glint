// Keystrokes typed into any app, for Ghost: a listen-only macOS event tap. It sees keys as they're typed and never
// changes, blocks or records them; each one goes straight to the Ghost strip to move it along, and nowhere else.
// It also sees modifier changes, for Ghost's double-tap Control. macOS asks for Input Monitoring the first time;
// secure fields (passwords) are never seen at all.
import koffi from 'koffi'
import { ControlDoubleTap } from '../shared/typing'

export type KeyInput = { type: 'text'; text: string } | { type: 'backspace' }

type Fn = (...args: any[]) => any
let native: {
  tapCreate: Fn; tapEnable: Fn; getField: Fn; getFlags: Fn; getUnicode: Fn; preflight: Fn; request: Fn
  createSource: Fn; mainLoop: Fn; addSource: Fn; removeSource: Fn; invalidate: Fn; release: Fn; commonModes: unknown
  proto: ReturnType<typeof koffi.proto>
} | null = null

function lib() {
  if (native) return native
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
  const proto = koffi.proto('void *GlintTapCallback(void *proxy, uint32_t type, void *event, void *info)')
  native = {
    proto,
    tapCreate: cg.func('void *CGEventTapCreate(uint32_t tap, uint32_t place, uint32_t options, uint64_t mask, GlintTapCallback *cb, void *info)'),
    tapEnable: cg.func('void CGEventTapEnable(void *tap, bool enable)'),
    getField: cg.func('int64_t CGEventGetIntegerValueField(void *event, uint32_t field)'),
    getFlags: cg.func('uint64_t CGEventGetFlags(void *event)'),
    getUnicode: cg.func('void CGEventKeyboardGetUnicodeString(void *event, unsigned long max, _Out_ unsigned long *len, _Out_ uint16_t *buf)'),
    preflight: cg.func('bool CGPreflightListenEventAccess()'),
    request: cg.func('bool CGRequestListenEventAccess()'),
    createSource: cf.func('void *CFMachPortCreateRunLoopSource(void *alloc, void *port, long order)'),
    mainLoop: cf.func('void *CFRunLoopGetMain()'),
    addSource: cf.func('void CFRunLoopAddSource(void *loop, void *source, void *mode)'),
    removeSource: cf.func('void CFRunLoopRemoveSource(void *loop, void *source, void *mode)'),
    invalidate: cf.func('void CFMachPortInvalidate(void *port)'),
    release: cf.func('void CFRelease(void *ref)'),
    commonModes: koffi.decode(cf.symbol('kCFRunLoopCommonModes', 'void *'), 'void *'),
  }
  return native
}

const KEY_DOWN = 10
const FLAGS_CHANGED = 12
const TAP_DISABLED = [0xfffffffe, 0xffffffff] // by timeout, by user input: switch it back on
const KEYCODE_FIELD = 9
const COMMAND = 1 << 20
const CONTROL = 1 << 18
const OTHER_MODIFIERS = (1 << 17) | (1 << 19) | COMMAND // Shift, Option, Command
const KEY = { return: 36, keypadEnter: 76, tab: 48, delete: 51, forwardDelete: 117 }

/** What a key means for typing along: text, a backspace, or nothing (shortcuts, arrows, function keys). */
export function parseKey(keycode: number, flags: bigint | number, chars: string): KeyInput | null {
  if (BigInt(flags) & BigInt(COMMAND | CONTROL)) return null // a shortcut, not typing
  if (keycode === KEY.delete || keycode === KEY.forwardDelete) return { type: 'backspace' }
  if (keycode === KEY.return || keycode === KEY.keypadEnter) return { type: 'text', text: '\n' }
  if (keycode === KEY.tab) return { type: 'text', text: '\t' }
  // Arrows and function keys come through as private-use characters; control codes aren't typing either.
  const text = [...chars].filter((c) => !/[-]/.test(c) && !/[\u0000-\u001F\u007F]/.test(c)).join('')
  return text ? { type: 'text', text } : null
}

/** A key-down event (a CGEventRef) as typing input. */
export function readKey(event: unknown): KeyInput | null {
  const n = lib()
  const len = [0]
  const buf = new Uint16Array(8)
  n.getUnicode(event, buf.length, len, buf)
  return parseKey(Number(n.getField(event, KEYCODE_FIELD)), n.getFlags(event), String.fromCharCode(...buf.subarray(0, len[0])))
}

let tap: { port: unknown; source: unknown; callback: ReturnType<typeof koffi.register> } | null = null

/** Has Glint been allowed to see keystrokes (Input Monitoring)? */
export const keysAllowed = () => process.platform === 'darwin' && !!lib().preflight()

/** Asks macOS for Input Monitoring: the first time it shows the system prompt, after that it opens nothing. */
export const requestKeys = () => process.platform === 'darwin' && !!lib().request()

let handlers: { onKey: (k: KeyInput) => void; onDoubleControl: () => void } = { onKey: () => {}, onDoubleControl: () => {} }
const controlTaps = new ControlDoubleTap()

/**
 * Starts watching keystrokes, and Control for a double tap. False when Input Monitoring isn't allowed (nothing is
 * watched then). Handlers are replaced on each call, so a running tap picks up new ones.
 */
export function watchKeys(onKey: (k: KeyInput) => void, onDoubleControl: () => void): boolean {
  handlers = { onKey, onDoubleControl }
  if (tap) return true
  if (!keysAllowed()) return false
  const n = lib()
  const callback = koffi.register((_proxy: unknown, type: number, event: unknown) => {
    try {
      if (TAP_DISABLED.includes(type)) n.tapEnable(tap?.port, true)
      else if (type === FLAGS_CHANGED) {
        const flags = BigInt(n.getFlags(event))
        if (controlTaps.flags(!!(flags & BigInt(CONTROL)), !!(flags & BigInt(OTHER_MODIFIERS)), Date.now())) handlers.onDoubleControl()
      } else if (type === KEY_DOWN) {
        controlTaps.key()
        const k = readKey(event)
        if (k) handlers.onKey(k)
      }
    } catch (err) {
      console.error('[keys]', err) // never let an error escape into the event tap
    }
    return event
  }, koffi.pointer(n.proto))
  // Session tap, appended, listen-only: sees keys after the system has handled its own shortcuts, and can't alter them.
  const port = n.tapCreate(1, 1, 1, BigInt((1 << KEY_DOWN) | (1 << FLAGS_CHANGED)), callback, null)
  if (!port) {
    koffi.unregister(callback)
    return false
  }
  const source = n.createSource(null, port, 0)
  n.addSource(n.mainLoop(), source, n.commonModes)
  n.tapEnable(port, true)
  tap = { port, source, callback }
  return true
}

export function stopKeys() {
  if (!tap) return
  const n = lib()
  n.tapEnable(tap.port, false)
  n.removeSource(n.mainLoop(), tap.source, n.commonModes)
  n.invalidate(tap.port)
  n.release(tap.source)
  n.release(tap.port)
  koffi.unregister(tap.callback)
  tap = null
}
