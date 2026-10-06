// "Run" on Windows: Windows Terminal, or a PowerShell window, with a PowerShell wrapper that shows the commands and
// asks y/N before they run.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TerminalApp } from '../../../shared/state'
import { POWERSHELL } from '../system'

const WIN_APPS: Record<'Windows Terminal' | 'PowerShell', string> = {
  'Windows Terminal': path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'wt.exe'),
  PowerShell: POWERSHELL,
}
const PWSH = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')

// wt.exe is an app alias, which existsSync can't follow.
const present = (file: string) => !!fs.lstatSync(file, { throwIfNoEntry: false })

export const terminals = (): TerminalApp[] => (Object.keys(WIN_APPS) as (keyof typeof WIN_APPS)[]).filter((a) => present(WIN_APPS[a]))

/** PowerShell's version of the wrapper: the same review and y/N, then the commands dot-sourced into this session. */
export function psWrapper(commandsFile: string, commands: string, cleanup?: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`
  return [
    "Write-Host ''; Write-Host 'Glint wants to run:' -ForegroundColor White; Write-Host ''",
    `Write-Host ${q(commands)}`,
    "Write-Host ''; Write-Host 'Check these before you press y: commands can change or delete files, and AI can get them wrong.' -ForegroundColor Red",
    "Write-Host -NoNewline 'Run it? [y/N] '",
    "$__glint = if ([Console]::IsInputRedirected) { [Console]::In.ReadLine() } else { [string]$Host.UI.RawUI.ReadKey('IncludeKeyDown').Character }",
    'if ($__glint -match \'^[yY]\') {',
    "  Write-Host ''; Write-Host ''",
    `  . ${q(commandsFile)}`,
    '} else {',
    "  Write-Host ''; Write-Host 'Not run.'",
    '}',
    ...(cleanup ? [`Remove-Item -LiteralPath ${q(cleanup)} -Recurse -Force -ErrorAction SilentlyContinue`] : []),
    '',
  ].join('\r\n')
}

const BOM = String.fromCharCode(0xfeff)

export async function runInTerminal(commands: string, choice: TerminalApp, newWindow: boolean): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glint-run-'))
  const commandsFile = path.join(dir, 'commands.ps1')
  const wrap = path.join(dir, 'run.ps1')
  // A BOM, so Windows PowerShell reads the scripts as UTF-8.
  fs.writeFileSync(commandsFile, `${BOM}${commands}\r\n`)
  fs.writeFileSync(wrap, `${BOM}${psWrapper(commandsFile, commands, dir)}`)
  const have = terminals()
  const app = choice !== 'auto' && have.includes(choice) ? choice : have[0] ?? 'PowerShell'
  const shell = [fs.existsSync(PWSH) ? PWSH : POWERSHELL, '-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', wrap]
  const opts = { cwd: os.homedir(), stdio: 'ignore' as const }
  if (app === 'Windows Terminal') spawn(WIN_APPS[app], ['-w', newWindow ? 'new' : '0', 'new-tab', '-d', os.homedir(), ...shell], opts).unref()
  // start gives PowerShell a console window of its own; Windows paths can't hold quotes, so quoting them is safe.
  else spawn('cmd.exe', ['/d', '/c', `start "" ${shell.map((a) => (/[\s"]/.test(a) || a.includes('\\') ? `"${a}"` : a)).join(' ')}`], { ...opts, windowsVerbatimArguments: true }).unref()
  return app
}
