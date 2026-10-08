import assert from 'node:assert/strict'
import { test } from 'node:test'

test('overlays stay activatable to Chromium; only WS_EX_NOACTIVATE turns on and off', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const { default: koffi } = await import('koffi')
  const focus = await import('./focus.ts')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const create = user32.func('intptr_t CreateWindowExW(uint32_t ex, str16 cls, str16 name, uint32_t style, int x, int y, int w, int h, void *parent, void *menu, void *inst, void *param)')
  const destroy = user32.func('bool DestroyWindow(intptr_t hwnd)')
  const getLong = user32.func('intptr_t GetWindowLongPtrW(intptr_t hwnd, int index)')
  const inst = kernel32.func('void *GetModuleHandleW(void *name)')(null)
  const hwnd = create(0, 'STATIC', '', 0x80000000, 0, 0, 10, 10, null, null, inst, null) // WS_POPUP, never shown
  const noActivate = () => (BigInt(getLong(hwnd, -20)) & 0x08000000n) !== 0n
  const handle = Buffer.alloc(8)
  handle.writeBigUInt64LE(BigInt(hwnd))
  const calls: string[] = []
  let focused = false
  const win = {
    isDestroyed: () => false,
    getNativeWindowHandle: () => handle,
    setFocusable: (v: boolean) => calls.push(`setFocusable(${v})`),
    setSkipTaskbar: (v: boolean) => calls.push(`setSkipTaskbar(${v})`),
    isFocused: () => focused,
    focus: () => ((focused = true), calls.push('focus')),
    blur: () => ((focused = false), calls.push('blur')),
  } as unknown as import('electron').BrowserWindow
  try {
    focus.preventActivation(win)
    assert.equal(noActivate(), true)
    focus.takeFocus(win)
    assert.equal(noActivate(), false, 'typing: the keys can come')
    focus.blurred(win)
    assert.equal(noActivate(), true, 'the user went elsewhere: clicks no longer activate it')
    focus.takeFocus(win)
    focused = false // not handing the keys back for real: that would change the foreground window on this desktop
    focus.dropFocus(win)
    assert.equal(noActivate(), true)
    // Chromium throws away clicks on a window it thinks can't activate: Glint must never tell it so.
    assert.ok(!calls.includes('setFocusable(false)'), calls.join(', '))
    assert.deepEqual(calls.slice(0, 2), ['setFocusable(true)', 'setSkipTaskbar(true)'])
  } finally {
    destroy(hwnd)
  }
})
