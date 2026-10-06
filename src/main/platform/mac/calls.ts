// Which apps use the mic (macOS 14.2+ Core Audio), for call offers: never the audio, and window titles only while a
// browser has the mic.
import koffi from 'koffi'

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
