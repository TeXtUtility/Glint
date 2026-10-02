// Main's console also goes to a file, so there's something to send when a user reports a bug: packaged builds have
// no console to read. ~/Library/Logs/Glint/main.log, moved aside to main.old.log past 5 MB at launch. Main logs
// errors, counts and timings, never transcript, prompt or answer text; developer tools (Settings → About) add
// `verbose` lines of the same kind.
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { format } from 'node:util'

const MAX_BYTES = 5_000_000
/** Lines kept in memory for the Developer page's live log. */
const RECENT_LINES = 1000

export const logFile = () => path.join(app.getPath('logs'), 'main.log')
const recent: string[] = []
let verboseOn = false

/** Developer tools switched on or off. */
export const setVerbose = (on: boolean) => void (verboseOn = on)
/** Detail for bug reports, logged only with developer tools on. Timings and counts, never what was said. */
export function verbose(...args: unknown[]) {
  if (verboseOn) console.log('[verbose]', ...args)
}

/** The latest lines, for the live log. */
export const logTail = () => recent.join('\n')

/** A bug report: `header` (version, system, settings), then the whole log, the older file first. */
export function bugReport(header: string): string {
  const read = (f: string) => {
    try {
      return fs.readFileSync(f, 'utf8')
    } catch {
      return ''
    }
  }
  const old = read(path.join(path.dirname(logFile()), 'main.old.log'))
  return `${header}\n\n--- log ---\n${old}${read(logFile())}`
}

export function initLog() {
  const file = logFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) fs.renameSync(file, path.join(path.dirname(file), 'main.old.log'))
  } catch {}
  const out = fs.createWriteStream(file, { flags: 'a', mode: 0o600 })
  out.on('error', () => {}) // a full disk mustn't take logging (or the app) down
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const write = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      write(...args)
      const line = `${new Date().toISOString()} ${level} ${format(...args)}`
      out.write(`${line}\n`)
      recent.push(line)
      if (recent.length > RECENT_LINES) recent.shift()
    }
  }
}
