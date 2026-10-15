import { spawn } from 'node:child_process'
import path from 'node:path'

export const system32 = (...p: string[]) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...p)

/** bsdtar on both: Windows 10 1803 and later ship it as tar.exe. */
export const TAR = process.platform === 'win32' ? system32('tar.exe') : '/usr/bin/tar'

export const POWERSHELL = system32('WindowsPowerShell', 'v1.0', 'powershell.exe')

export const psArgs = (script: string) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]

export function spawnLines(cmd: string, args: string[], onLine: (line: string) => void): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true })
    const timer = setTimeout(() => p.kill(), 30 * 60_000) // recognising a long scanned book takes minutes
    let stderr = ''
    let pending = ''
    p.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
      const lines = (pending + chunk).split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) onLine(line.trim())
    })
    p.on('error', reject)
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}
