import { execFile } from 'node:child_process'
import os from 'node:os'

let loginPath: Promise<string> | null = null

/** Apps launched from Finder get a bare PATH; borrow the login shell's so ~/.local/bin, Homebrew, nvm etc. resolve. */
export function shellPath(): Promise<string> {
  return (loginPath ??= new Promise((resolve) => {
    // printenv, not $PATH: fish joins its PATH list with spaces. Last line: profile scripts may print a greeting first.
    execFile(process.env.SHELL || '/bin/zsh', ['-lc', '/usr/bin/printenv PATH'], { timeout: 5000 }, (err, out) => {
      const path = out?.trim().split('\n').at(-1)
      if (err || !path) loginPath = null // a slow or failing profile at login: try again next time, not never
      resolve(err || !path ? `${process.env.PATH}:${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin` : path)
    })
  }))
}

export const cliCommand = async (name: string): Promise<[string, string[]]> => [name, []]
