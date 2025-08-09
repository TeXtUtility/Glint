import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { mock, test } from 'node:test'
import { dialog } from 'electron'
import { freshUserData } from '../test/electron.ts'
import { addModeFiles, referenceFor, sweepModeFiles } from './files.ts'
import { getState, initState, patchState } from './state.ts'
import { TAR } from './platform/system.ts'

test('sweepModeFiles: deletes stored files no mode uses, but not those a state.json.bad still names', () => {
  const dir = freshUserData()
  initState({})
  const [used, orphan, inBad] = [randomUUID(), randomUUID(), randomUUID()]
  patchState({ modes: [{ id: 'm1', name: 'Interview', prompt: '', files: [{ id: used, name: 'cv.txt', chars: 3 }] }] })
  const stored = path.join(dir, 'mode-files')
  fs.mkdirSync(stored)
  for (const id of [used, orphan, inBad]) fs.writeFileSync(path.join(stored, `${id}.glint`), 'x')
  // A copy that failed to load, cut off mid-write: still searched for the ids it names.
  fs.writeFileSync(path.join(dir, 'state.json.bad'), `{"modes": [{"id": "m2", "files": [{"id": "${inBad}", "na`)
  sweepModeFiles()
  assert.deepEqual(fs.readdirSync(stored).sort(), [`${used}.glint`, `${inBad}.glint`].sort())
  fs.rmSync(path.join(dir, 'state.json.bad'))
  sweepModeFiles()
  assert.deepEqual(fs.readdirSync(stored), [`${used}.glint`])
})

/** A one-page PDF with a text layer, its cross-reference table at the offsets it really has. */
function pdf(text: string): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length + 30} >>\nstream\nBT /F1 24 Tf 72 700 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const at = objs.map((o, i) => {
    const offset = out.length
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
    return offset
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  return Buffer.from(`${out}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1')
}

test('addModeFiles on Windows: Word, OpenDocument, EPUB, HTML, RTF, PDF and images', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const dir = freshUserData()
  initState({})
  patchState({ modes: [{ id: 'm1', name: 'Reading', prompt: '' }] })
  const zip = (name: string, files: Record<string, string>) => {
    const src = path.join(dir, `${name}-src`)
    for (const [f, body] of Object.entries(files)) (fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true }), fs.writeFileSync(path.join(src, f), body))
    execFileSync(TAR, ['-a', '-cf', path.join(dir, `${name}.zip`), ...Object.keys(files).map((f) => f.split('/')[0]).filter((f, i, a) => a.indexOf(f) === i)], { cwd: src })
    fs.renameSync(path.join(dir, `${name}.zip`), path.join(dir, name))
    return path.join(dir, name)
  }
  const docx = zip('cv.docx', { 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Led the payments team</w:t></w:r></w:p></w:body></w:document>' })
  const odt = zip('notes.odt', { 'content.xml': '<office:document-content><text:p>Quarterly plan</text:p></office:document-content>' })
  const epub = zip('book.epub', {
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    'OEBPS/content.opf': '<package><manifest><item id="c1" href="one.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>',
    'OEBPS/one.xhtml': '<html><body><p>Chapter one.</p></body></html>',
  })
  const html = path.join(dir, 'page.html')
  fs.writeFileSync(html, '<html><body><h1>Pricing</h1><p>Seats &amp; plans</p></body></html>')
  const rtf = path.join(dir, 'memo.rtf')
  fs.writeFileSync(rtf, "{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Memo: caf\\'e9 at noon\\par}")
  const doc = path.join(dir, 'report.pdf')
  fs.writeFileSync(doc, pdf('Revenue grew twelve percent'))
  const files = [docx, odt, epub, html, rtf, doc]
  mock.method(dialog, 'showOpenDialog', async () => ({ canceled: false, filePaths: files }))
  const problems = await addModeFiles('m1', null)
  mock.restoreAll()
  assert.deepEqual(problems, [])
  const text = referenceFor(getState().modes[0]) ?? ''
  for (const want of ['Led the payments team', 'Quarterly plan', 'Chapter one.', 'Seats & plans', 'Memo: café at noon', '[page 1]', 'Revenue grew twelve percent']) assert.ok(text.includes(want), want)
})

test("addModeFiles: an EPUB chapter that's a link to a file outside the book isn't read", { skip: process.platform === 'win32' && 'symlinks need admin rights on Windows' }, async () => {
  const dir = freshUserData()
  initState({})
  patchState({ modes: [{ id: 'm1', name: 'Reading', prompt: '' }] })
  const secret = path.join(dir, 'secret.txt')
  fs.writeFileSync(secret, 'TOP SECRET')
  const book = path.join(dir, 'book')
  fs.mkdirSync(path.join(book, 'META-INF'), { recursive: true })
  fs.mkdirSync(path.join(book, 'OEBPS'))
  fs.writeFileSync(path.join(book, 'mimetype'), 'application/epub+zip')
  fs.writeFileSync(path.join(book, 'META-INF', 'container.xml'), '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>')
  fs.writeFileSync(
    path.join(book, 'OEBPS', 'content.opf'),
    '<package><manifest><item id="c1" href="one.xhtml"/><item id="c2" href="two.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
  )
  fs.writeFileSync(path.join(book, 'OEBPS', 'one.xhtml'), '<html><body><p>Chapter one.</p></body></html>')
  fs.symlinkSync(secret, path.join(book, 'OEBPS', 'two.xhtml'))
  const epub = path.join(dir, 'book.epub')
  execFileSync('/usr/bin/zip', ['-qry', epub, 'mimetype', 'META-INF', 'OEBPS'], { cwd: book }) // -y: links stay links
  mock.method(dialog, 'showOpenDialog', async () => ({ canceled: false, filePaths: [epub] }))
  const problems = await addModeFiles('m1', null)
  mock.restoreAll()
  assert.deepEqual(problems, [])
  const text = referenceFor(getState().modes[0]) ?? ''
  assert.match(text, /Chapter one\./)
  assert.doesNotMatch(text, /TOP SECRET/)
})
