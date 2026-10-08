// Overlays on Windows as nonactivating as a Mac panel: a click reaches them without bringing Glint forward, and typing
// in one gives the keys back to the app the user was in when it's done.
//
// Chromium throws away a click on a window it thinks can't activate (MA_NOACTIVATEANDEAT), and Electron's
// setFocusable(false) makes it think so. So overlays stay activatable to Chromium for good, and only WS_EX_NOACTIVATE,
// switched off while the user types in one, keeps clicks from activating Glint.
import type { BrowserWindow } from 'electron'
import koffi from 'koffi'

type Fn = (...args: any[]) => any
let native: Record<'getLong' | 'setLong' | 'foreground' | 'setForeground' | 'isWindow' | 'pidOf', Fn> | null = null
const lib = () => {
  if (native) return native
  const user32 = koffi.load('user32.dll')
  return (native = {
    getLong: user32.func('intptr_t GetWindowLongPtrW(intptr_t hwnd, int index)'),
    setLong: user32.func('intptr_t SetWindowLongPtrW(intptr_t hwnd, int index, intptr_t value)'),
    foreground: user32.func('intptr_t GetForegroundWindow()'),
    setForeground: user32.func('bool SetForegroundWindow(intptr_t hwnd)'),
    isWindow: user32.func('bool IsWindow(intptr_t hwnd)'),
    pidOf: user32.func('uint32_t GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)'),
  })
}

const GWL_EXSTYLE = -20
const WS_EX_NOACTIVATE = 0x08000000n

function noActivate(win: BrowserWindow, on: boolean) {
  if (win.isDestroyed()) return
  const n = lib()
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0)
  const ex = BigInt(n.getLong(hwnd, GWL_EXSTYLE))
  const next = on ? ex | WS_EX_NOACTIVATE : ex & ~WS_EX_NOACTIVATE
  if (next !== ex) n.setLong(hwnd, GWL_EXSTYLE, next)
}

/** The app the user was typing in before an overlay took the keys. */
let previous: bigint | number = 0

/** Once, as the overlay is made. Electron's setFocusable(true) also lists the window in the taskbar; it's taken off. */
export function preventActivation(win: BrowserWindow) {
  win.setFocusable(true)
  win.setSkipTaskbar(true)
  noActivate(win, true)
}

export function takeFocus(win: BrowserWindow) {
  const n = lib()
  const fg = n.foreground()
  const pid = [0]
  if (fg && n.pidOf(fg, pid) && pid[0] !== process.pid) previous = fg
  noActivate(win, false)
  win.focus()
}

export function dropFocus(win: BrowserWindow) {
  const n = lib()
  if (win.isFocused()) {
    // blur() would hand the keys to whatever window is next down, not to the app the user came from.
    if (!(previous && n.isWindow(previous) && n.setForeground(previous))) win.blur()
  }
  noActivate(win, true)
}

/** The user went elsewhere: clicks stop activating it again. */
export const blurred = (win: BrowserWindow) => noActivate(win, true)
