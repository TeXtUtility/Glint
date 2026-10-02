/**
 * Private-use characters and citation markers some models leak into text (ChatGPT's "filecite…turn0file3"). They
 * never mean anything to a reader, so they're taken out of what's shown, copied and saved.
 */
export function scrub(text: string): string {
  return text
    .replace(/\uE200[^\uE201]*(?:\uE201|$)/g, '') // a whole marker, or one still streaming in
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/(?:file|nav)?cite(?:turn\d+[a-z]+\d+)+/gi, '') // the same marker with its private characters lost
}

/**
 * A streaming reply cut back to its last finished sentence or line, so it arrives a sentence at a time. A full stop
 * only ends a sentence when a space follows ("3.14" doesn't).
 */
export function wholeSentences(md: string): string {
  return /[\s\S]*(?:[.!?]["')\]*_]*(?=\s)|\n)/.exec(md)?.[0] ?? ''
}

const firstLine = (s: string) => s.split('\n').map((l) => l.replace(/^• /, '').trim()).find(Boolean) ?? ''

/** A reply as one plain line for the Glance strip: its first line of text, as it would be copied. */
export function plainLine(md: string): string {
  const prose = md.replace(/```[\s\S]*?(```|$)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // one line: no code, no URLs
  // A reply that is only a code block shows its first line of code rather than nothing.
  return firstLine(toPlain(prose)) || firstLine(md.replace(/^\s*```[^\n]*/, '').replace(/```/g, ''))
}

/**
 * A reply as text to type out by hand (Ghost): no preamble a model added anyway, no markdown marks, bullets as "- "
 * (typeable, unlike •), maths in normal notation, and a Tab wherever the reply split its answers by field (⇥).
 */
export function typeable(md: string): string {
  const text = toPlain(md.replace(/\r\n?/g, '\n').replace(/^\s*(?:(?:sure|okay|ok|certainly|of course)[,.!]?\s+)?(?:here(?:'s| is| are)|below is)\b[^\n]*:[ \t]*\n+/i, ''))
    .replace(/^(\s*)• /gm, '$1- ')
    .replace(/\n*^[ \t]*⇥[ \t]*$\n*/gm, '\t')
    // What no key types: a decomposed accent (two characters, one key), an ellipsis, hyphens and spaces other than
    // the keyboard's, and invisible characters. Each would hold the cursor for good.
    .normalize('NFC')
    .replace(/…/g, '...')
    .replace(/[\u2010-\u2012\u2015]/g, '-')
    .replace(/[\u00AD\u200B\u2060\uFEFF]/g, '')
    .replace(/[^\S\n\t]/g, ' ')
    .trim()
  const quoted = /^"([^"]*)"$|^\u201C([^\u201D]*)\u201D$/.exec(text)
  return quoted ? (quoted[1] ?? quoted[2]) : text
}

/** What auto-copy puts on the clipboard: the whole reply as plain text, or its first code block (else the reply). */
export function copyText(reply: string, mode: 'reply' | 'code'): string {
  if (mode === 'code') {
    // A fence can sit indented inside a list; its lines carry that indent, which isn't part of the code.
    const m = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\2[ \t]*$/m.exec(reply)
    if (m) return m[3].split('\n').map((line) => (line.startsWith(m[1]) ? line.slice(m[1].length) : line.trimStart())).join('\n')
  }
  return toPlain(reply)
}

/**
 * Markdown as plain text for pasting anywhere: no **, #, ` or table pipes; bullets become •, tables tab-separated,
 * links "text (url)", and LaTeX maths normal notation (x², √2, a/b, ≤, π). Code blocks are kept exactly.
 */
export function toPlain(md: string): string {
  return scrub(md)
    .split(/(```[^\n]*\n[\s\S]*?(?:```|$))/)
    .map((part, i) => (i % 2 ? part.replace(/^```[^\n]*\n/, '').replace(/\n?```$/, '') : plainProse(part)))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function plainProse(text: string): string {
  const codes: string[] = []
  const held = text.replace(/`([^`\n]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`)
  const math = normalizeMath(held)
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, m: string) => texToText(m).trim())
    .replace(/(^|[^\\])\$([^$\n]+?)\$/g, (_, pre: string, m: string) => pre + texToText(m))
    .replace(/\\\$/g, '$')
  return math
    .split('\n')
    .map((line) => {
      if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-')) return null // table rule
      if (/^\s*\|.*\|\s*$/.test(line)) return line.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim()).join('\t')
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return '' // horizontal rule
      return line
        .replace(/^(\s*)#{1,6}\s+(.*?)\s*#*\s*$/, '$1$2')
        .replace(/^(\s*)>\s?/, '$1')
        .replace(/^(\s*)[-*+]\s+(\[[ xX]\]\s+)?/, '$1• ')
    })
    .filter((line): line is string => line !== null)
    .join('\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)/g, (_, t: string, url: string) => (t === url ? url : `${t} (${url})`))
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
    .replace(/(\S) {2,}(?=\S)/g, '$1 ') // a gap left where something was taken out
    .replace(/[ \t]+$/gm, '')
    .replace(/\u0000(\d+)\u0000/g, (_, n: string) => codes[Number(n)])
}

// LaTeX to plain notation. Covers what models write in answers; anything else keeps its name without the backslash.

const SYMBOLS: Record<string, string> = {
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈',
  equiv: '≡', sim: '~', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫', infty: '∞', to: '→', rightarrow: '→',
  leftarrow: '←', gets: '←', Rightarrow: '⇒', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔', iff: '⇔',
  implies: '⇒', mapsto: '↦', uparrow: '↑', downarrow: '↓', in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆',
  supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅', forall: '∀',
  exists: '∃', neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨', oplus: '⊕', otimes: '⊗', partial: '∂',
  nabla: '∇', sum: 'Σ', prod: 'Π', int: '∫', iint: '∬', iiint: '∭', oint: '∮', angle: '∠', perp: '⊥', parallel: '∥',
  degree: '°', circ: '∘', bullet: '•', star: '⋆', ast: '*', cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱',
  therefore: '∴', because: '∵', prime: '′', hbar: 'ħ', ell: 'ℓ', aleph: 'ℵ', langle: '⟨', rangle: '⟩', lfloor: '⌊',
  rfloor: '⌋', lceil: '⌈', rceil: '⌉', mid: '|', vert: '|', lvert: '|', rvert: '|', Vert: '‖', lVert: '‖', rVert: '‖',
  triangle: '△', square: '□', checkmark: '✓', dagger: '†', S: '§', P: '¶', AA: 'Å',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ',
  rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ',
  omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ',
  Psi: 'Ψ', Omega: 'Ω',
  quad: '  ', qquad: '    ', ',': ' ', ';': ' ', ':': ' ', '>': ' ', ' ': ' ', '!': '', '\\': '\n', '%': '%', '$': '$',
  '&': '&', '#': '#', '_': '_', '{': '{', '}': '}', '|': '‖',
}
const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'det', 'gcd', 'lcm', 'deg', 'dim', 'ker', 'arg', 'mod', 'Pr'])
const CONTENT = new Set(['text', 'textrm', 'textbf', 'textit', 'textsf', 'texttt', 'mathrm', 'mathbf', 'mathit', 'mathsf',
  'mathtt', 'mathcal', 'mathbb', 'mathfrak', 'boldsymbol', 'bm', 'operatorname', 'boxed', 'emph', 'underline', 'mbox',
  'displaystyle', 'textstyle', 'overline', 'bar', 'widetilde', 'tilde', 'underbrace', 'overbrace', 'cancel', 'phantom'])
const SIZING = new Set(['left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'middle'])
const ACCENTS: Record<string, string> = { vec: '\u20D7', hat: '\u0302', dot: '\u0307', ddot: '\u0308' }
const SUP = Object.fromEntries([...'0123456789+-=()niaxyk'].map((c, i) => [c, '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱᵃˣʸᵏ'[i]]))
const SUB = Object.fromEntries([...'0123456789+-=()aeoxhklmnpstij'].map((c, i) => [c, '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜᵢⱼ'[i]]))
Object.assign(SUP, { '−': '⁻', '∘': '°', '′': '′', '*': '*', '†': '†' })
Object.assign(SUB, { '−': '₋' })

const grouped = (a: string) => (/^[\w.′°!]+$|^\(.*\)$|^[^\s+\-−=/×·÷<>≤≥,]+$/.test(a) ? a : `(${a})`)
/** A denominator stays bare only when it can't be misread: one symbol, a number, or dx. "1/2a" would read as a/2. */
const below = (a: string) => ([...a].length === 1 || /^\d+(\.\d+)?$|^[d∂][a-zA-Zα-ω]$|^\(.*\)$/.test(a) ? a : `(${a})`)
const script = (a: string, map: Record<string, string>, mark: string) =>
  a && [...a].every((c) => c in map) ? [...a].map((c) => map[c]).join('') : `${mark}${a.length === 1 ? a : `(${a})`}`

export function texToText(tex: string): string {
  let i = 0
  const command = () => {
    const m = /^\\([a-zA-Z]+|.)/.exec(tex.slice(i))
    i += m ? m[0].length : 1
    return m?.[1] ?? ''
  }
  /** One argument: a {group}, a command, or a single character. */
  const arg = (): string => {
    while (tex[i] === ' ') i++
    if (tex[i] === '{') {
      const start = ++i
      for (let depth = 1; i < tex.length && depth; i++) {
        if (tex[i] === '\\') i++
        else if (tex[i] === '{') depth++
        else if (tex[i] === '}') depth--
      }
      return texToText(tex.slice(start, i - 1))
    }
    if (tex[i] === '\\') {
      const start = i
      command()
      return texToText(tex.slice(start, i))
    }
    return tex[i++] ?? ''
  }
  let out = ''
  /** What & and \\\\ mean depend on the environment: columns of a matrix, value and condition in cases. */
  const envs: string[] = []
  const env = () => envs.at(-1) ?? ''
  const matrix = () => /matrix|array/.test(env())
  while (i < tex.length) {
    const c = tex[i]
    if (c === '\\' && tex[i + 1] === '\\') {
      i += 2
      out += matrix() ? '; ' : '\n'
    } else if (c === '\\') {
      const name = command()
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
        const a = arg()
        out += `${grouped(a)}/${below(arg())}`
      } else if (name === 'sqrt') {
        let n = ''
        if (tex[i] === '[') {
          const end = tex.indexOf(']', i)
          n = texToText(tex.slice(i + 1, end < 0 ? tex.length : end))
          i = end < 0 ? tex.length : end + 1
        }
        out += (n === '3' ? '∛' : n === '4' ? '∜' : n ? `${script(n, SUP, '^')}√` : '√') + grouped(arg())
      } else if (name === 'binom' || name === 'dbinom' || name === 'tbinom') {
        const a = arg()
        out += `C(${a}, ${arg()})`
      } else if (name === 'begin') {
        envs.push(arg())
        out += { pmatrix: '(', bmatrix: '[', vmatrix: '|', Bmatrix: '{' }[env()] ?? ''
      } else if (name === 'end') {
        arg()
        out += { pmatrix: ')', bmatrix: ']', vmatrix: '|', Bmatrix: '}' }[env()] ?? ''
        envs.pop()
      }
      else if (name === 'not') out += `${arg()}\u0338`
      else if (name in ACCENTS) out += arg() + ACCENTS[name]
      else if (CONTENT.has(name)) out += arg()
      else if (SIZING.has(name)) {
        while (tex[i] === ' ') i++
        if (tex[i] === '.') i++ // \left. is an invisible delimiter
      } else if (FUNCTIONS.has(name)) out += (/\w$/.test(out) ? ' ' : '') + name
      else if (name in SYMBOLS) out += SYMBOLS[name]
      else out += name
    } else if (c === '^' || c === '_') {
      i++
      out += script(arg(), c === '^' ? SUP : SUB, c)
    } else {
      i++
      if (c === '&') out += env() === 'cases' ? ', ' : matrix() ? ' ' : '' // aligned: & only marks where to line up
      else if (c === '~') out += ' '
      else if (c !== '{' && c !== '}') out += c
    }
  }
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/([([]) | (?=[)\],;])/g, '$1')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
}

// Kept as-is: $$display$$, an already-escaped \$, and $inline$ by pandoc's rule (no space just inside either
// dollar, no digit right after the closing one). Any other $ is escaped, so "$5 to $10" stays money.
const DOLLARS = /\$\$[\s\S]*?\$\$|\\\$|\$(?=[^\s$])[^$\n]*?[^\s$\\]\$(?!\d)|\$(?=[^\s$])[^\s$\\]\$(?!\d)|\$/g

/**
 * Prepare model markdown for remark-math: \( \) and \[ \] become $ and $$, and currency dollars are escaped.
 * Code spans and fences (including one still streaming) are left alone.
 */
export function normalizeMath(md: string): string {
  return md
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `$$${m}$$`)
            .replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `$${m.trim()}$`) // `\( x \)` too: pandoc's rule wants no inner space
            .replace(DOLLARS, (m) => (m === '$' ? '\\$' : m)),
    )
    .join('')
}
