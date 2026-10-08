// Glint on Windows.
import { desktopCapturer, nativeTheme, session, shell } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { WINDOWS_PROMPT } from '../../../shared/prompt'
import { nativeAccelerator } from '../../../shared/state'
import { mediaAccess } from '../media'
import { POWERSHELL, psArgs, system32 } from '../system'
import type { Bgr, Platform, WindowName } from '../types'
import * as calendar from './calendar'
import { micUsers, openWindows } from './calls'
import { cliCommand, shellPath } from './cli'
import { blurred, dropFocus, preventActivation, takeFocus } from './focus'
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
    preventActivation,
    takeFocus,
    dropFocus,
    blurred,
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
  calendar: { access: calendar.access, request: calendar.request, events: calendar.events, openSettings: () => {} }, // Outlook asks nothing
  say: (text) =>
    spawn(POWERSHELL, psArgs('Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 1; $s.Speak($env:GLINT_SAY)'), {
      env: { ...process.env, GLINT_SAY: text },
      windowsHide: true,
    }),
  shellPath,
  cliCommand,
  // A detached PowerShell gets no console and quits without running anything, so cmd starts it. cmd is in the job Node
  // ends along with Glint; PowerShell, its child, breaks away from it (libuv's job lets children's children go), so the
  // installer outlives Glint quitting for it, while cmd's exit still reports an install that failed before then.
  runInstaller(raw, ref, log, env) {
    // -Command, not -EncodedCommand, which writes host lines and errors to the log as CLIXML. No double quotes inside.
    const script = `$ProgressPreference = 'SilentlyContinue'; irm '${raw}/${ref}/install.ps1' | iex`
    const out = fs.openSync(log, 'w')
    try {
      const ps = `"${POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${script}"`
      return spawn(system32('cmd.exe'), ['/d', '/s', '/c', `"${ps}"`], { windowsVerbatimArguments: true, windowsHide: true, stdio: ['ignore', out, out], env })
    } finally {
      fs.closeSync(out)
    }
  },
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
