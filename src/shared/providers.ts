// Trying AI providers in order until one answers. No Electron imports, so tests run under plain Node.
import type { AiProvider, State } from './state.ts'

type AiSettings = State['ai']

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: 'Claude API',
  openai: 'OpenAI API',
  'claude-cli': 'Claude Code',
  'codex-cli': 'Codex',
}

export interface Failure { provider: AiProvider; error: string }

/**
 * The model a CLI runs. Blank means Glint's pick for Claude Code: Sonnet for fast answers (under a second to the
 * first words, without thinking) and Opus for smart mode. Blank for Codex leaves Codex's own default.
 */
export function cliModelFor(provider: 'claude-cli' | 'codex-cli', model: string, smart: boolean): string {
  return model || (provider === 'claude-cli' ? (smart ? 'opus' : 'sonnet') : '')
}

/** The model a provider answers with, as a short name for the UI ("Opus 5", "GPT-5.5"). Fallback CLIs run their defaults. */
export function modelLabel(ai: AiSettings, provider: AiProvider, smart: boolean): string {
  const own = provider === ai.provider
  const id = provider === 'anthropic' ? (smart ? ai.anthropicSmartModel : ai.anthropicModel)
    : provider === 'openai' ? (smart ? ai.openaiSmartModel : ai.openaiModel)
    : cliModelFor(provider, own ? (smart ? ai.cliSmartModel : ai.cliModel) : '', smart)
  return prettyModel(id) || PROVIDER_LABELS[provider]
}

/** "claude-opus-5" → "Opus 5", "claude-sonnet-4-5-20250929" → "Sonnet 4.5", "sonnet" → "Sonnet", "gpt-5.5" → "GPT-5.5". */
export function prettyModel(id: string): string {
  const m = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d{1,2})\b)?)?/.exec(id)
  if (m) return [m[1][0].toUpperCase() + m[1].slice(1), m[2] && (m[3] ? `${m[2]}.${m[3]}` : m[2])].filter(Boolean).join(' ')
  return id.replace(/^gpt/i, 'GPT')
}

/** The chosen provider first, then the enabled fallbacks in their order, each once. */
export function providerOrder(ai: { provider: AiProvider; fallbacks: AiProvider[] }): AiProvider[] {
  return [ai.provider, ...ai.fallbacks].filter((p, i, all) => all.indexOf(p) === i)
}

// The old first stays in the chain, just lower, and a CLI model name means nothing to the other CLI, or to an API.
export function chooseFirst(ai: AiSettings, p: AiProvider): Partial<AiSettings> {
  if (p === ai.provider) return {}
  return { provider: p, fallbacks: [ai.provider, ...ai.fallbacks.filter((f) => f !== p && f !== ai.provider)], cliModel: '', cliSmartModel: '' }
}

/** Who leads when none of the chosen ones can answer: subscriptions first, since they cost nothing extra. */
const SETUP_PREFERENCE: AiProvider[] = ['claude-cli', 'codex-cli', 'anthropic', 'openai']

/**
 * The order with the providers that can answer ahead of those that can't, each group keeping its order, so an ask
 * never goes first to one that isn't set up. With none of the chosen ones ready, the first ready provider of all leads.
 * Null when the first one is ready already, or none is.
 */
export function readyFirst(ai: AiSettings, ready: Set<AiProvider>): Partial<AiSettings> | null {
  const order = providerOrder(ai)
  if (ready.has(order[0])) return null
  const lead = order.find((p) => ready.has(p)) ?? SETUP_PREFERENCE.find((p) => ready.has(p))
  if (!lead) return null
  const rest = order.filter((p) => p !== lead)
  return { ...chooseFirst(ai, lead), fallbacks: [...rest.filter((p) => ready.has(p)), ...rest.filter((p) => !ready.has(p))] }
}

/** One line for the UI: what failed, and who answered instead (or that nobody did). */
export function failureSummary(failures: Failure[], answeredBy: AiProvider | null): string {
  const what = failures.map((f) => `${PROVIDER_LABELS[f.provider]} ${f.error.startsWith('timed out') ? '' : 'failed: '}${f.error}`).join(' · ')
  return answeredBy ? `${what} · ${PROVIDER_LABELS[answeredBy]} answered instead` : `No AI could answer. ${what}`
}

/** A failure line split for display: what went wrong, and who answered instead (if anyone). */
export function splitFailure(line: string): [what: string, instead: string | null] {
  const m = / · ([^·]+ answered instead)$/.exec(line)
  return m ? [line.slice(0, m.index), m[1]] : [line, null]
}

export class AllFailedError extends Error {
  failures: Failure[]
  constructor(failures: Failure[]) {
    super(failures.length ? failureSummary(failures, null) : 'No AI is set up. Pick one in Settings → AI.')
    this.failures = failures
  }
}

/**
 * Runs `attempt` for each provider until one succeeds. It moves on only while nothing has been shown: once an
 * answer has started streaming, a failure ends it (mixing two models' answers would be worse), and so does an
 * error `isFinal` marks (a model declining to answer shouldn't be routed around). Fallbacks that aren't `usable`
 * (no key set up) are skipped; the first provider is always tried. A provider that goes `firstTextMs` without
 * answering or showing signs of life (`alive`: thinking, any stream event) is stopped and counts as failed, so a
 * stalled one hands over instead of leaving the user waiting, while one still thinking isn't cut off and paid twice.
 */
export async function tryInOrder(
  order: AiProvider[],
  attempt: (provider: AiProvider, onText: () => void, signal: AbortSignal, alive: () => void) => Promise<void>,
  opts: {
    usable?: (p: AiProvider) => boolean
    isFinal?: (err: unknown) => boolean
    onSwitch?: (failures: Failure[], next: AiProvider) => void
    signal?: AbortSignal
    firstTextMs?: (p: AiProvider) => number | undefined
  } = {},
): Promise<{ provider: AiProvider; failures: Failure[] }> {
  const failures: Failure[] = []
  for (const [i, provider] of order.entries()) {
    if (i > 0 && opts.usable && !opts.usable(provider)) continue
    if (failures.length) opts.onSwitch?.([...failures], provider)
    const ctrl = new AbortController()
    const signal = opts.signal ? AbortSignal.any([ctrl.signal, opts.signal]) : ctrl.signal
    const ms = opts.firstTextMs?.(provider)
    let slow = false
    let lastSign = Date.now()
    const check = () => {
      const quiet = Date.now() - lastSign
      if (quiet < ms!) return void (timer = setTimeout(check, ms! - quiet))
      slow = true
      ctrl.abort()
    }
    let timer = ms ? setTimeout(check, ms) : undefined
    let started = false
    try {
      await attempt(provider, () => {
        started = true
        clearTimeout(timer)
      }, signal, () => (lastSign = Date.now()))
      if (slow) throw new Error('stalled') // an attempt may end quietly when stopped
      return { provider, failures }
    } catch (err) {
      failures.push({ provider, error: slow ? `timed out (no answer in ${Math.round(ms! / 1000)} s)` : err instanceof Error ? err.message : String(err) })
      if (started || opts.isFinal?.(err)) break
    } finally {
      clearTimeout(timer)
    }
  }
  throw new AllFailedError(failures)
}
