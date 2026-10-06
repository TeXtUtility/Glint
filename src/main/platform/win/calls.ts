// Which apps use the mic on Windows, for call offers: its own log of mic use, and window titles only while a browser
// has the mic.
import koffi from 'koffi'
import os from 'node:os'

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
    // Not GetWindowTextW: for Glint's own windows that sends WM_GETTEXT, which can deadlock on a busy thread.
    title: user32.func('int InternalGetWindowText(void *hwnd, _Out_ uint16_t *buf, int max)'),
    pidOf: user32.func('uint32_t GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'),
    openProcess: kernel32.func('void *OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
    imageName: kernel32.func('bool QueryFullProcessImageNameW(void *proc, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *len)'),
    closeHandle: kernel32.func('bool CloseHandle(void *h)'),
    enumProcesses: kernel32.func('bool K32EnumProcesses(_Out_ uint32_t *pids, uint32_t size, _Out_ uint32_t *used)'),
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

/** Full paths of the programs running now, lower-cased. */
export function runningExes(): Set<string> {
  const n = winLib()
  const pids = new Uint32Array(4096)
  const bytes = [0]
  if (!n.enumProcesses(pids, pids.byteLength, bytes)) return new Set()
  const out = new Set<string>()
  for (const pid of pids.subarray(0, bytes[0] / 4)) {
    const proc = n.openProcess(0x1000, false, pid) // PROCESS_QUERY_LIMITED_INFORMATION
    if (!proc) continue
    const buf = new Uint16Array(1024)
    const len = [buf.length]
    if (n.imageName(proc, 0, buf, len)) out.add(utf16(buf, len[0]).toLowerCase())
    n.closeHandle(proc)
  }
  return out
}

/**
 * Windows logs each app's mic use under ConsentStore, and a use with no stop is going on now. Not always: one cut off
 * (a crash, an update mid-call, a power-off) never gets its stop, so a use only counts if it began since boot and,
 * for a desktop app, that exact program is still running.
 */
export function micUsers(): string[] {
  const n = winLib()
  const root = [0]
  if (n.open(HKCU, 'Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone', 0, 0x20019, root)) return []
  const bootMs = Date.now() - os.uptime() * 1000
  const inUse = (key: number, sub: string) => {
    const [start, stop] = ['LastUsedTimeStart', 'LastUsedTimeStop'].map((v) => {
      const data = [0]
      return n.qword(key, sub, v, 0x40, null, data, [8]) ? 0 : Number(data[0])
    })
    return stop === 0 && start / 10_000 - 11_644_473_600_000 > bootMs // FILETIME: 100 ns since 1601
  }
  let running: Set<string> | null = null
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
        for (const exe of subkeys(np[0])) {
          if (!inUse(np[0], exe) || !(running ??= runningExes()).has(exe.replace(/#/g, '\\').toLowerCase())) continue
          out.push(exe.split('#').at(-1)!.toLowerCase())
        }
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
export function openWindows(): { app: string; title: string }[] {
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
