// Mode files on a Mac, with what macOS ships: textutil for Word, RTF and HTML, PDFKit and Vision for PDFs and images.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { isUtf8 } from '../../../shared/doctext'
import { withTemp } from '../../temp'
import { DOCUMENTS } from '../formats'
import type { FileProgress as Progress } from '../types'

const run = promisify(execFile)

export async function extract(file: string, ext: string, onProgress?: Progress): Promise<{ text: string; pages?: number }> {
  if (!DOCUMENTS.includes(ext)) return pdfOrImageText(file, ext === 'pdf', onProgress)
  const html = ext === 'html' || ext === 'htm'
  return { text: await textutil([file], html && isUtf8(await fs.promises.readFile(file))) }
}

export const unzip = (file: string, into: string) => run('/usr/bin/unzip', ['-qq', '-o', file, '-d', into], { timeout: 120_000 }) // drops ../ from paths

/** EPUB chapters are UTF-8. */
export const htmlText = (files: string[]) => textutil(files, true)

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
