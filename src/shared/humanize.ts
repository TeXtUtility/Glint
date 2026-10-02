// Humanizer services (HUMANIZE-SPEC.md): when an answer is rewritten, how each service is called and answers, and
// keeping code, maths, links and Ghost's field breaks out of the rewrite. No Electron imports: tests run under plain Node.

export const HUMANIZERS = ['emulate', 'stealthgpt', 'writehuman', 'undetectable', 'custom'] as const
export type HumanizerService = (typeof HUMANIZERS)[number]

export const HUMANIZER_LABELS: Record<HumanizerService, string> = {
  emulate: 'Emulate', stealthgpt: 'StealthGPT', writehuman: 'WriteHuman', undetectable: 'Undetectable.ai', custom: 'your humanizer',
}

export interface HumanizerCustom { url: string; header: string; body: string; result: string }
export interface HumanizerConfig { service: HumanizerService; options: Record<string, string>; custom: HumanizerCustom | null }
/** What a service reports about the account: plan, words left, and the most one call may send. */
export interface HumanizerAccount { plan?: string; wordsLeft?: number; maxPerCall?: number }

/** Each service's own settings, with their allowed values; the first is the default. */
export const HUMANIZER_OPTIONS: Partial<Record<HumanizerService, Record<string, readonly string[]>>> = {
  stealthgpt: { model: ['standard', 'lite', 'super'] },
  writehuman: { tone: ['', 'professional', 'academic', 'blog', 'casual', 'creative', 'scientific', 'technical'] },
  undetectable: {
    readability: ['University', 'High School', 'Doctorate', 'Journalist', 'Marketing'],
    purpose: ['General Writing', 'Essay', 'Article', 'Marketing Material', 'Story', 'Cover Letter', 'Report', 'Business Material', 'Legal Material'],
    strength: ['Balanced', 'Quality', 'More Human'],
  },
}
const option = (cfg: HumanizerConfig, name: string) => {
  const allowed = HUMANIZER_OPTIONS[cfg.service]?.[name] ?? []
  return allowed.includes(cfg.options[name]) ? cfg.options[name] : allowed[0]
}

/**
 * Whether an ask's answer is humanized. Ghost follows its own setting whenever a service is connected; everything
 * else follows the switch and its "Apply to" choices. Glance's automatic answers count as Glance (brief).
 */
export function humanizes(h: { service: HumanizerService | 'none'; on: boolean; ghost: boolean; apply: { chat: boolean; glance: boolean } }, ask: { brief?: boolean; typeable?: boolean }): boolean {
  if (h.service === 'none') return false
  if (ask.typeable) return h.ghost
  return h.on && (ask.brief ? h.apply.glance : h.apply.chat)
}

export const words = (text: string) => text.split(/\s+/).filter(Boolean).length

/** Below this, the service refuses the text. */
export function minimum(service: HumanizerService): { words?: number; chars?: number } {
  if (service === 'emulate') return { words: 40 }
  if (service === 'writehuman') return { chars: 30 }
  if (service === 'undetectable') return { chars: 50 }
  return {}
}
export function tooShort(service: HumanizerService, text: string): boolean {
  const m = minimum(service)
  return (m.words !== undefined && words(text) < m.words) || (m.chars !== undefined && text.trim().length < m.chars)
}

/** The most words one call may send: the plan's limit where the service reports it. */
export function maxWords(service: HumanizerService, account: HumanizerAccount | null): number {
  if (service === 'emulate') return account?.maxPerCall ?? 300 // the Free plan's, until /me says otherwise
  if (service === 'stealthgpt') return 3000
  if (service === 'writehuman') return 14_000 // 100,000 characters
  if (service === 'undetectable') return 5000
  return Infinity
}

// Protected spans: taken out before sending, a marker in each place, put back after.

const MARK = (n: number) => `⟦${n}⟧`
const SPANS = new RegExp(
  [
    // fenced code, indented too (in a list item), to its close or the end of the text
    '(?:^|\\n)[ \\t]*(?:```|~~~)[^\\n]*\\n[\\s\\S]*?(?:\\n[ \\t]*(?:```|~~~)[^\\n]*(?=\\n|$)|(?![\\s\\S]))',
    // tables, whole: a header row, the |---|---| row under it, and the rows after with a | in them
    '(?:^|\\n)[^\\n]*\\|[^\\n]*\\n[ \\t]*(?=[^\\n]*\\|)\\|?[ \\t]*:?-+:?[ \\t]*(?:\\|[ \\t]*:?-+:?[ \\t]*)*\\|?[ \\t]*(?=\\n|$)(?:\\n[^\\n]*\\|[^\\n]*)*',
    '\\$\\$[\\s\\S]+?\\$\\$', // display maths
    '`[^`\\n]+`', // inline code
    '(?<![\\w$])\\$(?!\\s)[^$\\n]+?(?<!\\s)\\$(?![\\w$])', // inline maths
    '\\]\\([^)\\s]+(?:\\s+"[^"]*")?\\)', // a link's address (its text is rewritten)
    '<https?:\\/\\/[^>\\s]+>', // autolinks
    'https?:\\/\\/[^\\s)>\\]]+', // bare URLs
    '^[ \\t]*⇥[ \\t]*$', // Ghost's field separator lines
  ].join('|'),
  'gm',
)

/** The text with every protected span replaced by a marker, and the spans in marker order. */
export function protect(md: string): { text: string; spans: string[] } {
  const spans: string[] = []
  const text = md.replace(SPANS, (m) => {
    // A fence or table matched from a line start keeps that newline outside the marker.
    const lead = m.startsWith('\n') ? '\n' : ''
    spans.push(m.slice(lead.length))
    return `${lead}${MARK(spans.length)}`
  })
  return { text, spans }
}

/** The spans put back; null when the rewrite lost, repeated or invented a marker. */
export function restore(text: string, spans: string[]): string | null {
  const found: string[] = text.match(/⟦\d+⟧/g) ?? []
  if (found.length !== spans.length || new Set(found).size !== spans.length) return null
  if (spans.some((_, i) => !found.includes(MARK(i + 1)))) return null
  return text.replace(/⟦(\d+)⟧/g, (_, n: string) => spans[Number(n) - 1])
}

/** Whether there's anything left to rewrite once the spans are out. */
export const hasProse = (protectedText: string) => /[A-Za-zÀ-￿]{2,}/.test(protectedText.replace(/⟦\d+⟧/g, ''))

/**
 * Pieces of at most `max` words, split at paragraphs, then sentences, then words, so a long answer fits a plan's
 * per-call limit and nothing is cut. Joined back with a blank line.
 */
export function split(text: string, max: number): string[] {
  if (words(text) <= max) return [text]
  const pieces: string[] = []
  let cur: string[] = []
  const flush = () => (cur.length && pieces.push(cur.join('\n\n')), (cur = []))
  for (const para of text.split(/\n{2,}/)) {
    if (words(para) > max) {
      flush()
      let sent: string[] = []
      for (const s of para.match(/[^.!?]*[.!?]+\s*|[^.!?]+$/g) ?? [para]) {
        if (words([...sent, s].join('')) > max && sent.length) (pieces.push(sent.join('').trim()), (sent = []))
        if (words(s) > max) {
          const w = s.split(/\s+/).filter(Boolean)
          for (let i = 0; i < w.length; i += max) pieces.push(w.slice(i, i + max).join(' '))
        } else sent.push(s)
      }
      if (sent.length) pieces.push(sent.join('').trim())
    } else if (words([...cur, para].join('\n\n')) > max) (flush(), cur.push(para))
    else cur.push(para)
  }
  flush()
  return pieces
}

// Each service's request and answer.

export interface HumanizerRequest { url: string; headers: Record<string, string>; body: string }

export function requestFor(cfg: HumanizerConfig, key: string, text: string): HumanizerRequest {
  const json = { 'Content-Type': 'application/json' }
  switch (cfg.service) {
    case 'emulate':
      return { url: 'https://www.tryemulate.ai/v1/humanize', headers: { ...json, Authorization: `Bearer ${key}` }, body: JSON.stringify({ text }) }
    case 'stealthgpt':
      // The source text alone: StealthGPT asks for no "humanize this" instruction when rephrasing.
      return {
        url: 'https://www.stealthgpt.ai/api/stealthify', headers: { ...json, 'api-token': key },
        body: JSON.stringify({ prompt: text, rephrase: true, model: option(cfg, 'model'), outputFormat: 'markdown' }),
      }
    case 'writehuman': {
      const tone = option(cfg, 'tone')
      return { url: 'https://api.writehuman.ai/v1/humanize', headers: { ...json, Authorization: `Bearer ${key}` }, body: JSON.stringify({ text, ...(tone && { tone }) }) }
    }
    case 'undetectable':
      return {
        url: 'https://humanize.undetectable.ai/submit', headers: { ...json, apikey: key },
        body: JSON.stringify({ content: text, readability: option(cfg, 'readability'), purpose: option(cfg, 'purpose'), strength: option(cfg, 'strength'), model: 'v2' }),
      }
    case 'custom': {
      const c = cfg.custom!
      const body = c.body.replaceAll('{{text}}', () => JSON.stringify(text).slice(1, -1)) // a function: "$'" and "$$" in the text stay as they are
      JSON.parse(body) // the template must still be JSON with the text in it
      return { url: c.url, headers: { ...json, [c.header]: key }, body }
    }
  }
}

/** Undetectable.ai's second step: its document, polled until the rewrite is in. */
export const undetectablePoll = (key: string, id: string): HumanizerRequest => ({
  url: 'https://humanize.undetectable.ai/document', headers: { 'Content-Type': 'application/json', apikey: key }, body: JSON.stringify({ id }),
})

/** Emulate's account check: free, and says the plan's per-call limit. */
export const emulateAccount = (key: string) => ({ url: 'https://www.tryemulate.ai/v1/me', headers: { Authorization: `Bearer ${key}` } })

const at = (json: unknown, path: string): unknown =>
  path.split('.').filter(Boolean).reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), json)

/** The rewritten text in a service's answer (for Undetectable.ai's submit, the document id to poll), and its counts. */
export function resultOf(cfg: HumanizerConfig, json: unknown): { text?: string; id?: string; words?: number; account?: HumanizerAccount } {
  const j = (json ?? {}) as Record<string, any>
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  switch (cfg.service) {
    case 'emulate':
      return { text: str(j.text), words: num(j.words?.charged) }
    case 'stealthgpt':
      return { text: str(j.result), words: num(j.wordsSpent), account: num(j.remainingCredits) === undefined ? undefined : { wordsLeft: j.remainingCredits } }
    case 'writehuman':
      return { text: str(j.results?.[0]), words: num(j.input_words), account: num(j.words_remaining?.total) === undefined ? undefined : { wordsLeft: j.words_remaining.total } }
    case 'undetectable':
      return { text: str(j.output), id: str(j.id) }
    case 'custom':
      return { text: str(at(j, cfg.custom!.result)) }
  }
}

export function accountOf(json: unknown): HumanizerAccount {
  const j = (json ?? {}) as Record<string, unknown>
  return {
    plan: typeof j.plan === 'string' ? j.plan : undefined,
    wordsLeft: typeof j.words_left === 'number' ? j.words_left : undefined,
    maxPerCall: typeof j.max_words_per_call === 'number' ? j.max_words_per_call : undefined,
  }
}

const EMULATE_ERRORS: Record<string, string> = {
  unauthorized: 'bad API key', plan_required: "your plan doesn't include the API", out_of_words: 'out of words',
  over_cap: 'too long for your plan', too_short: 'too short to rewrite', invalid_request: 'it refused the request',
  failed: 'the service is having problems', billing_failed: 'the service is having problems', unavailable: 'the service is having problems',
}

/** A failed call, as a plain reason for the failure line ("Emulate failed: out of words"). */
export function errorOf(service: HumanizerService, status: number, json: unknown): string {
  const j = (json ?? {}) as Record<string, any>
  const code = typeof j.error?.code === 'string' ? j.error.code : undefined
  if (service === 'emulate' && code && EMULATE_ERRORS[code]) return EMULATE_ERRORS[code]
  if (status === 401 || status === 403) return 'bad API key'
  if (status === 402 || /insufficient credits/i.test(String(j.message ?? j.error ?? ''))) return 'out of credits'
  if (status === 413) return 'too long for your plan'
  if (status === 422) return "it couldn't rewrite this text"
  if (status === 429) return 'too many requests; wait a moment'
  if (status >= 500) return 'the service is having problems'
  const message = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message
  return typeof message === 'string' && message ? message.slice(0, 200) : `it answered ${status}`
}

/** Where a reply's rewrite stands, for its head, Ghost's strip and Glance. `ghost`: asked from Ghost. */
export interface HumanizeStatus {
  service: HumanizerService
  stage: 'replying' | 'humanizing' | 'done' | 'failed' | 'short' | 'stopped'
  ghost?: boolean
  words?: number
  ms?: number
  /** Why it was shown as written: the failure reason, or "under 40 words". */
  note?: string
}
