// Whether the focused control is a password box, so Ghost's hook drops its keys the way macOS's secure input does.
// Windows marks password boxes STATE_SYSTEM_PROTECTED; this follows focus and asks each newly focused control.
// Runs on the hook's own thread (keys-worker.ts), whose message loop delivers the focus events.
import koffi from 'koffi'

const PROTECTED = 0x20000000
const OBJID_CLIENT = 0xfffffffc
const IID_IACCESSIBLE = new Uint8Array([0xe0, 0x36, 0x87, 0x61, 0x3d, 0x3c, 0xcf, 0x11, 0x81, 0x0c, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71])
const PTR = koffi.sizeof('void *')

type Fn = (...args: any[]) => any
type Proto = ReturnType<typeof koffi.proto>
let native: Record<'fromEvent' | 'fromWindow' | 'coInit' | 'setHook' | 'unhook', Fn> & Record<'getState' | 'release' | 'eventProc', Proto> | null = null
function lib() {
  if (native) return native
  const oleacc = koffi.load('oleacc.dll')
  const ole32 = koffi.load('ole32.dll')
  const user32 = koffi.load('user32.dll')
  koffi.struct('GlintVariant', { vt: 'uint16_t', r1: 'uint16_t', r2: 'uint16_t', r3: 'uint16_t', val: 'int32_t', pad: 'int32_t', more: 'int64_t' })
  const eventProc = koffi.proto('void GlintWinEvent(void *hook, uint32_t event, void *hwnd, int32_t obj, int32_t child, uint32_t thread, uint32_t time)')
  return (native = {
    fromEvent: oleacc.func('long AccessibleObjectFromEvent(void *hwnd, uint32_t id, uint32_t child, _Out_ void **acc, _Out_ GlintVariant *varChild)'),
    fromWindow: oleacc.func('long AccessibleObjectFromWindow(void *hwnd, uint32_t id, const uint8_t *riid, _Out_ void **acc)'),
    coInit: ole32.func('long CoInitializeEx(void *reserved, uint32_t mode)'),
    setHook: user32.func('void *SetWinEventHook(uint32_t min, uint32_t max, void *mod, GlintWinEvent *proc, uint32_t pid, uint32_t tid, uint32_t flags)'),
    unhook: user32.func('bool UnhookWinEvent(void *hook)'),
    // IAccessible's own methods, called through its vtable.
    getState: koffi.proto('long GlintGetAccState(void *self, GlintVariant child, _Out_ GlintVariant *state)'),
    release: koffi.proto('uint32_t GlintRelease(void *self)'),
    eventProc,
  })
}

const method = (obj: unknown, index: number) => koffi.decode(koffi.decode(obj, 'void *'), index * PTR, 'void *')

/** Whether this accessible object's child (or the object itself) is a protected control; it's released after. */
function isProtectedChild(acc: unknown, child: object): boolean {
  const n = lib()
  try {
    const state: { vt?: number; val?: number } = {}
    const hr = koffi.call(method(acc, 14), n.getState, acc, child, state) // get_accState
    return hr >= 0 && state.vt === 3 && ((state.val ?? 0) & PROTECTED) !== 0
  } finally {
    koffi.call(method(acc, 2), n.release, acc) // Release
  }
}

/** Whether a window (its client area) is a password box. */
export function isProtectedWindow(hwnd: unknown): boolean {
  const n = lib()
  n.coInit(null, 2) // COINIT_APARTMENTTHREADED; again on a thread that already has it is harmless
  const acc: unknown[] = [null]
  if (n.fromWindow(hwnd, OBJID_CLIENT, IID_IACCESSIBLE, acc) < 0 || !acc[0]) return false
  return isProtectedChild(acc[0], { vt: 3, r1: 0, r2: 0, r3: 0, val: 0, pad: 0, more: 0 })
}

/** Calls `onChange` whenever focus moves into or out of a password box. Returns the function that stops it. */
export function watchSecureFields(onChange: (secure: boolean) => void): () => void {
  const n = lib()
  n.coInit(null, 2)
  let secure = false
  const callback = koffi.register((_hook: unknown, _event: number, hwnd: unknown, obj: number, child: number) => {
    try {
      const acc: unknown[] = [null]
      const varChild = {}
      const now = n.fromEvent(hwnd, obj >>> 0, child >>> 0, acc, varChild) >= 0 && !!acc[0] && isProtectedChild(acc[0], varChild)
      if (now !== secure) onChange((secure = now))
    } catch {} // a control that won't answer counts as an ordinary one
  }, koffi.pointer(n.eventProc))
  const hook = n.setHook(0x8005, 0x8005, null, callback, 0, 0, 0) // EVENT_OBJECT_FOCUS, delivered by this thread's message loop
  return () => {
    if (hook) n.unhook(hook)
    koffi.unregister(callback)
  }
}
