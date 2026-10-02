// Searching a mode's reference files when they're too big to send whole (REFERENCE-SEARCH-SPEC.md): each ask gets the
// passages that best match it. Keyword ranking (BM25) over paragraph-sized pieces. No Electron imports, so tests run
// under plain Node.
import { AUTO_ASK, isRetry } from './prompt.ts'
import type { AskPayload } from './state.ts'

const PIECE_CHARS = 1200
/** What one ask gets at most: about 30k tokens. */
export const PASSAGES_MAX_CHARS = 120_000
/** A one-line answer (Glance, an automatic answer) gets less: about 5k tokens. */
export const PASSAGES_BRIEF_CHARS = 20_000
/**
 * Past the best few, a piece scoring under this share of the best match is left out: it shares a common word with
 * the question, not its subject, and would only fill the budget (each passage is paid for at full price).
 */
const MIN_SHARE = 0.3
const MIN_PIECES = 3
const K1 = 1.2
const B = 0.75
/** A turn with nothing typed searches with the conversation's latest lines. */
const TRANSCRIPT_LINES = 6

export interface Piece { file: number; text: string; /** The page it's on, where the file marks pages. */ page?: string }
export interface SearchIndex {
  files: string[]
  pieces: Piece[]
  /** Per term: the pieces it's in, with how often. */
  postings: Map<string, [piece: number, tf: number][]>
  lengths: number[]
  avgLength: number
}
export interface Passages { text: string; count: number; pages: string[] }

const STOP = new Set(
  ('the and are was were for from with that this have has had not but its his her him she they them their there then than what when '
    + 'which who whom why how does did doing done can could would should will shall may might must you your yours our ours all any '
    + 'each into onto over under about after before also just only very more most some such been being here where while these those').split(' '),
)
/**
 * Light stemming: the common English endings come off, so "picks", "picked" and "picking" all match "pick", and a
 * final "e" goes too, so "price", "prices", "priced" and "pricing" match. Only words of four letters or more, keeping
 * at least three, so short words stay as they are.
 */
export function stem(w: string): string {
  if (w.length < 4) return w
  const cut = (n: number) => (w.length - n >= 3 ? w.slice(0, -n) : w)
  if (w.endsWith("'s")) return stem(w.slice(0, -2))
  if (w.endsWith('ies')) return `${cut(3)}y`
  const end = ['ing', 'ed', 'es', 's'].find((e) => w.endsWith(e) && !w.endsWith('ss'))
  const base = end ? cut(end.length) : w
  return base.length > 3 && base.endsWith('e') ? base.slice(0, -1) : base
}

/** Lowercase words of three letters or more, apostrophes kept, common words dropped, lightly stemmed. */
export const terms = (text: string) =>
  (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter((w) => w.length > 2 && !STOP.has(w)).map(stem)

const PAGE_MARK = /^\[page ([^\],\n]+)[^\n]*\]/

/**
 * A file's text in pieces of about PIECE_CHARS, split at paragraph breaks; a longer paragraph is split at sentence
 * ends (and a sentence longer than a piece, at the limit). Each piece knows the page it starts on, from the
 * `[page N]` markers the PDF reader writes.
 */
export function splitPieces(text: string, file = 0): Piece[] {
  const out: Piece[] = []
  let page: string | undefined
  let cur = ''
  let curPage: string | undefined
  const flush = () => {
    if (cur.trim()) out.push({ file, text: cur.trim(), ...(curPage && { page: curPage }) })
    cur = ''
  }
  /** `sep`: how the part joins what's before it in the piece, a paragraph break or (within one paragraph) a space. */
  const add = (part: string, sep = '\n\n') => {
    if (cur && cur.length + part.length + sep.length > PIECE_CHARS) flush()
    if (!cur) curPage = page
    cur += (cur ? sep : '') + part
  }
  for (const para of text.split(/\n\s*\n/)) {
    const mark = PAGE_MARK.exec(para.trimStart())
    if (mark) {
      page = mark[1].trim()
      flush() // a new page starts a new piece, so the marker stays with the text it labels
    }
    if (para.length <= PIECE_CHARS) {
      add(para)
      continue
    }
    let first = true
    for (const sentence of para.split(/(?<=[.!?])\s+/)) {
      for (let i = 0; i < sentence.length; i += PIECE_CHARS) {
        add(sentence.slice(i, i + PIECE_CHARS), first ? '\n\n' : ' ')
        first = false
      }
    }
  }
  flush()
  return out
}

export function buildIndex(files: { name: string; text: string }[]): SearchIndex {
  const pieces = files.flatMap((f, i) => splitPieces(f.text, i))
  const postings = new Map<string, [number, number][]>()
  const lengths = pieces.map((p, i) => {
    const words = terms(p.text)
    const tf = new Map<string, number>()
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1)
    for (const [w, n] of tf) {
      let list = postings.get(w)
      if (!list) postings.set(w, (list = []))
      list.push([i, n])
    }
    return words.length
  })
  return { files: files.map((f) => f.name), pieces, postings, lengths, avgLength: lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length) }
}

/** Pieces by BM25 score against `query`, best first, with their scores; pieces with no query term are left out. */
export function rank(index: SearchIndex, query: string): [piece: number, score: number][] {
  const n = index.pieces.length
  const score = new Map<number, number>()
  for (const t of new Set(terms(query))) {
    const list = index.postings.get(t)
    if (!list) continue
    const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5))
    for (const [i, tf] of list) {
      const norm = tf + K1 * (1 - B + B * (index.lengths[i] / index.avgLength))
      score.set(i, (score.get(i) ?? 0) + idf * ((tf * (K1 + 1)) / norm))
    }
  }
  return [...score].sort((a, b) => b[1] - a[1] || a[0] - b[0])
}

/**
 * The passages for an ask: the best-ranked pieces, each with the piece before and after it in its file, until they
 * reach `budget` characters or the scores fall off (MIN_SHARE); then in reading order, by file, with `[…]` where
 * pieces aren't next to each other. null when nothing matches.
 */
export function search(index: SearchIndex, query: string, budget = PASSAGES_MAX_CHARS): Passages | null {
  const picked = new Set<number>()
  let chars = 0
  const take = (i: number) => {
    const p = index.pieces[i]
    if (!p || picked.has(i) || chars + p.text.length > budget) return false
    picked.add(i)
    chars += p.text.length
    return true
  }
  const ranked = rank(index, query)
  const floor = (ranked[0]?.[1] ?? 0) * MIN_SHARE
  let taken = 0
  for (const [i, score] of ranked) {
    if (taken >= MIN_PIECES && score < floor) break
    if (picked.has(i)) continue
    if (!take(i)) break
    taken++
    const file = index.pieces[i].file
    for (const j of [i - 1, i + 1]) if (index.pieces[j]?.file === file) take(j)
  }
  if (!picked.size) return null
  const order = [...picked].sort((a, b) => a - b)
  const pages: string[] = []
  const groups: string[] = []
  let body: string[] = []
  order.forEach((i, k) => {
    const p = index.pieces[i]
    const prev = order[k - 1]
    if (k > 0 && index.pieces[prev].file !== p.file) {
      groups.push(fileBlock(index.files[index.pieces[prev].file], body))
      body = []
    } else if (k > 0 && prev !== i - 1) {
      body.push('[…]')
    }
    if (p.page && pages.at(-1) !== p.page) pages.push(p.page)
    // A piece that doesn't open with its page's marker gets one, so a passage sent alone still says where it is.
    body.push(p.page && !PAGE_MARK.test(p.text) ? `[page ${p.page}]\n${p.text}` : p.text)
  })
  groups.push(fileBlock(index.files[index.pieces[order.at(-1)!].file], body))
  // Pages are only a range within one file; across files they'd read as one span that matches neither.
  const oneFile = new Set(order.map((i) => index.pieces[i].file)).size === 1
  return { text: `<reference_passages>\n${groups.join('\n')}\n</reference_passages>`, count: picked.size, pages: oneFile ? pages : [] }
}

const fileBlock = (name: string, body: string[]) => `<file name="${name.replace(/"/g, "'")}">\n${body.join('\n\n')}\n</file>`

/**
 * What an ask searches for: its question; for a retry, the instruction before it (`repeat`); with nothing typed in a
 * session, the conversation's latest lines (`transcript`: the whole session's, not just the lines this ask sends).
 * null: nothing to search with (nothing typed outside a session).
 */
export function searchQuery(p: Pick<AskPayload, 'text' | 'repeat' | 'hasSession'>, transcript: { text?: string }[]): string | null {
  const text = p.text.trim()
  // An automatic Glance answer: only the question it answers (the rest is the same for every one, see autoAsk).
  const auto = AUTO_ASK.exec(text)
  if (auto) return auto[1]
  if (text && !isRetry(text)) return text
  if (p.repeat?.trim()) return p.repeat
  if (p.hasSession) {
    const lines = transcript.filter((t) => t.text?.trim()).slice(-TRANSCRIPT_LINES).map((t) => t.text).join('\n').trim()
    if (lines) return lines
  }
  return null // a retry with nothing before it, or nothing typed outside a session: nothing to search with
}

/** Told to the model when its files had nothing on this ask, so it doesn't imply they did. */
export const NO_PASSAGES = '<reference_passages>\n(A search of the reference files found nothing on this.)\n</reference_passages>'
