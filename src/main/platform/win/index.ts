// Glint on Windows.
import { desktopCapturer, nativeTheme, session, shell } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { WINDOWS_PROMPT } from '../../../shared/prompt'
import { nativeAccelerator } from '../../../shared/state'
import { mediaAccess } from '../media'
import { POWERSHELL, psArgs } from '../system'
import type { Bgr, Platform, WindowName } from '../types'
import { micUsers, openWindows } from './calls'
import { cliCommand, shellPath } from './cli'
import * as files from './files'
import { stopKeys, watchKeys } from './keys'
import { runInTerminal, terminals } from './terminal'

const captionButtons = (name: WindowName) =>
  ({ color: '#00000000', symbolColor: name === 'followup' || nativeTheme.shouldUseDarkColors ? '#ececf1' : '#1b1c23', height: 36 })
// Windows doesn't tint template images, so the tray's ring is drawn in the taskbar's own text colour.
const WHITE: Bgr = [0xff, 0xff, 0xff]
const DARK: Bgr = [0x20, 0x20, 0x20]

export const win: Platform = {
  name: 'Windows',
  words: {
    computer: 'PC',
    keyGone: "Windows can't unlock it",
    sessionKeyGone: "it was encrypted for a Windows account that can't unlock it anymore",
    callBlocked:
      "No sound from this PC's audio for a minute. If the other side of the call is talking, it may be playing on another " +
      'device: make it the default output in Windows, then pause and resume.',
  },
  prompt: WINDOWS_PROMPT,
  accelerator: (acc) => nativeAccelerator(acc, false),
  // The call is heard through Chromium's loopback: Glint's own page's getDisplayMedia gets the screen with system audio.
  start: (ownPage) =>
    session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
      if (!req.frame || !ownPage(req.frame.url)) return cb({})
      desktopCapturer.getSources({ types: ['screen'] }).then(([src]) => cb(src ? { video: src, audio: 'loopback' } : {}), () => cb({}))
    }),
  offerToMove: () => {},
  window: {
    chrome: (name) => ({ titleBarStyle: 'hidden', titleBarOverlay: captionButtons(name) }),
    restyle: (w, name) => w.setTitleBarOverlay(captionButtons(name)),
    overlay: {},
    // Forwarding works through a system-wide mouse hook on main's thread: any stall there would freeze every app's
    // mouse. Glint doesn't need it here, since main polls the pointer for the page (watchHover).
    clickThrough: (w, ignore) => w.setIgnoreMouseEvents(ignore),
    makeKey: () => false,
    preventActivation: () => {},
    setGlass: () => {},
    refitGlass: () => {},
  },
  appMenu: () => [],
  tray: {
    ring: () => ({ pt: 14, bgr: nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? WHITE : DARK }),
    title: false,
    checkboxes: true,
    sublabels: false,
  },

  // No screen permission; the mic one is the Privacy setting for all desktop apps.
  permissions: () => ({ mic: mediaAccess('microphone'), screen: 'granted' }),
  async requestPermission(kind) {
    if (kind === 'mic') await shell.openExternal('ms-settings:privacy-microphone')
  },

  callAudio: null,
  micUsers,
  openWindows,
  keys: { request: () => {}, watch: watchKeys, stop: stopKeys }, // nothing to ask
  terminals,
  runInTerminal,
  files,
  calendar: null,
  say: (text) =>
    spawn(POWERSHELL, psArgs('Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 1; $s.Speak($env:GLINT_SAY)'), {
      env: { ...process.env, GLINT_SAY: text },
      windowsHide: true,
    }),
  shellPath,
  cliCommand,
  installer: (raw, ref) => [POWERSHELL, psArgs(`irm '${raw}/${ref}/install.ps1' | iex`)],
  // No SIGUSR2 here: install.ps1 leaves this file instead, also when it was run by hand.
  onQuitRequest(userData, quit) {
    const file = path.join(userData, 'quit-for-update')
    fs.mkdirSync(userData, { recursive: true })
    fs.rmSync(file, { force: true }) // left by an installer that ran while Glint didn't
    // Polled: fs.watch never fired in copies started from the Start menu.
    setInterval(() => {
      if (!fs.existsSync(file)) return
      try {
        fs.rmSync(file, { force: true })
      } catch {} // still being written: it's the request all the same
      quit()
    }, 2000).unref()
  },
}
