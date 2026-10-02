// Calls the connected humanizer service (HUMANIZE-SPEC.md) from main, where its key lives: only the answer's prose
// is sent, protected spans come back untouched, and failures are plain reasons for the failure line.
import { net } from 'electron'
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  accountOf, emulateAccount, errorOf, hasProse, HUMANIZER_LABELS, maxWords, protect, requestFor, restore, resultOf, split,
  tooShort, undetectablePoll, words, type HumanizerAccount, type HumanizerConfig, type HumanizerRequest,
} from '../shared/humanize'
import { getKey, setKey } from './ai'
import { verbose } from './log'
import { getState, patchState } from './state'

/** A rewrite that failed, with the reason shown ("out of words"). */
export class HumanizeError extends Error {}

/**
 * How long a call may take. Emulate's own example took 96 s for 137 words, and its docs allow minutes for long
 * pieces; the others answer in seconds; Undetectable.ai queues.
 */
function timeoutMs(cfg: HumanizerConfig, text: string): number {
  const w = words(text)
  if (cfg.service === 'emulate') return Math.min(900_000, 60_000 + w * 1500)
  if (cfg.service === 'undetectable') return Math.min(300_000, 90_000 + w * 100)
  return Math.min(180_000, 30_000 + w * 50)
}

async function call(req: HumanizerRequest, cfg: HumanizerConfig, signal: AbortSignal): Promise<unknown> {
  let res: Response
  try {
    res = await net.fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, cache: 'no-store', signal })
  } catch (err) {
    if (signal.aborted) throw err
    throw new HumanizeError("couldn't reach it")
  }
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new HumanizeError(errorOf(cfg.service, res.status, json))
  return json
}

/** One piece, rewritten, with what the service said about the account; Undetectable.ai's document is polled every 5 s until it's done. */
async function rewrite(cfg: HumanizerConfig, key: string, text: string, signal: AbortSignal): Promise<{ text: string; words?: number; account?: HumanizerAccount }> {
  const limit = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs(cfg, text))])
  try {
    const r = resultOf(cfg, await call(requestFor(cfg, key, text), cfg, limit))
    if (cfg.service === 'undetectable' && !r.text) {
      if (!r.id) throw new HumanizeError('it gave no document to wait for')
      for (;;) {
        await sleep(5000, undefined, { signal: limit }) // its abort listener goes when the wait ends, so polls don't pile them up
        const doc = resultOf(cfg, await call(undetectablePoll(key, r.id), cfg, limit))
        if (doc.text) return { text: doc.text }
      }
    }
    if (!r.text) throw new HumanizeError('its answer had no text in it')
    return { text: r.text, words: r.words, account: r.account }
  } catch (err) {
    if (signal.aborted) throw err // Stop: not a failure
    if (limit.aborted) throw new HumanizeError(`no answer within ${Math.round(timeoutMs(cfg, text) / 1000)} s`)
    throw err
  }
}

function config(): HumanizerConfig {
  const h = getState().humanizer
  if (h.service === 'none') throw new HumanizeError('no service is connected')
  return { service: h.service, options: h.options, custom: h.custom }
}

/**
 * The answer, rewritten by the connected service. `short`: under the service's minimum, shown as written. Code,
 * maths, links and field breaks are kept out; if the rewrite loses one of their markers, only the paragraphs without
 * any are rewritten. Throws HumanizeError with a plain reason, or the abort when Stop was pressed.
 */
export async function humanize(answer: string, signal: AbortSignal): Promise<{ text: string; words: number; ms: number } | { short: string }> {
  const cfg = config()
  const key = getKey('humanizer')
  if (!key) throw new HumanizeError('its API key is missing; connect it again in Settings → AI')
  const t0 = Date.now()
  const { text, spans } = protect(answer)
  const min = tooShort(cfg.service, text) ? cfg.service : null
  if (!hasProse(text) || min) return { short: min ? (cfg.service === 'emulate' ? 'under 40 words' : 'too short') : 'no prose to rewrite' }
  let charged = 0
  const run = async (piece: string) => {
    const out: string[] = []
    for (const p of split(piece, maxWords(cfg.service, getState().humanizerAccount))) {
      const r = await rewrite(cfg, key, p, signal)
      if (r.account) patchState({ humanizerAccount: { ...getState().humanizerAccount, ...r.account } })
      charged += r.words ?? words(p)
      out.push(r.text.trim())
    }
    return out.join('\n\n')
  }
  let restored = restore(await run(text), spans)
  if (restored === null) {
    verbose('[humanize] markers lost; rewriting paragraph by paragraph')
    const paras = text.split(/\n{2,}/)
    const out: string[] = []
    for (const p of paras) out.push(/⟦\d+⟧/.test(p) || tooShort(cfg.service, p) ? p : await run(p))
    restored = restore(out.join('\n\n'), spans)
    if (restored === null) throw new HumanizeError('it changed the parts it must keep')
  }
  const account = getState().humanizerAccount
  if (cfg.service === 'emulate' && account?.wordsLeft !== undefined) patchState({ humanizerAccount: { ...account, wordsLeft: Math.max(0, account.wordsLeft - charged) } })
  const ms = Date.now() - t0
  verbose(`[humanize] ${cfg.service}: ${words(answer)} words in, ${charged} charged, ${ms} ms`)
  return { text: restored, words: charged, ms }
}

/** The failure line for a failed rewrite: the same one a failing AI provider uses. */
export function failureLine(reason: string) {
  const s = getState().humanizer.service
  return `${s === 'none' ? 'The humanizer' : HUMANIZER_LABELS[s]} failed: ${reason}`
}

const SAMPLE = 'Remote work has changed how most teams plan their week. Meetings moved online, calendars filled up faster, and many people now split their time between home and the office. Managers had to learn new ways to keep projects moving, and teams found that clear written updates matter more than ever when nobody shares a desk.'

/** The last config and key that passed Test connection, and what the test found. */
let passed: { fp: string; account: HumanizerAccount | null } = { fp: '', account: null }
const fingerprint = (cfg: HumanizerConfig, key: string) => createHash('sha256').update(JSON.stringify([cfg, key])).digest('hex')

/**
 * Settings' Test connection. Emulate's account check is free; the others rewrite a 60-word sample. A pass is
 * remembered for connect, which saves only a config and key that passed.
 */
export async function testHumanizer(cfg: HumanizerConfig, key: string): Promise<{ account: HumanizerAccount | null; sample?: string }> {
  if (!key.trim() || key.length > 500) throw new HumanizeError('paste an API key first')
  const signal = AbortSignal.timeout(cfg.service === 'emulate' ? 20_000 : timeoutMs(cfg, SAMPLE))
  let out: { account: HumanizerAccount | null; sample?: string }
  try {
    if (cfg.service === 'emulate') {
      const { url, headers } = emulateAccount(key)
      const res = await net.fetch(url, { headers, cache: 'no-store', signal })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new HumanizeError(errorOf('emulate', res.status, json))
      out = { account: accountOf(json) }
    } else {
      const r = await rewrite(cfg, key, SAMPLE, signal)
      out = { account: r.account ?? null, sample: r.text }
    }
  } catch (err) {
    if (err instanceof HumanizeError) throw err
    throw new HumanizeError(signal.aborted ? 'no answer in time' : (err as Error).message)
  }
  passed = { fp: fingerprint(cfg, key.trim()), account: out.account }
  return out
}

/** Saves a service that just passed Test connection, with its key. */
export function connectHumanizer(cfg: HumanizerConfig, key: string) {
  if (fingerprint(cfg, key.trim()) !== passed.fp) throw new Error('Test the connection first.')
  const { account } = passed
  setKey('humanizer', key.trim())
  const h = getState().humanizer
  patchState({ humanizer: { ...h, service: cfg.service, options: cfg.options, custom: cfg.service === 'custom' ? cfg.custom : null }, humanizerAccount: account })
  passed = { fp: '', account: null }
}

export function disconnectHumanizer() {
  setKey('humanizer', null)
  patchState({ humanizer: { ...getState().humanizer, service: 'none', on: false }, humanizerAccount: null })
}

/** Emulate's plan, words left and per-call limit, refreshed at launch when it's connected. Free. */
export async function refreshHumanizerAccount() {
  const h = getState().humanizer
  const key = h.service === 'emulate' ? getKey('humanizer') : undefined
  if (!key) return
  try {
    const { url, headers } = emulateAccount(key)
    const res = await net.fetch(url, { headers, cache: 'no-store', signal: AbortSignal.timeout(20_000) })
    if (res.ok) patchState({ humanizerAccount: accountOf(await res.json()) })
  } catch {} // the next rewrite reports a real problem
}
