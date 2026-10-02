// Ghost's typing engine: follows the user typing a text out by hand, one character per correct keystroke, and
// forgives them. A wrong key waits for a backspace; typing on from a skipped or swapped word resyncs to where they
// are. Ported from TeXtUtility/Ghost (TypingEngine.swift), with the same rules and limits.

type Outcome = 'advanced' | 'mismatch' | 'complete' | 'ignored'

/** Curly quotes, dashes and odd spaces match what a normal keyboard types. */
const NORMAL: Record<string, string> = {
  '‘': "'", '’': "'", '‛': "'", '′': "'",
  '“': '"', '”': '"', '‟': '"', '″': '"',
  '–': '-', '—': '-', '−': '-',
  ' ': ' ', ' ': ' ', ' ': ' ',
}
const normalize = (c: string) => NORMAL[c] ?? c
const lower = (c: string) => normalize(c).toLowerCase()
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c)

/** How far a resync may jump: a sentence or two, never across the text on a coincidental match. */
const MAX_RESYNC_JUMP = 200
const INPUT_MAX = 64
/** A field break: Tab moves to the next field, and so does clicking into it and typing its answer. */
export const FIELD = '\t'

export class TypingEngine {
  chars: string[] = []
  private source = ''
  position = 0
  pendingMismatches = 0
  /** Wrong keys in a row at the cursor: the confidence signal for the fuzzy resync. */
  consecutiveMismatches = 0
  private history: ('advance' | 'mismatch')[] = []
  /** Recent keys, for finding where the user is after a detour. */
  private input: string[] = []
  /**
   * Off, it never moves ahead on its own: no resync after a skipped, swapped or added word, and no skipping a field
   * break. Only the right key, nextWord and prevWord move it.
   */
  autoSkip = true

  constructor(text = '') {
    this.source = text
    this.chars = Array.from(text)
  }

  get total() {
    return this.chars.length
  }
  get isComplete() {
    return this.position >= this.chars.length
  }
  get progress() {
    return this.chars.length ? this.position / this.chars.length : 1
  }

  /** New text. One that only grows the old (an answer still streaming in) keeps the user's place. */
  setText(text: string) {
    if (text === this.source) return
    const grows = text.startsWith(this.source)
    this.source = text
    this.chars = Array.from(text)
    if (!grows) this.reset()
  }

  reset() {
    this.position = 0
    this.clear()
  }

  handle(ch: string): Outcome {
    if (this.isComplete) return 'ignored'
    let outcome: Outcome
    if (normalize(ch) === normalize(this.chars[this.position])) {
      this.advanceBy(1)
      outcome = this.isComplete ? 'complete' : 'advanced'
    } else if (this.autoSkip && this.chars[this.position] === FIELD && ch !== FIELD && this.pendingMismatches === 0 && normalize(ch) === normalize(this.chars[this.position + 1] ?? '')) {
      // The user moved to the next field by clicking it and started typing its answer: skip the Tab they didn't need.
      this.advanceBy(2)
      outcome = this.isComplete ? 'complete' : 'advanced'
    } else {
      this.pendingMismatches++
      this.consecutiveMismatches++
      this.history.push('mismatch')
      outcome = 'mismatch'
    }
    this.input.push(ch)
    if (this.input.length > INPUT_MAX) this.input.splice(0, this.input.length - INPUT_MAX)
    // At a word boundary, jump to a later occurrence of the word just typed (cheap, precise).
    if (this.autoSkip && isSpace(ch)) this.wordResync()
    // After two wrong keys in a row, find where the last few typed characters appear ahead (swapped or added words).
    if (this.autoSkip && outcome === 'mismatch' && this.consecutiveMismatches >= 2) this.fuzzyResync()
    // A resync lands with nothing pending: the key that found the place counts as advancing.
    return outcome === 'mismatch' && !this.pendingMismatches ? 'advanced' : outcome
  }

  /** Undoes the last key: a wrong one clears, a right one steps back. */
  backspace() {
    const last = this.history.pop()
    if (last === 'mismatch') {
      this.pendingMismatches = Math.max(0, this.pendingMismatches - 1)
      this.consecutiveMismatches = Math.max(0, this.consecutiveMismatches - 1) // a corrected slip isn't a run of them
    }
    else if (this.position > 0) this.position--
    this.input.pop()
  }

  nextWord() {
    if (this.isComplete) return
    let i = this.position
    while (i < this.chars.length && !isSpace(this.chars[i])) i++
    while (i < this.chars.length && isSpace(this.chars[i])) i++
    this.position = i
    this.clear()
  }

  prevWord() {
    if (this.position <= 0) return
    let i = this.position - 1
    while (i > 0 && isSpace(this.chars[i])) i--
    while (i > 0 && !isSpace(this.chars[i - 1])) i--
    this.position = i
    this.clear()
  }

  private advanceBy(n: number) {
    for (let k = 0; k < n; k++) this.history.push('advance')
    this.position += n
    this.consecutiveMismatches = 0
  }

  private clear() {
    this.history = []
    this.pendingMismatches = 0
    this.consecutiveMismatches = 0
    this.input = []
  }

  private landAt(position: number) {
    this.position = position
    this.pendingMismatches = 0
    this.consecutiveMismatches = 0
    this.history = []
  }

  /** The typed word isn't the one at the cursor but appears a little later: continue from there. */
  private wordResync() {
    const typed = this.lastTypedWord()
    if (!typed || typed.length < 2) return
    const want = typed.map(lower).join('')
    // Typing correctly (nothing pending, the word matches): don't jump. With pending mistakes the word is extra.
    const at = this.wordEndingAtCursor()
    if (this.pendingMismatches === 0 && at && this.chars.slice(at[0], at[1]).map(lower).join('') === want) return
    const found = this.findWord(want, at?.[1] ?? this.position)
    if (!found || found[0] - this.position > MAX_RESYNC_JUMP) return
    let pos = found[1]
    if (isSpace(this.chars[pos])) pos++ // the space that triggered this was typed already
    this.landAt(pos)
  }

  /** The longest recent run of typed characters (4 to 16) found 2 to 200 characters ahead: continue after it. */
  private fuzzyResync() {
    const recent = this.input.slice(-16).map(lower)
    for (let start = 0; start <= recent.length - 4; start++) {
      const needle = recent.slice(start)
      const end = this.findRun(needle, this.position)
      if (end === null) continue
      const from = end - needle.length
      // One character ahead means a dropped letter ("uick" for "quick"): a backspace fixes that, not a jump.
      if (from - this.position < 2 || from - this.position > MAX_RESYNC_JUMP) continue
      return this.landAt(end)
    }
  }

  /** Searches only as far as a resync may jump, so a keystroke costs the same in a long answer as in a short one. */
  private findRun(needle: string[], start: number): number | null {
    const last = Math.min(this.chars.length - needle.length, start + MAX_RESYNC_JUMP)
    for (let i = start; i <= last; i++) {
      if (needle.every((c, j) => lower(this.chars[i + j]) === c)) return i + needle.length
    }
    return null
  }

  private lastTypedWord(): string[] | null {
    let i = this.input.length - 1
    while (i >= 0 && isSpace(this.input[i])) i--
    const end = i + 1
    while (i >= 0 && !isSpace(this.input[i])) i--
    return end > i + 1 ? this.input.slice(i + 1, end) : null
  }

  private wordEndingAtCursor(): [number, number] | null {
    let e = this.position
    while (e > 0 && isSpace(this.chars[e - 1])) e--
    let s = e
    while (s > 0 && !isSpace(this.chars[s - 1])) s--
    return e > s ? [s, e] : null
  }

  private findWord(want: string, start: number): [number, number] | null {
    let i = start
    const limit = Math.min(this.chars.length, this.position + MAX_RESYNC_JUMP + 1)
    while (i < limit) {
      while (i < this.chars.length && isSpace(this.chars[i])) i++
      const s = i
      while (i < this.chars.length && !isSpace(this.chars[i])) i++
      if (i === s) break
      if (this.chars.slice(s, i).map(lower).join('') === want) return [s, i]
    }
    return null
  }
}

/**
 * Ghost's quick hide: Control pressed and let go on its own twice, each press under 0.25 s and the two within 0.4 s.
 * Another modifier or key while Control is down makes it a chord, not a tap. Ported from Ghost's AppDelegate.
 */
export class ControlDoubleTap {
  private downAt: number | null = null
  private clean = false
  private lastTap: number | null = null

  /** A modifier change; true when it completes a double tap. */
  flags(control: boolean, otherModifiers: boolean, now: number): boolean {
    if (control && this.downAt === null) {
      this.downAt = now
      this.clean = !otherModifiers
      return false
    }
    if (control) return (this.clean = false)
    if (this.downAt === null) return false
    const held = now - this.downAt
    const clean = this.clean && held < 250
    this.downAt = null
    this.clean = false
    if (!clean) return ((this.lastTap = null), false)
    if (this.lastTap !== null && now - this.lastTap < 400) return ((this.lastTap = null), true)
    this.lastTap = now
    return false
  }

  /** A key pressed: with Control down, that's a chord. */
  key() {
    if (this.downAt !== null) this.clean = false
  }
}
