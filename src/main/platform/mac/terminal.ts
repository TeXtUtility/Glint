// "Run" on a Mac: iTerm and Terminal get the commands in a window that's already open and idle; the others, which
// can't be scripted that way, in a new window. A zsh or bash wrapper shows them and asks y/N before they run.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { TerminalApp } from '../../../shared/state'

const run = promisify(execFile)

/** Where each terminal lives, in the order "Automatic" prefers them. */
const APPS: Record<Exclude<TerminalApp, 'auto' | 'Windows Terminal' | 'PowerShell'>, string> = {
  iTerm: '/Applications/iTerm.app',
  Ghostty: '/Applications/Ghostty.app',
  kitty: '/Applications/kitty.app',
  WezTerm: '/Applications/WezTerm.app',
  Alacritty: '/Applications/Alacritty.app',
  Terminal: '/System/Applications/Utilities/Terminal.app',
}

/** The terminals this Mac has. */
export const terminals = (): TerminalApp[] => (Object.keys(APPS) as (keyof typeof APPS)[]).filter((a) => fs.existsSync(APPS[a]))

/** "Automatic": a terminal that's already open, else the first installed. */
async function pick(choice: TerminalApp): Promise<keyof typeof APPS> {
  const have = terminals() as (keyof typeof APPS)[]
  if (choice in APPS && have.includes(choice as keyof typeof APPS)) return choice as keyof typeof APPS
  try {
    const { stdout } = await run('/bin/ps', ['-axo', 'comm='])
    const open = have.find((a) => stdout.includes(`${path.basename(APPS[a])}/`))
    if (open) return open
  } catch {}
  return have[0] ?? 'Terminal'
}

/** Foreground processes of a terminal tab (`ps -o stat=,comm= -t <tty>`) that are only its shell: nothing is running. */
export function idleTty(ps: string): boolean {
  const fg = ps.split('\n').map((l) => l.trim().split(/\s+/)).filter(([stat]) => stat?.includes('+'))
  return fg.length > 0 && fg.every(([, ...cmd]) => /^-?(zsh|bash|fish|sh|dash|ksh|tcsh|csh)$/.test(path.basename(cmd.join(' '))))
}

async function idle(tty: string): Promise<boolean> {
  try {
    const { stdout } = await run('/bin/ps', ['-o', 'stat=,comm=', '-t', path.basename(tty)])
    return idleTty(stdout)
  } catch {
    return false
  }
}

/**
 * The wrapper sourced in the user's shell: show the commands, ask, and only on y run them in that same shell.
 * `cleanup`: a folder to delete once it's done (its own temp folder), so the commands don't sit on disk.
 */
export function wrapper(shell: 'zsh' | 'bash', commandsFile: string, commands: string, cleanup?: string): string {
  const end = `__GLINT_${randomBytes(6).toString('hex')}__`
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const ask = shell === 'zsh'
    ? `read -q "?Run it? [y/N] "`
    : `read -r -n 1 -p "Run it? [y/N] " __glint_ans && [[ $__glint_ans == [yY] ]]`
  return [
    `printf '\\n\\033[1mGlint wants to run:\\033[0m\\n\\n'`,
    `cat <<'${end}'`,
    commands,
    end,
    `printf '\\n\\033[31mCheck these before you press y: commands can change or delete files, and AI can get them wrong.\\033[0m\\n'`,
    `if ${ask}; then`,
    `  printf '\\n\\n'`,
    `  source ${q(commandsFile)}`,
    'else',
    `  printf '\\nNot run.\\n'`,
    'fi',
    ...(cleanup ? [`rm -rf ${q(cleanup)}`] : []),
    '',
  ].join('\n')
}

const osa = (script: string, ...args: string[]) => run('/usr/bin/osascript', ['-e', script, ...args]).then((r) => r.stdout.trim())

// Terminal: the first open window whose tab is idle, else a new window (it has no scripting for tabs). Launched just
// now, the window it opens by itself.
const TERMINAL = `on run argv
  set cmd to item 1 of argv
  set wasRunning to application "Terminal" is running
  tell application "Terminal"
    activate
    if not wasRunning then
      repeat 30 times
        if (count of windows) > 0 then exit repeat
        delay 0.1
      end repeat
      if (count of windows) > 0 then return do script cmd in window 1
    end if
    if item 2 of argv is "reuse" then
      repeat with w in windows
        if not (miniaturized of w) and not (busy of selected tab of w) then
          set index of w to 1
          return do script cmd in selected tab of w
        end if
      end repeat
    end if
    do script cmd
  end tell
end run`

// iTerm: each window's id and the tty of the session showing in it, front first.
const ITERM_LIST = `tell application "iTerm"
  set out to ""
  repeat with w in windows
    try
      set out to out & (id of w) & " " & (tty of current session of w) & linefeed
    end try
  end repeat
  return out
end tell`

const ITERM_WRITE = `on run argv
  tell application "iTerm"
    set w to window id ((item 2 of argv) as integer)
    select w
    activate
    tell current session of w to write text (item 1 of argv)
  end tell
end run`

// "tab": a new tab in the front window; "window": a new window; "launch": iTerm was closed, so the window it opens.
const ITERM_NEW = `on run argv
  set mode to item 2 of argv
  tell application "iTerm"
    activate
    if mode is "launch" then
      repeat 30 times
        if (count of windows) > 0 then exit repeat
        delay 0.1
      end repeat
    end if
    if mode is "window" or (count of windows) is 0 then
      set w to (create window with default profile)
    else if mode is "tab" then
      set w to current window
      if w is missing value then set w to window 1
      tell w to create tab with default profile
    else
      set w to window 1
    end if
    tell current session of w to write text (item 1 of argv)
  end tell
end run`

/** An idle iTerm session in any open window, else a new tab, else (iTerm closed, or `newWindow`) a new window. */
async function runInITerm(typed: string, newWindow: boolean) {
  const running = (await osa('application "iTerm" is running')) === 'true'
  if (!running) return void (await osa(ITERM_NEW, typed, 'launch'))
  if (newWindow) return void (await osa(ITERM_NEW, typed, 'window'))
  for (const line of (await osa(ITERM_LIST)).split('\n')) {
    const [id, tty] = line.trim().split(' ')
    if (id && tty && (await idle(tty))) return void (await osa(ITERM_WRITE, typed, id))
  }
  await osa(ITERM_NEW, typed, 'tab')
}

/** Opens the terminal on the commands, behind the y/N prompt: in an idle window already open, unless `newWindow`. */
export async function runInTerminal(commands: string, choice: TerminalApp, newWindow: boolean): Promise<string> {
  const shellPath = os.userInfo().shell || process.env.SHELL || '/bin/zsh'
  const shell = shellPath.endsWith('bash') ? 'bash' : 'zsh' // other shells: zsh runs the prompt, then the commands
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glint-run-'))
  const commandsFile = path.join(dir, 'commands.sh')
  const wrap = path.join(dir, 'run.sh')
  fs.writeFileSync(commandsFile, `${commands}\n`, { mode: 0o600 })
  fs.writeFileSync(wrap, wrapper(shell, commandsFile, commands, dir), { mode: 0o600 })

  const app = await pick(choice)
  const source = `source '${wrap}'`
  // Typed at a prompt, which may hold half-typed text: Ctrl-E Ctrl-U clear the line first so the two can't join into
  // one command. The leading space keeps it out of history where the shell skips those.
  const typed = `\x05\x15 ${source}`
  const sh = shell === 'bash' ? '/bin/bash' : '/bin/zsh'
  // A fresh interactive login shell for terminals without scripting: it runs the prompt, then stays open.
  const fresh = [sh, '-lic', `${source}; exec ${sh} -l`]
  switch (app) {
    case 'Terminal':
      await osa(TERMINAL, typed, newWindow ? 'new' : 'reuse')
      break
    case 'iTerm':
      await runInITerm(typed, newWindow)
      break
    case 'Ghostty':
    case 'Alacritty':
      await run('/usr/bin/open', ['-na', APPS[app], '--args', '-e', ...fresh])
      break
    case 'kitty':
      await run('/usr/bin/open', ['-na', APPS[app], '--args', ...fresh])
      break
    case 'WezTerm':
      await run('/usr/bin/open', ['-na', APPS[app], '--args', 'start', '--', ...fresh])
      break
  }
  return app
}
