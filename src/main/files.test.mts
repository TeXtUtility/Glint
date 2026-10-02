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

test("addModeFiles: an EPUB chapter that's a link to a file outside the book isn't read", async () => {
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
