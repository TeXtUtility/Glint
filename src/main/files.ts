// Mode reference files. Each file's text is taken out once, kept encrypted on disk, and sent in full with every ask
// while its mode is active: the model reads the whole thing, and the API caches it, so later asks read it at a
// fraction of the price. Nothing is summarised or left out. Past MODE_FILES_WHOLE_CHARS, each ask gets the passages
// that best match it instead (src/shared/search.ts). PDF, EPUB, Word and images use what macOS ships with
// (PDFKit, textutil, Vision), so there's nothing extra to install; Windows has its own (files-win.ts).
import { app, dialog, safeStorage, type BrowserWindow } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildIndex, NO_PASSAGES, search, type Passages, type SearchIndex } from '../shared/search'
import { MODE_FILES_MAX_CHARS, searchesFiles, type Mode, type State } from '../shared/state'
import { getState, patchState } from './state'
import { chaptersText, extractWin, unzip } from './files-win'

const run = promisify(execFile)
const dir = () => path.join(app.getPath('userData'), 'mode-files')
const blobOf = (id: string) => path.join(dir(), `${id}.glint`)
const texts = new Map<string, string>() // decrypted, by file id
/** Search indexes, by mode, for the files they were built from (their ids): other files mean a rebuild. */
const indexes = new Map<string, { files: string; index: SearchIndex }>()
const FILE_MAX_BYTES = 300 * 1024 * 1024 // PDFs full of images run large
const TEXTUTIL = ['docx', 'doc', 'rtf', 'odt', 'wordml', 'webarchive', 'html', 'htm']
const IMAGES = ['png', 'jpg', 'jpeg', 'heic', 'heif', 'tif', 'tiff', 'gif', 'bmp', 'webp']

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

type Progress = (p: { done: number; total: number; ocr: boolean }) => void

async function extract(file: string, onProgress?: Progress): Promise<{ text: string; pages?: number }> {
  const { size } = await fs.promises.stat(file)
  if (size > FILE_MAX_BYTES) throw new Error(`is over ${FILE_MAX_BYTES / 1024 / 1024} MB`)
  const ext = path.extname(file).slice(1).toLowerCase()
  const native = ext === 'pdf' || ext === 'epub' || TEXTUTIL.includes(ext) || IMAGES.includes(ext)
  if (native && process.platform === 'win32' && ext !== 'epub') return extractWin(file, ext, IMAGES, onProgress)
  if (native && process.platform !== 'darwin' && process.platform !== 'win32') throw new Error('can only be read on macOS; add it as plain text')
  if (ext === 'pdf' || IMAGES.includes(ext)) return pdfOrImageText(file, ext === 'pdf', onProgress)
  if (ext === 'epub') return { text: await epubText(file) }
  if (TEXTUTIL.includes(ext)) {
    const html = ext === 'html' || ext === 'htm'
    return { text: await textutil([file], html && isUtf8(await fs.promises.readFile(file))) }
  }
  const buf = await fs.promises.readFile(file)
  if (buf.includes(0)) throw new Error("isn't a format Glint can read: use PDF, EPUB, Word, RTF, HTML, an image or plain text")
  return { text: isUtf8(buf) ? buf.toString('utf8') : buf.toString('latin1') }
}

const isUtf8 = (buf: Buffer) => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

/** Drops trailing spaces and runs of blank lines, which cost tokens on every ask. Indentation and columns stay. */
export const tidy = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

const thousands = (n: number) => n.toLocaleString('en-US')

async function withTemp<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'glint-')) // removeLeftoverTemp clears it after a crash
  try {
    return await fn(tmp)
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true })
  }
}

/** Word, RTF, HTML and more, through macOS's textutil; several files come out as one text in order. */
function textutil(files: string[], utf8: boolean): Promise<string> {
  return withTemp(async (tmp) => {
    const out = path.join(tmp, 'out.txt')
    // HTML without a charset is read as Latin-1 unless told otherwise; forcing UTF-8 is right only when it is UTF-8.
    const enc = utf8 ? ['-inputencoding', 'UTF-8'] : []
    const args = files.length > 1 ? ['-cat', 'txt', '-format', 'html', ...enc] : ['-convert', 'txt', ...enc]
    await run('/usr/bin/textutil', [...args, '-output', out, ...files], { timeout: 120_000 })
    return fs.promises.readFile(out, 'utf8')
  })
}

/**
 * PDFKit and Vision through JavaScript for Automation. PDF pages with little or no text layer (scans, slides) and
 * image files are read with Vision's text recognition. Pages are marked with their printed labels so answers can
 * cite them.
 */
const PDF_SCRIPT = `function run(argv) {
  ObjC.import('PDFKit'); ObjC.import('Vision'); ObjC.import('AppKit')
  function ocr(img) {
    const cg = img.CGImageForProposedRectContextHints(null, $(), $())
    if (!cg) return ''
    const req = $.VNRecognizeTextRequest.alloc.init
    req.recognitionLevel = 0 // accurate
    req.usesLanguageCorrection = true
    if (req.respondsToSelector('setAutomaticallyDetectsLanguage:')) req.automaticallyDetectsLanguage = true
    const handler = $.VNImageRequestHandler.alloc.initWithCGImageOptions(cg, $())
    if (!handler.performRequestsError($([req]), null)) throw new Error('text recognition failed')
    const lines = []
    for (let i = 0; i < req.results.count; i++) lines.push(req.results.objectAtIndex(i).topCandidates(1).firstObject.string.js)
    return lines.join('\\n')
  }
  let text
  if (argv[2] === 'image') {
    const img = $.NSImage.alloc.initWithContentsOfFile(argv[0])
    if (!img || img.isNil()) throw new Error("isn't a readable image")
    console.log('ocr 1')
    text = '[text recognized from the image]\\n' + ocr(img)
    console.log('page 1')
  } else {
    const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]))
    if (!doc || doc.isNil()) throw new Error("isn't a readable PDF")
    if (doc.isLocked) throw new Error('is password-protected')
    const pages = []
    console.log('pages ' + doc.pageCount)
    for (let i = 0; i < doc.pageCount; i++) {
      const page = doc.pageAtIndex(i)
      let body = page.string.isNil() ? '' : page.string.js
      let seenOnly = false
      if (body.trim().length < 200) {
        // A scan, or a slide whose words are mostly in pictures: read the rendered page too, keep whichever has more.
        console.log('ocr ' + (i + 1))
        const box = page.boundsForBox(1) // crop box
        const scale = Math.min(3, 4000 / Math.max(box.size.width, box.size.height))
        const seen = ocr(page.thumbnailOfSizeForBox($.NSMakeSize(box.size.width * scale, box.size.height * scale), 1))
        if (seen.trim().length > body.trim().length) {
          body = seen
          seenOnly = true
        }
      }
      console.log('page ' + (i + 1))
      if (!body.trim()) continue
      const label = page.label.isNil() || !page.label.js ? String(i + 1) : page.label.js
      pages.push('[page ' + label + (seenOnly ? ', text recognized from the page image' : '') + ']\\n' + body)
    }
    text = pages.join('\\n\\n')
  }
  $(text).writeToFileAtomicallyEncodingError(argv[1], true, $.NSUTF8StringEncoding, null)
}`

/** The script logs "pages N", then "ocr i" before recognising page i and "page i" when it's done, on stderr. */
function pdfOrImageText(file: string, pdf: boolean, onProgress?: Progress): Promise<{ text: string; pages?: number }> {
  return withTemp(async (tmp) => {
    const out = path.join(tmp, 'out.txt')
    let pages: number | undefined
    await new Promise<void>((resolve, reject) => {
      const p = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_SCRIPT, file, out, pdf ? 'pdf' : 'image'])
      const timer = setTimeout(() => p.kill(), 30 * 60_000) // recognising a long scanned book takes minutes
      let stderr = ''
      let pending = ''
      let ocr = false
      p.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk
        const lines = (pending + chunk).split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          const m = /^(pages|ocr|page) (\d+)$/.exec(line.trim())
          if (!m) continue
          const n = Number(m[2])
          if (m[1] === 'pages') pages = n
          if (m[1] === 'ocr') ocr = true
          if (ocr) onProgress?.({ done: m[1] === 'page' ? n : n - 1, total: pages ?? 1, ocr })
        }
      })
      p.on('error', reject)
      p.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) return resolve()
        const why = /Error: ((is|text)[^(\n]*)/.exec(stderr)?.[1]?.trim()
        reject(new Error(why ?? `couldn't be read as ${pdf ? 'a PDF' : 'an image'}`))
      })
    })
    return { text: await fs.promises.readFile(out, 'utf8'), pages }
  })
}

/** An EPUB is a zip of XHTML chapters; the package file lists them in reading order (the spine). */
function epubText(file: string): Promise<string> {
  return withTemp(async (tmp) => {
    if (process.platform === 'win32') await unzip(file, tmp) // bsdtar refuses ../ paths
    else await run('/usr/bin/unzip', ['-qq', '-o', file, '-d', tmp], { timeout: 120_000 }) // unzip drops ../ from paths
    // unzip restores symlinks, which could point anywhere (~/.ssh, /dev/zero): only regular files that really are
    // inside the folder, links followed, are read.
    const root = await fs.promises.realpath(tmp) // the temp folder's own path has a link in it on macOS
    const inside = (f: string) => {
      try {
        const real = fs.realpathSync(path.resolve(tmp, f))
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
    return process.platform === 'win32' ? chaptersText(chapters) : textutil(chapters, true) // EPUB text is UTF-8
  })
}

const attr = (tag: string, name: string) =>
  (new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(tag)?.[1] ?? '').replace(/&amp;/g, '&')
