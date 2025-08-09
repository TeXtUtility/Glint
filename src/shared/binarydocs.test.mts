import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { parseBinaryPlist, webArchiveHtml, wordDocText } from './binarydocs.ts'
import { wordMlText } from './doctext.ts'

const C = String.fromCharCode
const le32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) (out.set(p, i), (i += p.length))
  return out
}

/** A version 3 compound file whose streams are all at least 4096 bytes, so none goes in the mini stream. */
function compoundFile(streams: Record<string, Uint8Array>): Uint8Array {
  const S = 512
  const names = Object.keys(streams)
  const fat = [0xfffffffd, 0xfffffffe] // sector 0 holds the FAT, sector 1 the directory
  const starts = names.map((n) => {
    const start = fat.length
    const k = streams[n].length / S
    for (let i = 0; i < k; i++) fat.push(i === k - 1 ? 0xfffffffe : fat.length + 1)
    return start
  })
  const header = new Uint8Array(S)
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  header.set([0x3e, 0, 3, 0, 0xfe, 0xff, 9, 0, 6, 0], 0x18)
  header.set(le32(1), 0x2c)
  header.set(le32(1), 0x30)
  header.set(le32(4096), 0x38)
  header.set(le32(0xfffffffe), 0x3c)
  header.set(le32(0xfffffffe), 0x44)
  for (let i = 0; i < 109; i++) header.set(le32(i === 0 ? 0 : 0xffffffff), 0x4c + i * 4)
  const fatSector = new Uint8Array(S).fill(0xff)
  fat.forEach((v, i) => fatSector.set(le32(v), i * 4))
  const dir = new Uint8Array(S)
  const entry = (i: number, name: string, type: number, start: number, size: number) => {
    const e = dir.subarray(i * 128, i * 128 + 128)
    for (let k = 0; k < name.length; k++) e.set([name.charCodeAt(k), 0], k * 2)
    e.set([(name.length + 1) * 2, 0], 64)
    e[66] = type
    e.set([...le32(0xffffffff), ...le32(0xffffffff), ...le32(i === 0 ? 1 : 0xffffffff)], 68)
    e.set([...le32(start), ...le32(size)], 116)
  }
  entry(0, 'Root Entry', 5, 0xfffffffe, 0)
  names.forEach((n, i) => entry(i + 1, n, 2, starts[i], streams[n].length))
  return concat(header, fatSector, dir, ...names.map((n) => streams[n]))
}

/** A Word 97 document of these pieces, each stored 8-bit (compressed) or as UTF-16. */
function wordDoc(pieces: { text: string; compressed: boolean }[]) {
  const doc = new Uint8Array(4096)
  const table = new Uint8Array(4096)
  doc.set([0xec, 0xa5, 0xc1, 0x00], 0) // wIdent, nFib
  doc.set([0x00, 0x02], 0x0a) // fWhichTblStm: the table stream is 1Table
  doc.set([14, 0], 32) // csw
  doc.set([22, 0], 62) // cslw
  doc.set(le32(pieces.reduce((n, p) => n + p.text.length, 0)), 64 + 12) // ccpText
  doc.set([93, 0], 152) // cbRgFcLcb
  const cps = [0]
  const fcs: number[] = []
  let at = 0x800
  for (const p of pieces) {
    const bytes = Buffer.from(p.text, p.compressed ? 'latin1' : 'utf16le')
    doc.set(bytes, at)
    fcs.push(p.compressed ? (at * 2) | 0x40000000 : at)
    at += bytes.length
    cps.push(cps[cps.length - 1] + p.text.length)
  }
  // A property change first, which the reader must step over, then the piece table.
  const clx = [0x01, 2, 0, 0xaa, 0xbb, 0x02, ...le32(cps.length * 4 + fcs.length * 8), ...cps.flatMap(le32), ...fcs.flatMap((fc) => [0, 0, ...le32(fc), 0, 0])]
  table.set(clx, 0)
  doc.set([...le32(0), ...le32(clx.length)], 154 + 33 * 8)
  return compoundFile({ WordDocument: doc, '1Table': table })
}

test('wordDocText: pieces in order, 8-bit and UTF-16, field codes dropped and their results kept', () => {
  const link = C(0x13) + ' HYPERLINK "https://example.com" ' + C(0x14) + 'the site' + C(0x15)
  const file = wordDoc([
    { text: 'Agenda for Tuesday\r', compressed: true },
    { text: `Caf${C(0xe9)} ${C(0x2713)} see ${link}.\r`, compressed: false },
    { text: `Name${C(7)}Role${C(7)}${C(7)}`, compressed: true },
  ])
  assert.equal(wordDocText(file), `Agenda for Tuesday\nCaf${C(0xe9)} ${C(0x2713)} see the site.\nName\tRole`)
})

test("wordDocText: a file that isn't Word 97-2003, or is password-protected, says so", () => {
  assert.throws(() => wordDocText(new TextEncoder().encode('{rtf1 not a doc}'.padEnd(600))), /isn't a Word 97-2003 file/)
  const locked = wordDoc([{ text: 'secret\r', compressed: true }])
  const doc = locked.subarray(512 * 3) // header, FAT and directory come first
  doc[0x0b] |= 0x01 // fEncrypted
  assert.throws(() => wordDocText(locked), /password-protected/)
})

test('wordDocText: the Word 97 files Office ships', { skip: !fs.existsSync('C:/Program Files/Microsoft Office/root/Office16/1033/PROTTPLN.DOC') && 'no Office here' }, () => {
  const text = wordDocText(new Uint8Array(fs.readFileSync('C:/Program Files/Microsoft Office/root/Office16/1033/PROTTPLN.DOC')))
  assert.match(text, /^Permission for this document is currently restricted\./)
})

/** A binary property list of strings (ASCII or not), byte arrays, arrays and objects; fewer than 256 objects. */
function bplist(root: unknown): Uint8Array {
  const objs: number[][] = []
  const head = (type: number, n: number) => (n < 15 ? [(type << 4) | n] : n < 256 ? [(type << 4) | 15, 0x10, n] : [(type << 4) | 15, 0x11, n >> 8, n & 255])
  const add = (v: unknown): number => {
    const i = objs.length
    objs.push([])
    if (typeof v === 'string') {
      const ascii = [...v].every((c) => c.charCodeAt(0) < 128)
      objs[i] = ascii ? [...head(5, v.length), ...Buffer.from(v, 'latin1')] : [...head(6, v.length), ...[...Buffer.from(v, 'utf16le')].map((_, k, b) => b[k ^ 1])]
    } else if (v instanceof Uint8Array) objs[i] = [...head(4, v.length), ...v]
    else if (Array.isArray(v)) objs[i] = [...head(10, v.length), ...v.map(add)]
    else {
      const keys = Object.keys(v as object)
      objs[i] = [...head(13, keys.length), ...keys.map(add), ...keys.map((k) => add((v as Record<string, unknown>)[k]))]
    }
    return i
  }
  add(root)
  const offsets: number[] = []
  let body: number[] = [...Buffer.from('bplist00')]
  for (const o of objs) (offsets.push(body.length), (body = body.concat(o)))
  const table = body.length
  body = body.concat(offsets.flatMap((o) => [o >> 8, o & 255]))
  const be64 = (v: number) => [0, 0, 0, 0, ...le32(v).reverse()]
  return new Uint8Array([...body, 0, 0, 0, 0, 0, 0, 2, 1, ...be64(objs.length), ...be64(0), ...be64(table)])
}

test('webArchiveHtml: the main page, in the encoding the archive names', () => {
  const page = '<html><body><p>Quarterly <b>numbers</b></p></body></html>'
  const archive = bplist({
    WebMainResource: { WebResourceData: new TextEncoder().encode(page), WebResourceMIMEType: 'text/html', WebResourceTextEncodingName: 'UTF-8', WebResourceURL: 'https://example.com/' },
    WebSubresources: [{ WebResourceData: new Uint8Array([1, 2, 3]), WebResourceMIMEType: 'image/png' }],
  })
  assert.equal(webArchiveHtml(archive), page)
  const quoted = bplist({ WebMainResource: { WebResourceData: new Uint8Array([0x93, 0x68, 0x69, 0x94]), WebResourceTextEncodingName: 'windows-1252' } })
  assert.equal(webArchiveHtml(quoted), `${C(0x201c)}hi${C(0x201d)}`)
  assert.deepEqual(parseBinaryPlist(bplist({ name: `Caf${C(0xe9)}`, items: ['a', 'b'] })), { name: `Caf${C(0xe9)}`, items: ['a', 'b'] })
  assert.throws(() => webArchiveHtml(new TextEncoder().encode('<html>not an archive</html>'.padEnd(64))), /isn't a web archive/)
})

test('wordMlText: the body only, without the document properties or embedded pictures', () => {
  const xml = '<?xml version="1.0"?><w:wordDocument xmlns:w="http://schemas.microsoft.com/office/word/2003/wordml">'
    + '<o:DocumentProperties><o:Author>Not text</o:Author></o:DocumentProperties><w:body>'
    + '<w:p><w:r><w:t>First</w:t></w:r><w:r><w:tab/><w:t>tabbed</w:t></w:r></w:p>'
    + '<w:p><w:r><w:pict><w:binData w:name="wordml://1.png">iVBORw0KGgoAAAANSUhEUg==</w:binData></w:pict><w:t>Second &amp; last</w:t></w:r></w:p>'
    + '</w:body></w:wordDocument>'
  assert.equal(wordMlText(xml).trim(), 'First\ttabbed\nSecond & last')
})
