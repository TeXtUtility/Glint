// Text out of documents where Windows has no textutil to do it: HTML, Word and OpenDocument XML, RTF. No imports.

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£',
}

export const isUtf8 = (buf: Uint8Array) => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? m
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
  })
}

const BLOCK_END = /<\/(p|div|li|h[1-6]|tr|blockquote|pre|section|article|header|footer|dd|dt|figcaption|caption)\s*>/gi

export function htmlText(html: string): string {
  const body = html
    .replace(/<(script|style|head|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(BLOCK_END, '\n')
    .replace(/<\/t[dh]\s*>/gi, '\t')
    .replace(/<[^>]*>/g, '')
  return decodeEntities(body).split('\n').map((l) => l.trim()).join('\n')
}

/** document.xml of a .docx, or content.xml of an .odt. */
export function officeXmlText(xml: string): string {
  const body = xml
    .replace(/<w:(instrText|delText|tabs)\b[^>]*>[\s\S]*?<\/w:\1>/g, '') // field codes, deleted text, tab stops
    .replace(/<(w:tab|text:tab)\b[^>]*\/>/g, '\t')
    .replace(/<(w:br|w:cr|text:line-break)\b[^>]*\/>/g, '\n')
    .replace(/<text:s\b([^>]*)\/>/g, (_m, attrs: string) => ' '.repeat(Number(/text:c="(\d+)"/.exec(attrs)?.[1] ?? 1)))
    .replace(/<\/(w:p|text:p|text:h)>/g, '\n')
    .replace(/<[^>]*>/g, '')
  return decodeEntities(body)
}

/** Skipped whole: fonts, colours, styles, metadata, pictures, and anything marked \* as ignorable. */
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'listtable', 'listoverridetable', 'rsidtbl', 'xmlnstbl', 'themedata', 'datastore', 'latentstyles'])

export function rtfText(rtf: string): string {
  const cp1252 = new TextDecoder('windows-1252')
  const token = /\\([a-z]+)(-?\d+)? ?|\\'([0-9a-f]{2})|\\([^a-z])|([{}])|([^\\{}\r\n]+)|[\r\n]+/gi
  let out = ''
  let skip = 0 // depth below which everything is skipped; 0 when nothing is
  let depth = 0
  let uc = 1
  let drop = 0 // fallback characters still to drop after a \u
  let groupStart = false
  for (const m of rtf.matchAll(token)) {
    const [, word, num, hex, sym, brace, text] = m
    if (brace === '{') (depth++, (groupStart = true))
    else if (brace === '}') (depth--, skip && depth < skip && (skip = 0), (groupStart = false))
    else {
      const first = groupStart
      groupStart = false
      if (skip) continue
      if (sym === '*' && first) skip = depth
      else if (word && first && RTF_SKIP.has(word)) skip = depth
      else if (word === 'par' || word === 'line' || word === 'row') out += '\n'
      else if (word === 'tab' || word === 'cell') out += '\t'
      else if (word === 'uc') uc = Number(num ?? 1)
      else if (word === 'u') (out += String.fromCharCode(Number(num) < 0 ? Number(num) + 0x10000 : Number(num))), (drop = uc)
      else if (hex) drop ? drop-- : (out += cp1252.decode(new Uint8Array([parseInt(hex, 16)])))
      else if (sym && '\\{}'.includes(sym)) out += sym
      else if (sym === '~') out += ' '
      else if (text) {
        const keep = text.slice(Math.min(drop, text.length))
        drop = Math.max(0, drop - text.length)
        out += keep
      }
    }
  }
  return out
}
