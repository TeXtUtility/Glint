import assert from 'node:assert/strict'
import { test } from 'node:test'

test('isProtectedWindow: a password box is protected, an ordinary text box is not', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const { default: koffi } = await import('koffi')
  const { isProtectedWindow } = await import('./secure-field.ts')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const create = user32.func('void *CreateWindowExW(uint32_t ex, str16 cls, str16 name, uint32_t style, int x, int y, int w, int h, void *parent, void *menu, void *inst, void *param)')
  const destroy = user32.func('bool DestroyWindow(void *hwnd)')
  const inst = kernel32.func('void *GetModuleHandleW(void *name)')(null)
  // Never shown (no WS_VISIBLE): WS_POPUP edit boxes, one with ES_PASSWORD.
  const box = (password: boolean) => create(0, 'EDIT', '', 0x80000000 | (password ? 0x20 : 0), 0, 0, 100, 20, null, null, inst, null)
  const [secret, plain] = [box(true), box(false)]
  try {
    assert.ok(secret && plain)
    assert.equal(isProtectedWindow(secret), true)
    assert.equal(isProtectedWindow(plain), false)
  } finally {
    destroy(secret)
    destroy(plain)
  }
})
