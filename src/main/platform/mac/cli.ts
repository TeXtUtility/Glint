import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

let loginPath: Promise<string> | null = null

/** Where CLIs install themselves (Claude Code's installer, Homebrew), in case the shell's PATH doesn't name them yet. */
const withKnown = (PATH: string) =>
  [...new Set([...PATH.split(':'), path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean))].join(':')

/** Apps launched from Finder get a bare PATH; borrow the login shell's so ~/.local/bin, Homebrew, nvm etc. resolve. */
export function shellPath(): Promise<string> {
  return (loginPath ??= new Promise((resolve) => {
    // printenv, not $PATH: fish joins its PATH list with spaces. Last line: profile scripts may print a greeting first.
    execFile(process.env.SHELL || '/bin/zsh', ['-lc', '/usr/bin/printenv PATH'], { timeout: 5000 }, (err, out) => {
      const path = out?.trim().split('\n').at(-1)
      if (err || !path) loginPath = null // a slow or failing profile at login: try again next time, not never
      resolve(withKnown(err || !path ? (process.env.PATH ?? '') : path))
    })
  }))
}

/** A command wasn't found: the next lookup reads the login shell's PATH again, for a CLI installed since. */
export function forgetShellPath() {
  loginPath = null
}

export const cliCommand = async (name: string): Promise<[string, string[]]> => [name, []]
