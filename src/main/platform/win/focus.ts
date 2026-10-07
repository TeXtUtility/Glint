// Overlays on Windows as nonactivating as a Mac panel: a click reaches them without bringing Glint forward, and typing
// in one gives the keys back to the app the user was in when it's done.
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
const hwndOf = (win: BrowserWindow) => win.getNativeWindowHandle().readBigUInt64LE(0)

/** The app the user was typing in before an overlay took the keys. */
let previous: bigint | number = 0
/** Windows Chromium will let activate (Electron's isFocusable() can't say, since it also reads WS_EX_NOACTIVATE). */
const activatable = new WeakSet<BrowserWindow>()

/**
 * Clicks reach the window without activating Glint. Chromium throws away a click on a window it thinks can't activate
 * (MA_NOACTIVATEANDEAT), so the window stays activatable to Chromium and WS_EX_NOACTIVATE keeps clicks from activating it.
 */
export function preventActivation(win: BrowserWindow) {
  const n = lib()
  if (!activatable.has(win)) {
    win.setFocusable(true) // also lifts WS_EX_NOACTIVATE and lists the window in the taskbar; both go back below
    win.setSkipTaskbar(true)
    activatable.add(win)
  }
  const ex = BigInt(n.getLong(hwndOf(win), GWL_EXSTYLE))
  if (!(ex & WS_EX_NOACTIVATE)) n.setLong(hwndOf(win), GWL_EXSTYLE, ex | WS_EX_NOACTIVATE)
}

export function takeFocus(win: BrowserWindow) {
  const n = lib()
  const fg = n.foreground()
  const pid = [0]
  if (fg && n.pidOf(fg, pid) && pid[0] !== process.pid) previous = fg
  win.setFocusable(true) // lifts WS_EX_NOACTIVATE
  win.setSkipTaskbar(true)
  win.focus()
}

export function dropFocus(win: BrowserWindow) {
  const n = lib()
  if (win.isFocused()) {
    // blur() would hand the keys to whatever window is next down, not to the app the user came from.
    if (!(previous && n.isWindow(previous) && n.setForeground(previous))) win.blur()
  }
  preventActivation(win)
}
