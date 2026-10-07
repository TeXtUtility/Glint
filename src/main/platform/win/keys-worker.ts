// Windows: a listen-only low-level keyboard hook, on a thread of its own so Windows never drops it for answering late.
// Every key goes on to the app it was typed in; none typed in a password box is seen. Ended by WM_QUIT (stopKeys).
import koffi from 'koffi'
import { parentPort } from 'node:worker_threads'
import { ControlDoubleTap } from '../../../shared/typing'
import { parseWinKey } from './keys-parse'
import { watchSecureFields } from './secure-field'

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const KBD = koffi.struct('GlintKbd', { vk: 'uint32_t', scan: 'uint32_t', flags: 'uint32_t', time: 'uint32_t', extra: 'uintptr_t' })
const proto = koffi.proto('intptr_t GlintHookProc(int code, uintptr_t wParam, void *info)')
const setHook = user32.func('void *SetWindowsHookExW(int id, GlintHookProc *proc, void *mod, uint32_t thread)')
const nextHook = user32.func('intptr_t CallNextHookEx(void *hook, int code, uintptr_t wParam, void *info)')
const unhook = user32.func('bool UnhookWindowsHookEx(void *hook)')
const getMessage = user32.func('int GetMessageW(_Out_ uint8_t *msg, void *hwnd, uint32_t min, uint32_t max)')
const asyncState = user32.func('int16_t GetAsyncKeyState(int vk)')
const keyState = user32.func('int16_t GetKeyState(int vk)')
const toUnicode = user32.func('int ToUnicodeEx(uint32_t vk, uint32_t scan, uint8_t *state, _Out_ uint16_t *buf, int n, uint32_t flags, void *hkl)')
const foreground = user32.func('void *GetForegroundWindow()')
const threadOf = user32.func('uint32_t GetWindowThreadProcessId(void *hwnd, void *pid)')
const layoutOf = user32.func('void *GetKeyboardLayout(uint32_t thread)')
const threadId = kernel32.func('uint32_t GetCurrentThreadId()')

const VK = { shift: 0x10, control: 0x11, alt: 0x12, lcontrol: 0xa2, rcontrol: 0xa3, ralt: 0xa5, lwin: 0x5b, rwin: 0x5c, capital: 0x14 }
const CONTROLS = [VK.control, VK.lcontrol, VK.rcontrol]
const OTHER_MODIFIERS = [0x10, 0xa0, 0xa1, 0x12, 0xa4, 0xa5, VK.lwin, VK.rwin]
const isDown = (vk: number) => asyncState(vk) < 0
const taps = new ControlDoubleTap()

function text(vk: number, scan: number): string {
  const state = new Uint8Array(256)
  for (const m of [0x10, 0xa0, 0xa1, 0x11, 0xa2, 0xa3, 0x12, 0xa4, 0xa5]) if (isDown(m)) state[m] = 0x80
  if (keyState(VK.capital) & 1) state[VK.capital] = 1
  const buf = new Uint16Array(8)
  // Flag 4 leaves the keyboard state alone, so a dead key still composes in the app it was typed in.
  const n = toUnicode(vk, scan, state, buf, buf.length, 4, layoutOf(threadOf(foreground(), null)))
  return n > 0 ? String.fromCharCode(...buf.subarray(0, n)) : ''
}

let secure = false
let stopSecure = () => {}
try {
  stopSecure = watchSecureFields((s) => (secure = s))
} catch (err) {
  parentPort!.postMessage({ t: 'error', message: `password boxes can't be told apart: ${err}` })
}

let hook: unknown = null
const callback = koffi.register((code: number, wParam: number, info: unknown) => {
  try {
    if (code >= 0) {
      const { vk, scan } = koffi.decode(info, KBD) as { vk: number; scan: number }
      const down = wParam === 0x100 || wParam === 0x104 // WM_KEYDOWN, WM_SYSKEYDOWN
      const now = Date.now()
      if (CONTROLS.includes(vk)) {
        if (taps.flags(down, OTHER_MODIFIERS.some(isDown), now)) parentPort!.postMessage({ t: 'ctrl2' })
      } else if (OTHER_MODIFIERS.includes(vk)) {
        if (down) taps.flags(CONTROLS.some(isDown), true, now)
      } else if (down) {
        taps.key()
        if (secure) return nextHook(hook, code, wParam, info)
        const mods = { ctrl: isDown(VK.control), alt: isDown(VK.alt), win: isDown(VK.lwin) || isDown(VK.rwin), altGr: isDown(VK.ralt) }
        const key = parseWinKey(vk, mods, text(vk, scan))
        if (key) parentPort!.postMessage({ t: 'key', key })
      }
    }
  } catch (err) {
    parentPort!.postMessage({ t: 'error', message: String(err) })
  }
  return nextHook(hook, code, wParam, info)
}, koffi.pointer(proto))

hook = setHook(13, callback, null, 0) // WH_KEYBOARD_LL
parentPort!.postMessage(hook ? { t: 'ready', thread: threadId() } : { t: 'error', message: "Windows didn't allow the keyboard hook" })
const msg = new Uint8Array(48)
if (hook) while (getMessage(msg, null, 0, 0) > 0);
if (hook) unhook(hook)
stopSecure()
koffi.unregister(callback)
process.exit(0)
