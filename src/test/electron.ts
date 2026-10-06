// What the main-process modules under test use of Electron, faked (setup.ts points 'electron' here). Tests swap a
// method with mock.method, or add what they need.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glint-test-'))
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }))
const paths: Record<string, string> = {}

/** Points userData at a new, empty folder, removed with the rest when the test process exits. */
export function freshUserData() {
  paths.userData = fs.mkdtempSync(path.join(root, 'userData-'))
  return paths.userData
}
freshUserData()

export const app = {
  getPath: (name: string) => paths[name] ?? root,
  setPath: (name: string, p: string) => void (paths[name] = p),
  getVersion: () => '0.0.0',
  on: () => app,
  quit: () => {},
}

/** Reversible and not encryption: enough to round-trip, and to fail on bytes it didn't write. */
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`fake:${Buffer.from(text).toString('base64')}`),
  decryptString: (data: Buffer) => {
    const s = data.toString()
    if (!s.startsWith('fake:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
    return Buffer.from(s.slice(5), 'base64').toString()
  },
}

export const shell = {
  trashItem: async (p: string) => fs.rmSync(p),
  openPath: async () => '',
}

export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }) }
export const globalShortcut = { register: () => true, unregisterAll: () => {} }
export const nativeImage = {}
export const net = {}
export const nativeTheme = { shouldUseDarkColors: false, shouldUseDarkColorsForSystemIntegratedUI: false }
export const systemPreferences = { getMediaAccessStatus: () => 'granted' }
export const desktopCapturer = { getSources: async () => [] }
export const session = {}
