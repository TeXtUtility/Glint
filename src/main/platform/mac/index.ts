// Glint on macOS.
import { app, desktopCapturer, dialog, shell, systemPreferences } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { nativeAccelerator } from '../../../shared/state'
import { flushState, getState, patchState } from '../../state'
import { mediaAccess } from '../media'
import type { Platform } from '../types'
import * as audio from './audio'
import * as calendar from './calendar'
import { micUsers, openWindows } from './calls'
import { cliCommand, shellPath } from './cli'
import * as files from './files'
import { requestKeys, stopKeys, watchKeys } from './keys'
import { makeKey, preventActivation, refitGlass, setGlass } from './panel'
import { runInTerminal, terminals } from './terminal'

const pane = (name: string) => shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${name}`)

/** Offered once: running from Downloads or a disk image breaks permissions and updates. Moving relaunches. */
function offerToMove() {
  if (!app.isPackaged || getState().movePromptShown || app.isInApplicationsFolder()) return
  patchState({ movePromptShown: true })
  flushState() // keep "asked once" even though moving relaunches immediately
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    message: 'Move Glint to your Applications folder?',
    detail: 'Running it from another folder, like Downloads, can break its permissions and updates.',
    buttons: ['Move to Applications', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  })
  if (choice !== 0) return
  try {
    app.moveToApplicationsFolder()
  } catch (err) {
    console.error('[move] failed:', err)
    dialog.showMessageBoxSync({ type: 'error', message: "Couldn't move Glint", detail: String((err as Error).message) })
  }
}

export const mac: Platform = {
  name: 'macOS',
  words: {
    computer: 'Mac',
    keyGone: 'the keychain key that protected it is gone',
    sessionKeyGone: 'it was encrypted with a keychain key this Mac no longer has',
    callBlocked:
      "No sound from this Mac's audio for a minute. If the other side of the call is talking, macOS may be blocking Glint " +
      'from hearing it: allow Glint in System Settings → Privacy & Security → Screen & System Audio Recording (Screen ' +
      'Recording on macOS 14), then pause and resume.',
  },
  prompt: '',
  accelerator: (acc) => nativeAccelerator(acc, true),
  start: () => app.dock?.hide(), // packaged builds also set LSUIElement, so the icon never flashes
  offerToMove,
  window: {
    // The window buttons inset over the page (styles.css).
    chrome: () => ({ titleBarStyle: 'hiddenInset' }),
    restyle: () => {},
    overlay: { type: 'panel' },
    clickThrough: (win, ignore) => win.setIgnoreMouseEvents(ignore, { forward: true }),
    preventActivation,
    takeFocus(win) {
      win.setFocusable(true)
      // Always re-assert, even if Electron thinks it's key already: after a click in another overlay (the capsule's
      // chat-box button) macOS can still send the keys elsewhere, and a click into the input must fix that.
      if (makeKey(win)) win.webContents.focus()
      else win.focus() // focus() activates the app; makeKey keeps the user's app frontmost
    },
    dropFocus(win) {
      if (!win.isFocusable()) return
      win.blur()
      win.setFocusable(false)
    },
    blurred: (win) => win.setFocusable(false),
    setGlass,
    refitGlass,
  },
  appMenu: ({ openSettings, hide, quit }) => [
    {
      label: app.name,
      submenu: [
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { type: 'separator' },
        { role: 'close' }, // Cmd+W closes Settings; overlays ignore it
        { label: 'Hide Glint', accelerator: 'CmdOrCtrl+H', click: hide },
        { label: 'Quit Glint', accelerator: 'CmdOrCtrl+Q', click: quit },
      ],
    },
  ],
  tray: { ring: () => ({ pt: 10 }), title: true, checkboxes: false, sublabels: true },

  permissions: () => ({ mic: mediaAccess('microphone'), screen: mediaAccess('screen') }),
  async requestPermission(kind) {
    if (kind === 'mic' && systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone')
    } else if (kind === 'screen') {
      // A throwaway capture registers the app in the Screen Recording list and triggers the prompt.
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {})
      if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') await pane('ScreenCapture')
    } else {
      await pane('Microphone')
    }
  },

  callAudio: audio,
  micUsers,
  openWindows,
  // The first time, macOS shows its own prompt; after a denial it only lists Glint, so open the right pane too.
  keys: { request: () => void (requestKeys() || pane('ListenEvent')), watch: watchKeys, stop: stopKeys },
  terminals,
  runInTerminal,
  files,
  calendar: { ...calendar, openSettings: () => void pane('Calendars') },
  say: (text) => spawn('/usr/bin/say', ['-r', '185', text]),
  shellPath,
  cliCommand,
  runInstaller(raw, ref, log, env) {
    const out = fs.openSync(log, 'w')
    try {
      return spawn('/bin/bash', ['-c', `set -o pipefail; curl -fsSL "${raw}/${ref}/install.sh" | bash`], { detached: true, stdio: ['ignore', out, out], env })
    } finally {
      fs.closeSync(out)
    }
  },
  // install.sh, started by Update with GLINT_PID.
  onQuitRequest: (_userData, quit) => void process.on('SIGUSR2', quit),
}
