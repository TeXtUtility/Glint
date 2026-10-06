// Updates rebuild from source: there's no signed release feed for electron-updater to use. The installer
// (install.sh) downloads the offered commit, builds and copies it in, then signals Glint (SIGUSR2) and waits: Glint quits
// once no session is live and its notes are written, and the installer swaps the app and reopens it.
import { app } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isNewer, type State } from '../shared/state'
import { shellPath } from './ai'
import { notesPending } from './history'
import { getState, patchState, subscribe } from './state'
import { POWERSHELL, psArgs } from './system'

declare const __GLINT_COMMIT__: string // electron.vite.config.ts; blank outside a git checkout

// The repo is public, so checks are plain HTTPS to GitHub's API (60 an hour per address, unsigned in; Glint uses a
// few), and the installer comes from raw.githubusercontent.com, like the README's install line.
const API = 'https://api.github.com/repos/TeXtUtility/Glint'
const RAW = 'https://raw.githubusercontent.com/TeXtUtility/Glint'
const BRANCH = { stable: 'main', beta: 'beta' } as const
const logFile = () => path.join(app.getPath('userData'), 'update.log')

// Patches merge, so every field an earlier update set is cleared unless given again.
const setUpdate = (u: State['update']) => patchState({ update: { version: undefined, message: undefined, channel: undefined, commits: undefined, ...u } })

export function initUpdates() {
  setTimeout(() => void checkForUpdate(), 30_000) // shortly after launch, out of startup's way
  setInterval(() => void checkForUpdate(), 60 * 60_000)
  // The installer sends this once the new build is copied in and waits for Glint to quit (install.sh, GLINT_PID).
  process.on('SIGUSR2', builtAndWaiting)
  // Windows has no SIGUSR2: install.ps1 leaves this file instead, also when it was run by hand.
  if (process.platform === 'win32') {
    const dir = app.getPath('userData')
    const file = path.join(dir, QUIT_FILE)
    fs.mkdirSync(dir, { recursive: true })
    fs.rmSync(file, { force: true }) // left by an installer that ran while Glint didn't
    // Polled: fs.watch never fired in copies started from the Start menu.
    setInterval(() => {
      if (!fs.existsSync(file)) return
      try {
        fs.rmSync(file, { force: true })
      } catch {} // still being written: it's the request all the same
      quitRequested = true
      builtAndWaiting()
    }, 2000).unref()
  }
  subscribe(quitIfReady)
  // Asked for during a session: it starts now that the session has ended.
  subscribe((s) => s.update.status === 'queued' && !s.session && void installUpdate())
  // Switching channel drops what the other one offered and checks the new one.
  subscribe((s, prev) => {
    if (s.updateChannel === prev.updateChannel || s.update.status === 'installing' || s.update.status === 'ready') return // a queued one is dropped
    setUpdate({ status: 'idle' })
    void checkForUpdate()
  })
}

const NOTES_WAIT_MS = 2 * 60_000
const QUIT_FILE = 'quit-for-update'
let retry: NodeJS.Timeout | undefined
let notesWaitFrom = 0
/** The full commit of the update on offer: the installer builds exactly it, even if the branch has moved on since. */
let offeredCommit = ''
/** install.ps1 run by hand, not by Update: it waits for Glint to quit all the same. */
let quitRequested = false

function builtAndWaiting() {
  const u = getState().update
  if (u.status === 'installing') setUpdate({ status: 'ready', version: u.version, channel: u.channel, commits: u.commits })
  quitIfReady()
}

/**
 * A live session finishes first: stopping it (by hand, tray, or the inactivity timeout) then quits for the update.
 * Its notes are written before quitting too, for up to two minutes; past that they show as failed, with a retry.
 */
function quitIfReady() {
  const s = getState()
  if (s.session) notesWaitFrom = 0 // a session started meanwhile: its notes get their own wait
  if ((s.update.status !== 'ready' && !quitRequested) || s.session) return
  clearTimeout(retry)
  notesWaitFrom ||= Date.now()
  if (notesPending() && Date.now() - notesWaitFrom < NOTES_WAIT_MS) retry = setTimeout(quitIfReady, 1000)
  else app.quit()
}

/** Background checks stay quiet on failure (e.g. offline); only a click shows the error. */
export async function checkForUpdate(manual = false) {
  const { status } = getState().update
  if (status === 'checking' || status === 'queued' || status === 'installing' || status === 'ready') return
  if (manual) setUpdate({ status: 'checking' })
  const channel = getState().updateChannel
  // Overtaken while this check ran (an install asked for or queued, or a switch to the other channel): that wins.
  const stale = () => getState().updateChannel !== channel || ['queued', 'installing', 'ready'].includes(getState().update.status)
  try {
    const offer = channel === 'beta' ? await betaUpdate() : await stableUpdate()
    if (stale()) return
    if (offer) {
      const { commit, ...shown } = offer
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("GitHub didn't say which commit the update is")
      offeredCommit = commit
      setUpdate({ status: 'available', ...shown })
    } else if (manual || status === 'available') setUpdate({ status: 'current' })
  } catch (err) {
    const e = err as Error & { status?: number }
    if (e.status === 404 && __GLINT_COMMIT__) {
      // This build's commit isn't on GitHub (built from unpushed work): nothing there is newer than it.
      if (!stale() && (manual || status === 'available')) setUpdate({ status: 'current' })
      return
    }
    if (manual && !stale()) setUpdate({ status: 'failed', message: e.message })
    else console.warn('[update] check failed:', e.message)
  }
}

/** GitHub's JSON answer; an error carries its HTTP status, so a commit GitHub hasn't got (404) can be told apart. */
async function github<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw Object.assign(new Error(`GitHub answered ${res.status} ${res.statusText}`.trim()), { status: res.status })
  return (await res.json()) as T
}

const headOf = async (branch: string) => (await github<{ sha: string }>(`${API}/commits/${branch}`)).sha
/** What `head` has that `base` doesn't: how many commits, the newest, and their first lines (oldest first). */
async function compare(base: string, head: string) {
  const c = await github<{ ahead_by: number; commits: { sha: string; commit: { message: string } }[] }>(`${API}/compare/${base}...${head}`)
  return { ahead: c.ahead_by, head: c.commits.at(-1)?.sha ?? '', subjects: c.commits.map((x) => x.commit.message.split('\n')[0]) }
}

type Offer = Pick<State['update'], 'version' | 'channel' | 'commits'> & { commit: string }

/** Releases bump the version. A build with commits main lacks (a beta) is offered main again, to go back. */
async function stableUpdate(): Promise<Offer | null> {
  const head = await headOf(BRANCH.stable)
  const latest = (await github<{ version?: unknown }>(`${RAW}/${head}/package.json`)).version
  if (typeof latest !== 'string') throw new Error("GitHub's package.json has no version")
  if (isNewer(latest, app.getVersion())) return { version: latest, channel: 'stable', commit: head }
  if (!__GLINT_COMMIT__) return null
  return (await compare(head, __GLINT_COMMIT__)).ahead ? { version: latest, channel: 'stable', commit: head } : null
}

/** Beta builds don't bump the version: any commit on the beta branch that this build lacks is an update. */
async function betaUpdate(): Promise<Offer | null> {
  if (!__GLINT_COMMIT__) {
    // Built outside a checkout, so which commit it is is unknown: offer the branch as it is.
    const head = await headOf(BRANCH.beta)
    return { version: head.slice(0, 7), channel: 'beta', commit: head }
  }
  const c = await compare(__GLINT_COMMIT__, BRANCH.beta)
  return c.ahead ? { version: c.head.slice(0, 7), channel: 'beta', commits: c.subjects.reverse().slice(0, 12), commit: c.head } : null
}

export async function installUpdate() {
  const s = getState()
  if (s.update.status === 'installing' || s.update.status === 'ready') return
  const { version, channel, commits } = s.update
  const branch = channel === 'beta' ? BRANCH.beta : BRANCH.stable
  const offer = { version, channel, commits }
  // Building takes a minute or two of full CPU, which would compete with the call: during a session it waits.
  if (s.session) return setUpdate({ status: 'queued', ...offer })
  setUpdate({ status: 'installing', ...offer })
  try {
    const out = fs.openSync(logFile(), 'w')
    // Detached so it outlives Glint: the installer quits Glint near the end, then reopens the new build. The installer
    // comes from the offered commit too, and builds that commit (GLINT_COMMIT), not whatever the branch has by now.
    const env = { ...process.env, PATH: await shellPath(), GLINT_PID: String(process.pid), GLINT_BRANCH: branch, GLINT_COMMIT: offeredCommit }
    const child = process.platform === 'win32'
      ? spawn(POWERSHELL, psArgs(`irm '${RAW}/${offeredCommit || branch}/install.ps1' | iex`), { detached: true, windowsHide: true, stdio: ['ignore', out, out], env })
      : spawn('/bin/bash', ['-c', `set -o pipefail; curl -fsSL "${RAW}/${offeredCommit || branch}/install.sh" | bash`], { detached: true, stdio: ['ignore', out, out], env })
    fs.closeSync(out)
    child.unref()
    child.on('error', (err) => setUpdate({ status: 'failed', ...offer, message: err.message }))
    // A successful install quits Glint before the installer exits, so reaching this at all means something went wrong.
    child.on('exit', (code, signal) => {
      const log = fs.readFileSync(logFile(), 'utf8')
      const message =
        signal ? `the installer was stopped (${signal})`
        : code === 0 ? "the installer finished but didn't restart Glint; quit Glint and open it again"
        : errorLine(log) || `installer exited with code ${code}`
      setUpdate({ status: 'failed', ...offer, message: `${message} (full log: ${logFile()})` })
    })
  } catch (err) {
    setUpdate({ status: 'failed', ...offer, message: (err as Error).message })
  }
}

/** Takes back "install after this session". */
export function cancelQueuedUpdate() {
  const { status, version, channel, commits } = getState().update
  if (status === 'queued') setUpdate({ status: 'available', version, channel, commits })
}

const lastLine = (text: string) => text.trim().split('\n').at(-1)?.replace(/^error: /, '') ?? ''
/** The installer's own `error:` line if it wrote one; build tools print pages of output after theirs. */
const errorLine = (log: string) => log.split('\n').findLast((l) => l.startsWith('error: '))?.slice(7) || lastLine(log)
