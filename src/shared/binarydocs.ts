// Text out of the binary formats Windows has nothing to read: Word 97-2003 (.doc) and Safari web archives
// (.webarchive), which a Mac reads with textutil. No imports.

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8)
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
const be = (b: Uint8Array, o: number, n: number) => {
  let v = 0
  for (let i = 0; i < n; i++) v = v * 256 + b[o + i]
  return v
}
const utf16 = (b: Uint8Array, bigEndian = false) => {
  const s = new Uint8Array(b.length - (b.length % 2))
  for (let i = 0; i < s.length; i += 2) (s[i] = b[i + (bigEndian ? 1 : 0)]), (s[i + 1] = b[i + (bigEndian ? 0 : 1)])
  return new TextDecoder('utf-16le').decode(s)
}

const END = 0xfffffffe

/** The streams of an OLE compound file (MS-CFB), by name. */
export function compoundStreams(file: Uint8Array): Map<string, Uint8Array> {
  const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
  if (file.length < 512 || SIG.some((x, i) => file[i] !== x)) throw new Error("isn't a Word 97-2003 file")
  const size = 1 << u16(file, 0x1e)
  const sector = (n: number) => file.subarray((n + 1) * size, (n + 2) * size)
  // The FAT's own sectors: the first 109 listed in the header, the rest in a chain of DIFAT sectors.
  const fatSectors: number[] = []
  for (let i = 0; i < 109; i++) fatSectors.push(u32(file, 0x4c + i * 4))
  for (let d = u32(file, 0x44), n = 0; d < END && n < u32(file, 0x48); n++) {
    const s = sector(d)
    for (let i = 0; i < size / 4 - 1; i++) fatSectors.push(u32(s, i * 4))
    d = u32(s, size - 4)
  }
  const fat: number[] = []
  for (const n of fatSectors.slice(0, u32(file, 0x2c))) {
    const s = sector(n)
    for (let i = 0; i < size / 4; i++) fat.push(u32(s, i * 4))
  }
  const chain = (start: number, next: number[]) => {
    const out: number[] = []
    for (let n = start; n < END && n < next.length && out.length < next.length; n = next[n]) out.push(n)
    return out
  }
  const read = (start: number, length: number) => {
    const sectors = chain(start, fat)
    const out = new Uint8Array(sectors.length * size)
    sectors.forEach((n, i) => out.set(sector(n), i * size))
    return out.subarray(0, Math.min(length, out.length))
  }
  const dir = read(u32(file, 0x30), Infinity)
  const entry = (i: number) => dir.subarray(i * 128, i * 128 + 128)
  const root = entry(0)
  const mini = read(u32(root, 116), u32(root, 120))
  const miniFat: number[] = []
  const mf = read(u32(file, 0x3c), u32(file, 0x40) * size)
  for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(u32(mf, i))
  const cutoff = u32(file, 0x38)
  const streams = new Map<string, Uint8Array>()
  for (let i = 1; i < dir.length / 128; i++) {
    const e = entry(i)
    if (e[66] !== 2) continue // streams only
    const name = utf16(e.subarray(0, Math.max(0, u16(e, 64) - 2)))
    const start = u32(e, 116)
    const length = u32(e, 120)
    if (length >= cutoff) streams.set(name, read(start, length))
    else {
      const pieces = chain(start, miniFat)
      const out = new Uint8Array(pieces.length * 64)
      pieces.forEach((n, k) => out.set(mini.subarray(n * 64, n * 64 + 64), k * 64))
      streams.set(name, out.subarray(0, length))
    }
  }
  return streams
}

/** A Word 97-2003 document's main text (MS-DOC): its pieces in order, with field codes left out and their results kept. */
export function wordDocText(file: Uint8Array): string {
  const streams = compoundStreams(file)
  const doc = streams.get('WordDocument')
  if (!doc || doc.length < 0x200 || u16(doc, 0) !== 0xa5ec) throw new Error("isn't a Word 97-2003 file")
  const flags = u16(doc, 0x0a)
  if (flags & 0x0100) throw new Error('is password-protected')
  const table = streams.get(flags & 0x0200 ? '1Table' : '0Table')
  if (!table) throw new Error("isn't a readable Word 97-2003 file")
  const lw = 34 + u16(doc, 32) * 2 // after FibBase and FibRgW97
  const ccpText = u32(doc, lw + 2 + 12)
  const clx = lw + 2 + u16(doc, lw) * 4 + 2 + 33 * 8 // fcClx, the 34th pair of FibRgFcLcb97
  let o = u32(doc, clx)
  const end = o + u32(doc, clx + 4)
  while (o < end && table[o] === 0x01) o += 3 + (u16(table, o + 1) << 16 >> 16) // property changes, skipped
  if (table[o] !== 0x02) throw new Error("isn't a readable Word 97-2003 file")
  const plc = o + 5
  const n = (u32(table, o + 1) - 4) / 12
  const cp1252 = new TextDecoder('windows-1252')
  let text = ''
  for (let i = 0; i < n && text.length < ccpText; i++) {
    const count = u32(table, plc + (i + 1) * 4) - u32(table, plc + i * 4)
    const fc = u32(table, plc + (n + 1) * 4 + i * 8 + 2)
    const at = fc & 0x3fffffff
    text += fc & 0x40000000 ? cp1252.decode(doc.subarray(at / 2, at / 2 + count)) : utf16(doc.subarray(at, at + count * 2))
  }
  return plainWordText(text.slice(0, ccpText))
}

/** Word's control characters as plain text: paragraphs and breaks become new lines, cells tabs. */
function plainWordText(t: string): string {
  let out = ''
  const fields: boolean[] = [] // per open field: still in its code (true) or in its result
  for (const ch of t) {
    const c = ch.charCodeAt(0)
    if (c === 0x13) fields.push(true)
    else if (c === 0x14) fields.length && (fields[fields.length - 1] = false)
    else if (c === 0x15) fields.pop()
    else if (fields.includes(true)) continue
    else if (c === 0x0d || c === 0x0b || c === 0x0c || c === 0x0e) out += '\n'
    else if (c === 0x07 || c === 0x09) out += '\t'
    else if (c === 0x1e) out += '-'
    else if (c === 0xa0) out += ' '
    else if (c >= 0x20) out += ch
  }
  return out.replace(/\t\n/g, '\n').trim()
}

/** A binary property list (bplist00), as plain values: strings, numbers, booleans, byte arrays, arrays and objects. */
export function parseBinaryPlist(b: Uint8Array): unknown {
  if (b.length < 40 || String.fromCharCode(...b.subarray(0, 8)) !== 'bplist00') throw new Error("isn't a web archive")
  const t = b.length - 32
  const offSize = b[t + 6]
  const refSize = b[t + 7]
  const count = be(b, t + 8, 8)
  const offsets = be(b, t + 24, 8)
  const obj = (ref: number, depth: number): unknown => {
    if (ref >= count || depth > 64) throw new Error("isn't a readable web archive")
    let o = be(b, offsets + ref * offSize, offSize)
    const type = b[o] >> 4
    const info = b[o] & 0xf
    const length = () => {
      if (info !== 0xf) return (o += 1), info
      const n = 1 << (b[o + 1] & 0xf)
      const v = be(b, o + 2, n)
      return (o += 2 + n), v
    }
    if (type === 0x0) return info === 0x9 ? true : info === 0x8 ? false : null
    if (type === 0x1) return be(b, o + 1, 1 << info)
    if (type === 0x4) return ((n) => b.subarray(o, o + n))(length())
    if (type === 0x5) return ((n) => new TextDecoder('windows-1252').decode(b.subarray(o, o + n)))(length())
    if (type === 0x6) return ((n) => utf16(b.subarray(o, o + n * 2), true))(length())
    if (type === 0xa) return ((n) => Array.from({ length: n }, (_, k) => obj(be(b, o + k * refSize, refSize), depth + 1)))(length())
    if (type === 0xd) {
      const n = length()
      const d: Record<string, unknown> = {}
      for (let k = 0; k < n; k++) d[String(obj(be(b, o + k * refSize, refSize), depth + 1))] = obj(be(b, o + (n + k) * refSize, refSize), depth + 1)
      return d
    }
    return undefined
  }
  return obj(be(b, t + 16, 8), 0)
}

/** A Safari web archive's page, as HTML. */
export function webArchiveHtml(file: Uint8Array): string {
  const main = (parseBinaryPlist(file) as Record<string, Record<string, unknown> | undefined>)?.WebMainResource
  const data = main?.WebResourceData
  if (!(data instanceof Uint8Array)) throw new Error("isn't a readable web archive")
  const label = typeof main?.WebResourceTextEncodingName === 'string' ? main.WebResourceTextEncodingName : 'utf-8'
  try {
    return new TextDecoder(label).decode(data)
  } catch {
    return new TextDecoder('utf-8').decode(data) // a label TextDecoder doesn't know
  }
}
