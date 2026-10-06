// Mode reference files. Each file's text is taken out once, kept encrypted on disk, and sent in full with every ask
// while its mode is active: the model reads the whole thing, and the API caches it, so later asks read it at a
// fraction of the price. Nothing is summarised or left out. Past MODE_FILES_WHOLE_CHARS, each ask gets the passages
// that best match it instead (src/shared/search.ts). PDF, EPUB, Word and images use what macOS ships with
// (PDFKit, textutil, Vision), so there's nothing extra to install; Windows has its own (platform/).
import { app, dialog, safeStorage, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { buildIndex, NO_PASSAGES, search, type Passages, type SearchIndex } from '../shared/search'
import { MODE_FILES_MAX_CHARS, searchesFiles, type Mode, type State } from '../shared/state'
import { getState, patchState } from './state'
import { platform } from './platform'
import { DOCUMENTS, IMAGES } from './platform/formats'
import { isUtf8 } from '../shared/doctext'
import { withTemp } from './temp'
import type { FileProgress as Progress } from './platform/types'

const dir = () => path.join(app.getPath('userData'), 'mode-files')
const blobOf = (id: string) => path.join(dir(), `${id}.glint`)
const texts = new Map<string, string>() // decrypted, by file id
/** Search indexes, by mode, for the files they were built from (their ids): other files mean a rebuild. */
const indexes = new Map<string, { files: string; index: SearchIndex }>()
const FILE_MAX_BYTES = 300 * 1024 * 1024 // PDFs full of images run large

/** Deletes stored files no mode uses any more: a deleted mode's, a reset's, or one added as its mode was deleted. */
export function sweepModeFiles() {
  const used = new Set(getState().modes.flatMap((m) => (m.files ?? []).map((f) => f.id)))
  let names: string[] = []
  try {
    names = fs.readdirSync(dir())
  } catch {
    return // nothing stored yet
  }
  // Saved modes that failed to load live on in state.json.bad: their files stay until that copy is gone. Searched as
  // text, since that copy may not parse.
  let bad = ''
  try {
    bad = fs.readFileSync(path.join(app.getPath('userData'), 'state.json.bad'), 'utf8')
  } catch {}
  for (const name of names) {
    const id = name.replace(/\.glint$/, '')
    if (used.has(id) || bad.includes(id)) continue
    fs.rmSync(path.join(dir(), name), { force: true })
    texts.delete(id)
  }
  const modes = new Set(getState().modes.map((m) => m.id))
  for (const id of indexes.keys()) if (!modes.has(id)) indexes.delete(id)
}

/** Asks the user for files and adds them to the mode. Returns one line per file that couldn't be added. */
export async function addModeFiles(modeId: string, win: BrowserWindow | null): Promise<string[]> {
  const opts: Electron.OpenDialogOptions = { title: 'Add reference files', properties: ['openFile', 'multiSelections'] }
  const pick = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts))
  const problems: string[] = []
  const files = pick.canceled ? [] : pick.filePaths.map((file) => ({ file, name: path.basename(file), id: randomUUID() }))
  // Every picked file is listed as pending first; a row shows once text recognition starts on it.
  const jobs = () => getState().modeFileJobs
  const setJob = (id: string, p: Partial<State['modeFileJobs'][number]> | null) =>
    patchState({ modeFileJobs: p ? jobs().map((j) => (j.id === id ? { ...j, ...p } : j)) : jobs().filter((j) => j.id !== id) })
  patchState({ modeFileJobs: [...jobs(), ...files.map(({ id, name }) => ({ modeId, id, name, done: 0, total: 0, ocr: false }))] })
  for (const { file, name, id } of files) {
    try {
      const got = await extract(file, (p) => setJob(id, p))
      const text = tidy(got.text)
      if (!text) throw new Error('has no text in it')
      const mode = getState().modes.find((m) => m.id === modeId)
      if (!mode) break // deleted meanwhile
      const room = MODE_FILES_MAX_CHARS - (mode.files ?? []).reduce((n, f) => n + f.chars, 0)
      if (text.length > room) throw new Error(`is too long: ${thousands(text.length)} characters, and this mode has room for ${thousands(Math.max(0, room))} more`)
      if (!safeStorage.isEncryptionAvailable()) throw new Error("couldn't be saved: secure storage is unavailable")
      fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
      fs.writeFileSync(`${blobOf(id)}.tmp`, safeStorage.encryptString(text), { mode: 0o600 })
      fs.renameSync(`${blobOf(id)}.tmp`, blobOf(id))
      texts.set(id, text)
      const added = { id, name, chars: text.length, ...(got.pages && { pages: got.pages }) }
      patchState({ modes: getState().modes.map((m) => (m.id === modeId ? { ...m, files: [...(m.files ?? []), added] } : m)) })
    } catch (err) {
      problems.push(`${name} ${(err as Error).message}`)
    } finally {
      setJob(id, null)
    }
  }
  patchState({ modeFileJobs: jobs().filter((j) => !files.some((f) => f.id === j.id)) }) // a mode deleted mid-way
  sweepModeFiles()
  return problems
}

export function removeModeFile(modeId: string, fileId: string) {
  patchState({ modes: getState().modes.map((m) => (m.id === modeId ? { ...m, files: (m.files ?? []).filter((f) => f.id !== fileId) } : m)) })
  sweepModeFiles()
}

/**
 * The mode's files as one block, or null without any, or when they're too big and get searched instead. The same
 * bytes every time, so it stays cached.
 */
export function referenceFor(mode: Pick<Mode, 'files'> | undefined): string | null {
  const files = mode?.files ?? []
  if (!files.length || searchesFiles(mode)) return null
  const body = files.map((f) => `<file name="${f.name.replace(/"/g, "'")}">\n${textOf(f.id, f.name)}\n</file>`).join('\n')
  return `<reference_files>\n${body}\n</reference_files>`
}

/** The mode's search index, built from its files the first time it's needed and again when they change. */
function indexFor(mode: Pick<Mode, 'id' | 'files'>): SearchIndex {
  const files = mode.files ?? []
  const key = files.map((f) => f.id).join(',')
  const had = indexes.get(mode.id)
  if (had?.files === key) return had.index
  const index = buildIndex(files.map((f) => ({ name: f.name, text: textOf(f.id, f.name) })))
  indexes.clear() // one at a time, the active mode's: a big mode's index holds a copy of all its text
  indexes.set(mode.id, { files: key, index })
  return index
}

/** Builds the index ahead of the first ask (Glint in use with a searched mode), so that ask doesn't wait for it. */
export function prepareSearch(mode: Pick<Mode, 'id' | 'files'> | undefined) {
  if (mode && searchesFiles(mode)) indexFor(mode)
}

/**
 * The passages of the mode's files that match `query`, for a mode whose files are searched. With nothing matching,
 * a note saying so (and `count` 0), so the model doesn't imply the files cover it.
 */
export function passagesFor(mode: Pick<Mode, 'id' | 'files'>, query: string, budget?: number): Passages {
  return search(indexFor(mode), query, budget) ?? { text: NO_PASSAGES, count: 0, pages: [] }
}

function textOf(id: string, name: string): string {
  let text = texts.get(id)
  if (text === undefined) {
    try {
      text = safeStorage.decryptString(fs.readFileSync(blobOf(id)))
    } catch {
      throw new Error(`The reference file "${name}" can't be read any more. Remove it from the mode and add it again.`)
    }
    texts.set(id, text)
  }
  return text
}
async function extract(file: string, onProgress?: Progress): Promise<{ text: string; pages?: number }> {
  const { size } = await fs.promises.stat(file)
  if (size > FILE_MAX_BYTES) throw new Error(`is over ${FILE_MAX_BYTES / 1024 / 1024} MB`)
  const ext = path.extname(file).slice(1).toLowerCase()
  if (ext === 'epub') return { text: await epubText(file) }
  if (ext === 'pdf' || DOCUMENTS.includes(ext) || IMAGES.includes(ext)) return platform.files.extract(file, ext, onProgress)
  const buf = await fs.promises.readFile(file)
  if (buf.includes(0)) throw new Error("isn't a format Glint can read: use PDF, EPUB, Word, RTF, HTML, an image or plain text")
  return { text: isUtf8(buf) ? buf.toString('utf8') : buf.toString('latin1') }
}

/** Drops trailing spaces and runs of blank lines, which cost tokens on every ask. Indentation and columns stay. */
export const tidy = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

const thousands = (n: number) => n.toLocaleString('en-US')

/** An EPUB is a zip of XHTML chapters; the package file lists them in reading order (the spine). */
function epubText(file: string): Promise<string> {
  return withTemp(async (tmp) => {
    await platform.files.unzip(file, tmp)
    // unzip restores symlinks, which could point anywhere (~/.ssh, /dev/zero): only regular files that really are
    // inside the folder, links followed, are read.
    const root = fs.realpathSync.native(tmp) // the temp folder's own path has a link in it on macOS
    const inside = (f: string) => {
      try {
        const real = fs.realpathSync.native(path.resolve(tmp, f)) // native, like root's: it expands Windows' short names
        return real.startsWith(root + path.sep) && fs.statSync(real).isFile() ? real : null
      } catch {
        return null // not there
      }
    }
    const containerFile = inside('META-INF/container.xml')
    const container = containerFile ? await fs.promises.readFile(containerFile, 'utf8') : ''
    const opfPath = attr(/<rootfile\b[^>]*>/.exec(container)?.[0] ?? '', 'full-path')
    const opfFile = opfPath && inside(opfPath)
    if (!opfFile) throw new Error("isn't a readable EPUB")
    const opf = await fs.promises.readFile(opfFile, 'utf8')
    const hrefs = new Map((opf.match(/<item\b[^>]*>/g) ?? []).map((tag) => [attr(tag, 'id'), attr(tag, 'href')]))
    const chapters = (opf.match(/<itemref\b[^>]*>/g) ?? [])
      .map((tag) => hrefs.get(attr(tag, 'idref')))
      .filter((href): href is string => !!href)
      .map((href) => inside(path.resolve(tmp, path.dirname(opfPath), decodeURIComponent(href.split('#')[0]))))
      .filter((f): f is string => !!f)
    if (!chapters.length) throw new Error('has no chapters Glint can find')
    return platform.files.htmlText(chapters)
  })
}

const attr = (tag: string, name: string) =>
  (new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(tag)?.[1] ?? '').replace(/&amp;/g, '&')
