import type { BrowserWindow, BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron'
import type { ChildProcess } from 'node:child_process'
import type { CalendarEvent } from '../../shared/meetings'
import type { Perm, TerminalApp } from '../../shared/state'

export type KeyInput = { type: 'text'; text: string } | { type: 'backspace' }
export type CalendarAccess = 'granted' | 'denied' | 'ask'
export type FileProgress = (p: { done: number; total: number; ocr: boolean }) => void
/** A surface of the page, in its CSS pixels (points), with its corner radius and opacity. */
export interface GlassRect { x: number; y: number; w: number; h: number; r: number; a: number }
export type Bgr = [number, number, number]
export type WindowName = 'controlBar' | 'chat' | 'onboarding' | 'settings' | 'followup'

/** Everything Glint does differently on each OS. Shared code calls this and never checks the platform itself. */
export interface Platform {
  /** For bug reports: "macOS", "Windows". */
  name: string
  words: {
    /** As in "this Mac". */
    computer: string
    /** Why a saved key can't be decrypted any more. */
    keyGone: string
    /** Why a saved session can't be decrypted any more. */
    sessionKeyGone: string
    /** The call has been exact silence for a minute while the user talks. */
    callBlocked: string
  }
  /** Added to every ask's system prompt, or ''. */
  prompt: string
  /** Shortcuts are stored as on a Mac; this is what Electron registers here. */
  accelerator(acc: string): string

  /** Once at boot, before any window. `ownPage` tells Glint's own pages from anything else. */
  start(ownPage: (url: string) => boolean): void
  /** Offers once to move a packaged Glint where it belongs, if the OS cares. */
  offerToMove(): void
  window: {
    /** Settings, setup and follow-up: no title bar. */
    chrome(name: WindowName): BrowserWindowConstructorOptions
    /** Their chrome again, after the theme changes. */
    restyle(win: BrowserWindow, name: WindowName): void
    /** Every overlay window. */
    overlay: BrowserWindowConstructorOptions
    /** `ignore`: clicks go through the window to whatever is under it. */
    clickThrough(win: BrowserWindow, ignore: boolean): void
    /** Clicks reach the window without activating Glint, as on a Mac panel. */
    preventActivation(win: BrowserWindow): void
    /** The keys, for typing in an overlay, keeping the user's app in front where the OS can. */
    takeFocus(win: BrowserWindow): void
    /** The keys back to the app the user was in; clicks still reach the window. */
    dropFocus(win: BrowserWindow): void
    /** The window lost the keys because the user went elsewhere. */
    blurred(win: BrowserWindow): void
    setGlass(win: BrowserWindow, rects: GlassRect[], vw: number, ax: number): void
    refitGlass(win: BrowserWindow): void
  }
  /** The app menu's first entries. */
  appMenu(a: { openSettings: () => void; hide: () => void; quit: () => void }): MenuItemConstructorOptions[]
  tray: {
    /** The idle icon's size in points, and its colour; none: a template image the OS tints. */
    ring(): { pt: number; bgr?: Bgr }
    /** The session timer beside the icon; else it goes in the tooltip. */
    title: boolean
    /** Toggles use the menu's own checkmarks; else a tick in the label. */
    checkboxes: boolean
    /** Menu items show sublabels; else they join the label. */
    sublabels: boolean
  }

  permissions(): { mic: Perm; screen: Perm }
  /** Asks, or opens the OS's settings where it's allowed. */
  requestPermission(kind: 'mic' | 'screen'): Promise<void>

  /** The call's audio heard in main (16 kHz PCM16 chunks); null when the chat window captures it (pushCall). */
  callAudio: { start(onPcm16: (bytes: Uint8Array) => void, onFailed: (err: Error) => void): Promise<() => Promise<void>> } | null
  /** Apps using the mic now, as callsNow knows them: bundle ids, exe names, Store packages. */
  micUsers(): string[]
  /** Titled windows, with the app that owns each. */
  openWindows(): { app: string; title: string }[]
  /** Keystrokes typed into any app, for Ghost. */
  keys: {
    /** Asks, or opens the OS's settings where it's allowed. */
    request(): void
    /** False if they can't be watched yet (not allowed). New handlers replace the old ones. */
    watch(onKey: (k: KeyInput) => void, onDoubleControl: () => void): boolean
    stop(): void
  }
  terminals(): TerminalApp[]
  /** Opens the commands, already checked, behind the y/N prompt. Returns the terminal used. */
  runInTerminal(commands: string, choice: TerminalApp, newWindow: boolean): Promise<string>
  files: {
    /** PDFs, images, Word and other formats only the OS's own tools read. */
    extract(file: string, ext: string, onProgress?: FileProgress): Promise<{ text: string; pages?: number }>
    unzip(file: string, into: string): Promise<unknown>
    /** HTML files as one text, in order. */
    htmlText(files: string[]): Promise<string>
  }
  /** null where Glint can't read calendars. */
  calendar: {
    /** Whether Glint may read them; never shows a prompt. */
    access(): Promise<CalendarAccess>
    /** The OS's prompt, the first time; after that, the answer given. */
    request(): Promise<CalendarAccess>
    /** Events from six hours before `at` to an hour after. */
    events(at: number): Promise<CalendarEvent[]>
    openSettings(): void
  } | null
  /** Speaks a line through the speakers, for the sample call. */
  say(text: string): ChildProcess
  /** PATH for the CLIs Glint runs, as the user's own shell has it. */
  shellPath(): Promise<string>
  /** A CLI's program and leading arguments. */
  cliCommand(name: string, PATH: string): Promise<[string, string[]]>
  /** Starts the installer for `ref` (a commit or branch) from GitHub, output in `log`. It outlives Glint quitting for it. */
  runInstaller(raw: string, ref: string, log: string, env: NodeJS.ProcessEnv): ChildProcess
  /** The installer asks Glint to quit once the new build is in place. */
  onQuitRequest(userData: string, quit: () => void): void
}
