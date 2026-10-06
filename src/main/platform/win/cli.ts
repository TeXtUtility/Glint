import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { POWERSHELL, psArgs } from '../system'

let saved: Promise<string> | null = null

/** The saved PATH too, so a CLI installed since Glint started is found. */
export function shellPath(): Promise<string> {
  return (saved ??= new Promise((resolve) => {
    const script = "[Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')"
    execFile(POWERSHELL, psArgs(script), { timeout: 5000, windowsHide: true }, (err, out) => {
      const dirs = [path.join(os.homedir(), '.local', 'bin'), ...(process.env.PATH ?? '').split(';'), ...(err ? [] : out.trim().split(';'))]
      resolve([...new Set(dirs.filter(Boolean))].join(';'))
    })
  }))
}

/**
 * A CLI's program and leading arguments. npm installs a .cmd launcher on Windows, which only cmd.exe runs, and its
 * quoting mangles JSON and empty arguments, so the script the launcher points at runs with node instead.
 */
export async function cliCommand(name: string, PATH: string): Promise<[string, string[]]> {
  for (const dir of PATH.split(';')) {
    if (fs.existsSync(path.join(dir, `${name}.exe`))) return [path.join(dir, `${name}.exe`), []]
    const launcher = path.join(dir, `${name}.cmd`)
    if (!fs.existsSync(launcher)) continue
    const script = /"%dp0%\\([^"]+)"\s+%\*/.exec(await fs.promises.readFile(launcher, 'utf8'))?.[1]
    if (!script) continue
    const node = path.join(dir, 'node.exe')
    return [fs.existsSync(node) ? node : 'node', [path.join(dir, script)]]
  }
  return [name, []]
}
