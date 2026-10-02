import { contextBridge, ipcRenderer } from 'electron'

// The latest state, kept from before the page runs: its first render has it, and nothing sent before the page
// subscribed is missed. Main sends only the top-level keys that changed.
let state: Record<string, unknown> = ipcRenderer.sendSync('state:get-sync')
ipcRenderer.on('state:changed', (_e, changed: Record<string, unknown>) => (state = { ...state, ...changed }))

contextBridge.exposeInMainWorld('glint', {
  state: () => state,
  on(channel: string, cb: (payload: unknown) => void) {
    const listener = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => void ipcRenderer.removeListener(channel, listener)
  },
  send: (channel: string, payload?: unknown) => ipcRenderer.send(channel, payload),
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  platform: process.platform,
})
