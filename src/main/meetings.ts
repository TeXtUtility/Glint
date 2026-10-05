// Notices a call starting (an app starting to use the mic, macOS 14.2+ Core Audio) so Glint can offer to take notes.
// It reads which apps use the mic, never the audio; window titles only while a browser has the mic.
import koffi from 'koffi'
import { browserHasMic, callsNow } from '../shared/meetings'
import { phase } from '../shared/state'
import { getState, patchState } from './state'

let native: ReturnType<typeof load> | null = null
const lib = () => (native ??= load())

function load() {
  const ca = koffi.load('/System/Library/Frameworks/CoreAudio.framework/CoreAudio')
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
  const objc = koffi.load('/usr/lib/libobjc.A.dylib')
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit') // NSRunningApplication
  koffi.struct('GlintAudioAddress', { selector: 'uint32', scope: 'uint32', element: 'uint32' })
  const sel = objc.func('void *sel_registerName(str name)')
  const key = (name: string) => koffi.decode(cg.symbol(name), 'void *') // the CFString a CoreGraphics constant holds
  return {
    size: ca.func('int32 AudioObjectGetPropertyDataSize(uint32 obj, GlintAudioAddress *addr, uint32 qsize, void *q, _Out_ uint32 *size)'),
    data: ca.func('int32 AudioObjectGetPropertyData(uint32 obj, GlintAudioAddress *addr, uint32 qsize, void *q, _Inout_ uint32 *size, void *out)'),
    ref: ca.func('int32 AudioObjectGetPropertyData(uint32 obj, GlintAudioAddress *addr, uint32 qsize, void *q, _Inout_ uint32 *size, _Out_ void **out)'),
    cfString: cf.func('bool CFStringGetCString(void *s, _Out_ uint8_t *buf, long size, uint32 encoding)'),
    release: cf.func('void CFRelease(void *ref)'),
    windows: cg.func('void *CGWindowListCopyWindowInfo(uint32 option, uint32 relativeTo)'),
    count: cf.func('long CFArrayGetCount(void *array)'),
    at: cf.func('void *CFArrayGetValueAtIndex(void *array, long i)'),
    get: cf.func('void *CFDictionaryGetValue(void *dict, void *key)'),
    int: cf.func('bool CFNumberGetValue(void *n, long type, _Out_ int32_t *out)'),
    pidKey: key('kCGWindowOwnerPID'),
    titleKey: key('kCGWindowName'),
    // +[NSRunningApplication runningApplicationWithProcessIdentifier:], then -bundleIdentifier (an NSString is a CFString)
    apps: objc.func('void *objc_getClass(str name)')('NSRunningApplication'),
    appWithPid: sel('runningApplicationWithProcessIdentifier:'),
    bundleId: sel('bundleIdentifier'),
    sendPid: objc.func('void *objc_msgSend(void *self, void *sel, int32 pid)'),
    send: objc.func('void *objc_msgSend(void *self, void *sel)'),
    poolPush: objc.func('void *objc_autoreleasePoolPush()'),
    poolPop: objc.func('void objc_autoreleasePoolPop(void *pool)'),
  }
}

/** A CFString's text: '' for none, or for one longer than the buffer. */
function text(ref: unknown) {
  const buf = Buffer.alloc(1024)
  return ref && lib().cfString(ref, buf, buf.length, 0x08000100) ? buf.toString('utf8', 0, buf.indexOf(0)) : '' // UTF-8
}

const code = (s: string) => [...s].reduce((n, c) => (n << 8) | c.charCodeAt(0), 0) >>> 0
const address = (selector: string) => ({ selector: code(selector), scope: code('glob'), element: 0 })
const SYSTEM = 1 // kAudioObjectSystemObject

/** Bundle ids of the processes using the mic now. */
export function micUsers(): string[] {
  const n = lib()
  const size = [0]
  if (n.size(SYSTEM, address('prs#'), 0, null, size) || !size[0]) return [] // kAudioHardwarePropertyProcessObjectList
  const ids = new Uint32Array(size[0] / 4)
  if (n.data(SYSTEM, address('prs#'), 0, null, [size[0]], ids)) return []
  const out: string[] = []
  for (const id of ids) {
    const input = new Uint32Array(1)
    if (n.data(id, address('piri'), 0, null, [4], input) || !input[0]) continue // kAudioProcessPropertyIsRunningInput
    const ref: unknown[] = [null]
    if (n.ref(id, address('pbid'), 0, null, [8], ref) || !ref[0]) continue // kAudioProcessPropertyBundleID
    const bundle = text(ref[0])
    if (bundle) out.push(bundle) // command-line tools have none
    n.release(ref[0])
  }
  return out
}

/**
 * The open windows that have a title (minimised ones and other Spaces' too), each with the bundle id of the app that
 * owns it, which tells a browser's window from a call app's own. macOS gives titles with Screen Recording, which
 * screenshots already need; without it there are none.
 */
export function openWindows(): { app: string; title: string }[] {
  const n = lib()
  const list = n.windows(0, 0) // kCGWindowListOptionAll, every window
  if (!list) return []
  const pool = n.poolPush() // NSRunningApplication's answers are autoreleased; plain Node has no pool to drain them
  const apps = new Map<number, string>()
  const out: { app: string; title: string }[] = []
  try {
    for (let i = 0, count = n.count(list); i < count; i++) {
      const w = n.at(list, i)
      const title = text(n.get(w, n.titleKey))
      const pidRef = n.get(w, n.pidKey)
      const pid = [0]
      if (!title || !pidRef || !n.int(pidRef, 3, pid)) continue // kCFNumberSInt32Type
      if (!apps.has(pid[0])) apps.set(pid[0], text(n.send(n.sendPid(n.apps, n.appWithPid, pid[0]), n.bundleId)))
      out.push({ app: apps.get(pid[0])!, title })
    }
  } finally {
    n.poolPop(pool)
    n.release(list)
  }
  return out
}

let winNative: ReturnType<typeof loadWin> | null = null
const winLib = () => (winNative ??= loadWin())

function loadWin() {
  const advapi = koffi.load('advapi32.dll')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const proto = koffi.proto('bool GlintEnumWindows(void *hwnd, intptr_t param)')
  return {
    proto,
    open: advapi.func('long RegOpenKeyExW(intptr_t key, str16 sub, uint32_t opts, uint32_t sam, _Out_ intptr_t *out)'),
    enumKey: advapi.func('long RegEnumKeyExW(intptr_t key, uint32_t i, _Out_ uint16_t *name, _Inout_ uint32_t *len, void *r, void *c, void *cl, void *t)'),
    qword: advapi.func('long RegGetValueW(intptr_t key, str16 sub, str16 value, uint32_t flags, void *type, _Out_ uint64_t *data, _Inout_ uint32_t *size)'),
    close: advapi.func('long RegCloseKey(intptr_t key)'),
    enumWindows: user32.func('bool EnumWindows(GlintEnumWindows *cb, intptr_t param)'),
    visible: user32.func('bool IsWindowVisible(void *hwnd)'),
    title: user32.func('int GetWindowTextW(void *hwnd, _Out_ uint16_t *buf, int max)'),
    pidOf: user32.func('uint32_t GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'),
    openProcess: kernel32.func('void *OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
    imageName: kernel32.func('bool QueryFullProcessImageNameW(void *proc, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *len)'),
    closeHandle: kernel32.func('bool CloseHandle(void *h)'),
  }
}

const HKCU = -2147483647 // 0x80000001, sign-extended as Windows does
const utf16 = (buf: Uint16Array, len: number) => String.fromCharCode(...buf.subarray(0, len))

/** Subkeys of an open registry key. */
function subkeys(key: number): string[] {
  const n = winLib()
  const out: string[] = []
  for (let i = 0; ; i++) {
    const buf = new Uint16Array(512)
    const len = [buf.length]
    if (n.enumKey(key, i, buf, len, null, null, null, null)) return out
    out.push(utf16(buf, len[0]))
  }
}

/** Windows logs each app's mic use under ConsentStore; one whose last use hasn't stopped is using it now. */
export function micUsersWin(): string[] {
  const n = winLib()
  const root = [0]
  if (n.open(HKCU, 'Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone', 0, 0x20019, root)) return []
  const inUse = (key: number, sub: string) => {
    const [start, stop] = ['LastUsedTimeStart', 'LastUsedTimeStop'].map((v) => {
      const data = [0]
      return n.qword(key, sub, v, 0x40, null, data, [8]) ? 0 : Number(data[0])
    })
    return start > 0 && stop === 0
  }
  const out: string[] = []
  try {
    for (const app of subkeys(root[0])) {
      if (app !== 'NonPackaged') {
        if (inUse(root[0], app)) out.push(app.toLowerCase())
        continue
      }
      const np = [0]
      if (n.open(root[0], app, 0, 0x20019, np)) continue
      try {
        for (const exe of subkeys(np[0])) if (inUse(np[0], exe)) out.push(exe.split('#').at(-1)!.toLowerCase())
      } finally {
        n.close(np[0])
      }
    }
  } finally {
    n.close(root[0])
  }
  return out
}

/** Visible windows with a title, each with the exe that owns it. */
export function openWindowsWin(): { app: string; title: string }[] {
  const n = winLib()
  const exes = new Map<number, string>()
  const out: { app: string; title: string }[] = []
  const exeOf = (pid: number) => {
    if (!exes.has(pid)) {
      const proc = n.openProcess(0x1000, false, pid) // PROCESS_QUERY_LIMITED_INFORMATION
      const buf = new Uint16Array(1024)
      const len = [buf.length]
      exes.set(pid, proc && n.imageName(proc, 0, buf, len) ? utf16(buf, len[0]).split('\\').at(-1)!.toLowerCase() : '')
      if (proc) n.closeHandle(proc)
    }
    return exes.get(pid)!
  }
  const cb = koffi.register((hwnd: unknown) => {
    if (!n.visible(hwnd)) return true
    const buf = new Uint16Array(512)
    const len = n.title(hwnd, buf, buf.length)
    if (len <= 0) return true
    const pid = [0]
    n.pidOf(hwnd, pid)
    out.push({ app: exeOf(pid[0]), title: utf16(buf, len) })
    return true
  }, koffi.pointer(n.proto))
  try {
    n.enumWindows(cb, 0)
  } finally {
    koffi.unregister(cb)
  }
  return out
}

/** The calls going on now, by app name ("Zoom", "Google Meet"). */
export function currentCalls(): string[] {
  const win = process.platform === 'win32'
  if (process.platform !== 'darwin' && !win) return []
  const users = win ? micUsersWin() : micUsers()
  if (!users.length) return []
  return callsNow(users, browserHasMic(users) ? (win ? openWindowsWin() : openWindows()) : [])
}

/** Calls already offered (taken up, dismissed, or going on during a session), until they end. */
const offered = new Set<string>()

/**
 * Every 5 s while the offer is on and no session runs: a call that starts gets one offer to take notes (callDetected).
 * A call still going on when a session ends isn't offered (it's the one just recorded), and an offer goes when its call does.
 */
export function watchCalls() {
  let sessionEnded = false
  setInterval(() => {
    const s = getState()
    if (!s.meetingPrompt || phase(s) !== 'app') return void (s.callDetected && patchState({ callDetected: null }))
    if (s.session) return void (sessionEnded = true) // nothing is offered during one, so nothing is read
    let calls: string[]
    try {
      calls = currentCalls()
    } catch (err) {
      return console.warn('[calls]', (err as Error).message)
    }
    for (const c of offered) if (!calls.includes(c)) offered.delete(c)
    if (sessionEnded) {
      sessionEnded = false
      return calls.forEach((c) => offered.add(c))
    }
    if (s.callDetected && !calls.includes(s.callDetected)) patchState({ callDetected: null })
    const fresh = calls.find((c) => !offered.has(c))
    if (fresh) (offered.add(fresh), patchState({ callDetected: fresh }))
  }, 5000)
}
