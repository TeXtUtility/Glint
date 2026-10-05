import path from 'node:path'

export const isMac = process.platform === 'darwin'
export const isWindows = process.platform === 'win32'
export const COMPUTER = isMac ? 'Mac' : 'PC'

export const system32 = (...p: string[]) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...p)

/** bsdtar on both: Windows 10 1803 and later ship it as tar.exe. */
export const TAR = isWindows ? system32('tar.exe') : '/usr/bin/tar'

export const POWERSHELL = system32('WindowsPowerShell', 'v1.0', 'powershell.exe')

export const psArgs = (script: string) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
