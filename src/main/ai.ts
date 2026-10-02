import Anthropic from '@anthropic-ai/sdk'
import { app, nativeImage, safeStorage } from 'electron'
import { createHash } from 'node:crypto'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import OpenAI from 'openai'
import { scrub } from '../shared/markdown'
import { AUTO_ASK, cliPrompt, parseClaudeLine, recentHistory, userPrompt } from '../shared/prompt'
import { cliModelFor, failureSummary, providerOrder, tryInOrder, type Failure } from '../shared/providers'
import type { AiProvider, AskPayload, KeyProvider, KeyStatus, State } from '../shared/state'
import { getState, patchState } from './state'
import { verbose } from './log'

type OnDelta = (text: string) => void
/** Token counts for one call, where the provider reports them (the CLIs don't). */
export interface Usage { input: number; cacheRead: number; cacheWrite: number; output: number }

/**
 * `system`: the system prompt in blocks, the biggest and least often changed first (a mode's reference files, then
 * the instructions), so editing the instructions doesn't throw away the cached files.
 */
/** `alive`: called on any sign the provider is working (a thinking step, any stream event), before text arrives. */
export async function runAsk(ai: State['ai'], system: string[], p: AskPayload, onDelta: OnDelta, signal: AbortSignal, alive?: () => void): Promise<Usage | void> {
  // JPEG keeps big screenshots well under the APIs' per-image size limits.
  const jpeg = p.screenshot ? nativeImage.createFromDataURL(p.screenshot).toJPEG(85) : null
  const { smart, think } = speedOf(ai, p)
  p = { ...p, history: recentHistory(p.history) }
  try {
    switch (ai.provider) {
      case 'anthropic':
        return await askClaudeApi(smart ? ai.anthropicSmartModel : ai.anthropicModel, think, system, p, jpeg, onDelta, signal, alive)
      case 'openai':
        return await askOpenAiApi(smart ? ai.openaiSmartModel : ai.openaiModel, think, system, p, jpeg, onDelta, signal, alive)
      case 'claude-cli':
        return await askClaudeCli(cliModelFor('claude-cli', smart ? ai.cliSmartModel : ai.cliModel, smart), think, system, p, jpeg, onDelta, signal, alive)
      case 'codex-cli':
        return await askCodexCli(cliModelFor('codex-cli', smart ? ai.cliSmartModel : ai.cliModel, smart), think, system, p, jpeg, onDelta, signal)
    }
  } catch (err) {
    if (signal.aborted) return
    throw err instanceof RefusalError ? err : friendlyError(err)
  }
}

const COMPLETE_TIMEOUT_MS = 3 * 60_000

/**
 * Fast answers (the default) run the fast model without thinking, so the first words come in about a second. Smart
 * mode runs the smart model and thinks it through. Background work (no effort) keeps the fast model's defaults.
 */
const speedOf = (ai: State['ai'], p: Pick<AskPayload, 'effort'>) => ({ smart: p.effort === 'smart', think: p.effort === 'smart' || ai.fastThinking })

/** A model declining to answer: final, so no fallback is asked to answer in its place. */
class RefusalError extends Error {}

/** API providers need a key (saved, or in the environment); without one, trying them as a fallback is just noise. */
function usable(provider: AiProvider): boolean {
  if (provider === 'anthropic') return getKey('anthropic') !== undefined || !!process.env.ANTHROPIC_API_KEY
  if (provider === 'openai') return getKey('openai') !== undefined || !!process.env.OPENAI_API_KEY
  return true
}
const usableSafe = (p: AiProvider) => {
  try {
    return usable(p)
  } catch {
    return false // a saved key that can't be read
  }
}
/** Who will answer the next ask: the first provider in order that's set up. */
const answerer = (ai: State['ai']) => providerOrder(ai).find(usableSafe)

/**
 * The chosen provider, then each fallback in order, until one answers (see tryInOrder for when it stops). Fallback
 * CLIs run Glint's default models: the CLI model fields belong to the chosen provider. A provider that hasn't
 * started answering in time is passed over. Every failure is reported to the UI, which stays red until the chosen
 * provider answers again.
 */
export async function askWithFallbacks(
  ai: State['ai'], system: string[], p: AskPayload, onDelta: OnDelta, signal: AbortSignal,
  onSwitch?: (failures: Failure[], next: AiProvider) => void,
): Promise<{ provider: AiProvider; failures: Failure[]; usage?: Usage }> {
  let usage: Usage | undefined
  // An answer nobody asked for (Glance answering the other side) never falls back to a paid API.
  const paid = (pr: AiProvider) => pr === 'anthropic' || pr === 'openai'
  const order = AUTO_ASK.test(p.text) ? providerOrder(ai).filter((pr, i) => i === 0 || !paid(pr)) : providerOrder(ai)
  try {
    const r = await tryInOrder(
      order,
      async (provider, onText, attempt, alive) => {
        const cli = provider === ai.provider ? {} : { cliModel: '', cliSmartModel: '' }
        usage = (await runAsk({ ...ai, provider, ...cli }, system, p, (t) => (onText(), onDelta(t)), attempt, alive)) || undefined
      },
      { usable: usableSafe, isFinal: (err) => err instanceof RefusalError || signal.aborted, onSwitch, signal, firstTextMs: (provider) => firstTextMs(provider, p, system) },
    )
    if (!signal.aborted) reportFailures(r.failures, r.provider, ai.provider)
    return { ...r, usage }
  } catch (err) {
    if (!signal.aborted) reportFailures((err as { failures?: Failure[] }).failures ?? [], null, ai.provider)
    throw err
  }
}

/**
 * How long a provider gets to start answering before the next one is asked. Fast answers normally start within
 * about a second; the allowance grows with reference files, whose first read is slow. Smart mode thinks first, and
 * Codex doesn't stream, so they get longer. Background work (no effort) has only complete()'s overall limit.
 */
function firstTextMs(provider: AiProvider, p: AskPayload, system: string[]): number | undefined {
  if (!p.effort) return undefined
  if (p.effort === 'smart' || provider === 'codex-cli') return 120_000
  // 1.5M characters of files: about 52 s. Searched passages (up to 120k characters) add about 3 s.
  return 15_000 + (system.reduce((n, s) => n + s.length, 0) + (p.reference?.length ?? 0)) / 40
}

function reportFailures(failures: Failure[], answeredBy: AiProvider | null, chosen: AiProvider) {
  if (!failures.length && answeredBy === chosen) {
    if (getState().aiFailure) patchState({ aiFailure: null })
  } else if (failures.length) {
    patchState({ aiFailure: failureSummary(failures, answeredBy) })
  }
}

/**
 * One-off call. `context` leads the prompt and is cached briefly, for when the same context is asked about again.
 * `effort`: 'fast' when the user is waiting on it; unset for background work (notes) to keep the provider's default.
 */
export async function complete(
  ai: State['ai'], system: string[], prompt: string, opts: { context?: string; effort?: 'fast'; onText?: (soFar: string) => void } = {},
): Promise<string> {
  let out = ''
  const { onText, ...rest } = opts
  const p: AskPayload = { id: 'complete', text: prompt, screenshot: null, transcript: [], history: [], hasSession: false, ...rest }
  // Bounded, so a hung CLI can't leave notes on "processing" (or Guess on "Guessing…") until Glint restarts.
  const signal = AbortSignal.timeout(COMPLETE_TIMEOUT_MS)
  await askWithFallbacks(ai, system, p, (d) => ((out += d), onText?.(out)), signal)
  if (signal.aborted) throw new Error(`no answer within ${COMPLETE_TIMEOUT_MS / 60_000} minutes`)
  return out
}

// API keys are encrypted with the OS keychain (safeStorage) and only main can read them.

const keysFile = () => path.join(app.getPath('userData'), 'keys.json')

function readKeyFile(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(keysFile(), 'utf8'))
  } catch {
    return {}
  }
}

/** undefined = none saved. Throws if one is saved but can't be decrypted, rather than silently asking without it. */
export function getKey(provider: KeyProvider | 'humanizer'): string | undefined {
  const enc = readKeyFile()[provider]
  if (!enc) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    const name = provider === 'anthropic' ? 'Claude' : provider === 'openai' ? 'OpenAI' : 'humanizer'
    throw new Error(`Your saved ${name} API key can't be read anymore (the keychain key that protected it is gone). Paste it again in Settings → AI.`)
  }
}

export function setKey(provider: KeyProvider | 'humanizer', key: string | null) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable on this system.')
  const all = readKeyFile()
  if (key) all[provider] = safeStorage.encryptString(key).toString('base64')
  else delete all[provider]
  // Atomic: a crash mid-write must not leave an empty file that silently drops the other provider's key.
  const tmp = `${keysFile()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, keysFile())
}

function statusOf(provider: KeyProvider): KeyStatus {
  try {
    return getKey(provider) ? 'saved' : 'none'
  } catch {
    return 'unreadable'
  }
}

export const keyStatus = (): Record<KeyProvider, KeyStatus> => ({ anthropic: statusOf('anthropic'), openai: statusOf('openai') })

// Models that accept server-side refusal fallbacks ("default" picks the fallback by refusal category).
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'])

/**
 * Prompt caching. Meetings leave minutes between asks, so the conversation is cached for an hour: a 5-minute entry
 * would usually expire first and every ask would pay the write surcharge for nothing. The marker goes on the end of
 * the previous turn, never on the new one: the new turn carries the screenshot and is resent later as text only, so
 * an entry written there would never be read. Cached input costs a tenth of the normal price.
 */
const CACHE_CONVERSATION = { type: 'ephemeral', ttl: '1h' } as const

/**
 * Speed. Fast answers use effort `low` and, unless the user turns it on, no thinking: the model starts writing at
 * once. Smart mode uses `high` with thinking. Older and Haiku models reject the effort setting. Thinking: Opus 5 and
 * Sonnet 5 think unless told not to; Sonnet 5.5 too, but rejects 'disabled' and turns it off with 'between_tools';
 * Opus 4.6 to 4.8 and Sonnet 4.6 only when asked; Opus 5.5 and Fable always do (low effort keeps it short).
 * ponytail: effort and thinking changes invalidate the messages cache, so a chat switching between Glance (always
 * fast) and smart asks re-reads its history at full price on each switch; per-message effort (a beta on Claude
 * Opus 5) would avoid it.
 */
const anthropicEffort = (model: string) => !/haiku|sonnet-4-5|-4-1|-4-0|claude-3/.test(model)
const anthropicThinking = (model: string, think: boolean) =>
  !think && /^claude-(opus|sonnet)-5(-\d{8})?$/.test(model) ? { thinking: { type: 'disabled' as const } }
  // The SDK's types don't list 'between_tools' yet.
  : !think && /^claude-sonnet-5-5(-\d{8})?$/.test(model) ? { thinking: { type: 'between_tools' } as unknown as Anthropic.Beta.BetaThinkingConfigParam }
  : think && /^claude-(opus|sonnet)-4-[6-9]/.test(model) ? { thinking: { type: 'adaptive' as const } }
  : {}
/** Thinks even on a fast answer, so it gets thinking's room in maxOutput. */
const alwaysThinks = (model: string) => /^claude-(opus-5-5|fable)/.test(model)
/** OpenAI reasoning: none (GPT-5.1 and later) or minimal (GPT-5) for fast answers without thinking. */
function openAiEffort(model: string, effort: AskPayload['effort'], think: boolean) {
  if (!effort || !/^(gpt-5|o\d)/.test(model)) return undefined
  if (effort === 'smart') return 'high' as const
  if (think || /^o\d/.test(model)) return 'low' as const
  return /^gpt-5\.\d/.test(model) ? 'none' as const : 'minimal' as const
}
/** One-off context asked about again within minutes (name guesses about several speakers). */
const CACHE_CONTEXT = { type: 'ephemeral', ttl: '5m' } as const

/**
 * Everything ahead of the messages: the part that's cached. Asks and warmCache build it the same way, since any
 * difference, effort included, would make them different cache entries.
 */
function anthropicPrefix(model: string, think: boolean, system: string[], effort: AskPayload['effort']) {
  return {
    model,
    ...(effort && anthropicEffort(model) ? { output_config: { effort: effort === 'smart' ? 'high' as const : 'low' as const } } : {}),
    ...anthropicThinking(model, think),
    system: system.map((text) => ({ type: 'text' as const, text, cache_control: CACHE_CONVERSATION })),
    ...(FALLBACK_MODELS.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  }
}

/** Most output one request may bill: only a runaway reaches it. Thinking counts toward it, so it gets more room. */
const maxOutput = (think: boolean) => (think ? 32_000 : 8_000)
/**
 * Reaching that limit (thinking included) stops the answer mid-sentence. An error, not an answer: an ask keeps what
 * it showed and says it failed; notes and other one-offs fail and can be retried instead of being saved cut short.
 */
const CUT_OFF = 'The answer was cut off: it reached the length limit.'

/** When each cached prefix was last written or read: the 1 h cache is still warm for a while after. */
const usedAt = new Map<string, number>()
const prefixKey = (prefix: object) => createHash('sha256').update(JSON.stringify(prefix)).digest('hex')
const WARM_FOR_MS = 50 * 60_000

/**
 * Writes a big system prompt (reference files) into the Claude API's cache before the first ask, so that ask
 * doesn't wait for it. Only the Claude API has a way to do this without generating an answer. A prefix used within
 * the last 50 minutes is still cached, so it's skipped.
 */
export async function warmCache(ai: State['ai'], system: string[], effort: AskPayload['effort']) {
  if (answerer(ai) !== 'anthropic') return
  const { smart, think } = speedOf(ai, { effort })
  const prefix = anthropicPrefix(smart ? ai.anthropicSmartModel : ai.anthropicModel, think, system, effort)
  const key = prefixKey(prefix)
  if (Date.now() - (usedAt.get(key) ?? 0) < WARM_FOR_MS) return
  usedAt.set(key, Date.now())
  try {
    const client = new Anthropic({ apiKey: getKey('anthropic') })
    // max_tokens 0: the prompt is read and cached, and nothing is generated or billed as output.
    const r = await client.beta.messages.create({ ...prefix, max_tokens: 0, messages: [{ role: 'user', content: 'warmup' }] })
    console.log(`[ai] cache warmed: write=${r.usage.cache_creation_input_tokens ?? 0} read=${r.usage.cache_read_input_tokens ?? 0}`)
  } catch (err) {
    usedAt.delete(key)
    console.warn('[ai] cache warm failed:', (err as Error).message) // the next ask reports any real problem
  }
}

async function askClaudeApi(model: string, think: boolean, system: string[], p: AskPayload, jpeg: Buffer | null, onDelta: OnDelta, signal: AbortSignal, alive?: () => void): Promise<Usage> {
  // With no saved key, the SDK falls back to ANTHROPIC_API_KEY / an `ant auth login` profile.
  const client = new Anthropic({ apiKey: getKey('anthropic') })
  const content: Anthropic.Beta.BetaContentBlockParam[] = []
  if (jpeg) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } })
  if (p.context) content.push({ type: 'text', text: p.context, cache_control: CACHE_CONTEXT })
  content.push({ type: 'text', text: userPrompt({ ...p, context: undefined }) })
  const history: Anthropic.Beta.BetaMessageParam[] = p.history
    .filter((m) => m.text.trim())
    .map((m, i, all) => ({ role: m.role, content: [{ type: 'text', text: m.text, ...(i === all.length - 1 ? { cache_control: CACHE_CONVERSATION } : {}) }] }))

  const prefix = anthropicPrefix(model, think, system, p.effort)
  const stream = client.beta.messages.stream({ ...prefix, max_tokens: maxOutput(think || alwaysThinks(model)), messages: [...history, { role: 'user', content }] }, { signal })
  for await (const event of stream) {
    alive?.()
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onDelta(event.delta.text)
  }
  const final = await stream.finalMessage()
  usedAt.set(prefixKey(prefix), Date.now())
  if (final.stop_reason === 'refusal') throw new RefusalError('Claude declined to answer this one.')
  if (final.stop_reason === 'max_tokens') throw new Error(CUT_OFF)
  const u = final.usage
  return { input: u.input_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens }
}

async function askOpenAiApi(model: string, think: boolean, system: string[], p: AskPayload, jpeg: Buffer | null, onDelta: OnDelta, signal: AbortSignal, alive?: () => void): Promise<Usage> {
  const client = new OpenAI({ apiKey: getKey('openai') }) // no saved key: falls back to OPENAI_API_KEY
  const stream = client.responses.stream(
    {
      model,
      instructions: system.join('\n\n'),
      // OpenAI caches shared prefixes on its own; one key per system prompt keeps a user's asks on the same cache.
      prompt_cache_key: `glint-${createHash('sha256').update(system.join('\n\n')).digest('hex').slice(0, 16)}`,
      max_output_tokens: maxOutput(think),
      ...(openAiEffort(model, p.effort, think) ? { reasoning: { effort: openAiEffort(model, p.effort, think)! } } : {}),
      input: [
        ...p.history.filter((m) => m.text.trim()).map((m) => ({ role: m.role, content: m.text })),
        {
          role: 'user',
          content: [
            ...(jpeg ? [{ type: 'input_image' as const, detail: 'auto' as const, image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}` }] : []),
            { type: 'input_text' as const, text: userPrompt(p) },
          ],
        },
      ],
    },
    { signal },
  )
  for await (const event of stream) {
    alive?.()
    if (event.type === 'response.output_text.delta') onDelta(event.delta)
  }
  const final = await stream.finalResponse()
  if (final.status === 'incomplete') throw new Error(final.incomplete_details?.reason === 'content_filter' ? "OpenAI's content filter cut the answer off." : CUT_OFF)
  const u = final.usage
  return { input: (u?.input_tokens ?? 0) - (u?.input_tokens_details?.cached_tokens ?? 0), cacheRead: u?.input_tokens_details?.cached_tokens ?? 0, cacheWrite: 0, output: u?.output_tokens ?? 0 }
}

// Subscription logins run the user's own `claude` / `codex` CLI, which must be installed and signed in.

let loginPath: Promise<string> | null = null

/** Apps launched from Finder get a bare PATH; borrow the login shell's so ~/.local/bin, Homebrew, nvm etc. resolve. */
export function shellPath(): Promise<string> {
  return (loginPath ??= new Promise((resolve) => {
    // printenv, not $PATH: fish joins its PATH list with spaces. Last line: profile scripts may print a greeting first.
    execFile(process.env.SHELL || '/bin/zsh', ['-lc', '/usr/bin/printenv PATH'], { timeout: 5000 }, (err, out) => {
      const path = out?.trim().split('\n').at(-1)
      if (err || !path) loginPath = null // a slow or failing profile at login: try again next time, not never
      resolve(err || !path ? `${process.env.PATH}:${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin` : path)
    })
  }))
}

/**
 * What the CLI itself says about its sign-in. Its login is separate from the Claude or ChatGPT app's, so the app
 * being signed in says nothing about whether the CLI Glint runs is.
 */
export async function cliStatus(provider: 'claude-cli' | 'codex-cli'): Promise<{ ok: boolean; detail: string }> {
  const PATH = await shellPath()
  const [cmd, args] = provider === 'claude-cli' ? ['claude', ['auth', 'status']] : ['codex', ['login', 'status']]
  const signIn = provider === 'claude-cli' ? 'Run `claude auth login` in Terminal.' : 'Run `codex login` in Terminal.'
  return new Promise((resolve) => {
    // Exits non-zero when signed out, so read the output either way.
    execFile(cmd, args, { env: { ...process.env, PATH }, timeout: 15_000 }, (err, stdout, stderr) => {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return resolve({ ok: false, detail: `The \`${cmd}\` command isn't installed.` })
      if (provider === 'claude-cli') {
        try {
          const j = JSON.parse(stdout)
          const who = [j.email, j.subscriptionType].filter((x) => typeof x === 'string' && x).join(', ')
          return resolve(j.loggedIn === true ? { ok: true, detail: `Signed in${who ? ` (${who})` : ''}.` } : { ok: false, detail: `Not signed in. ${signIn}` })
        } catch {
          return resolve({ ok: false, detail: `Couldn't read its sign-in status. ${signIn}` })
        }
      }
      const out = `${stdout}\n${stderr}`.trim()
      resolve(/logged in/i.test(out) && !/not logged in/i.test(out) ? { ok: true, detail: out.split('\n').at(-1)! } : { ok: false, detail: `Not signed in. ${signIn}` })
    })
  })
}

const TEMP_PREFIX = 'glint-'

/** Temp dirs of asks cut off by a crash still hold that ask's screenshot. An hour old: never a running ask's. */
export function removeLeftoverTemp() {
  const tmp = os.tmpdir()
  for (const name of fs.readdirSync(tmp)) {
    if (!name.startsWith(TEMP_PREFIX)) continue
    const dir = path.join(tmp, name)
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > 60 * 60_000) fs.rmSync(dir, { recursive: true, force: true })
    } catch {} // another process's, or gone already
  }
}

async function runCli(
  name: string,
  args: (dir: string) => string[],
  stdin: string,
  signal: AbortSignal,
  opts: { files?: Record<string, string | Buffer>; afterExit?: (dir: string) => void; env?: (dir: string) => Promise<Record<string, string>> } = {},
) {
  const PATH = await shellPath()
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX))
  try {
    for (const [name, data] of Object.entries(opts.files ?? {})) await fs.promises.writeFile(path.join(dir, name), data)
    const env = { ...process.env, PATH, ...(opts.env ? await opts.env(dir) : {}) }
    const child = spawn(name, args(dir), { cwd: dir, env, signal }) // spawn searches env.PATH
    child.stdin.on('error', () => {}) // EPIPE when it exits before reading everything; its exit code reports why
    child.stdin.end(stdin)
    let stderr = ''
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)))
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', (err: NodeJS.ErrnoException) =>
        reject(err.code === 'ENOENT' ? new Error(`Couldn't find the \`${name}\` command. Install it and sign in, or pick another provider in Settings → AI.`) : err),
      )
      child.on('close', resolve)
    })
    if (signal.aborted) return
    if (code !== 0) throw new Error(`${name} exited with code ${code}: ${stderr.trim().split('\n').at(-1) ?? ''}`)
    opts.afterExit?.(dir)
  } finally {
    void fs.promises.rm(dir, { recursive: true, force: true })
  }
}

// Claude Code, kept warm. Starting `claude` takes 1 to 4 s before it even sends the question, so a process is
// started ahead of time and waits for its first message. After answering it stays with its chat: the next ask sends
// only the new turn, and the CLI answers from its cached copy of the conversation instead of re-reading all of it.

interface Warm {
  /** What the process was started with (arguments and system prompt): only an ask with the same can use it. */
  key: string
  child: ChildProcessWithoutNullStreams
  /** The replies its conversation holds, oldest first; none until it's first asked. */
  replies: string[]
  busy: boolean
  usedAt: number
  onLine: ((line: string) => void) | null
  stderr: string
  exited: Promise<number | null>
  dead: boolean
  /** Characters of passages and screenshots its conversation holds: every turn it's sent stays in it. */
  passages: number
}
const warm: Warm[] = []
/**
 * Past this much, a chat's next ask starts a fresh process, told the chat as text, so old passages and screenshots
 * don't pile up in its conversation (each is read again on every turn).
 */
const WARM_PASSAGES_MAX = 200_000
/** A screenshot counted in characters: about 2,100 tokens at 1568 px. */
const SCREENSHOT_CHARS = 8_400
/** A chat's own process and one spare for the next new chat. */
const WARM_MAX = 2
const WARM_IDLE_MS = 10 * 60_000
let warmTimer: NodeJS.Timeout | null = null

function claudeArgs(model: string, effort: AskPayload['effort'], think: boolean): string[] {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', '', // no tools: the screenshot goes inline, so it answers in one turn and can't act on anything
    '--no-session-persistence', '--strict-mcp-config',
    // No user/project settings or skills: the user's CLAUDE.md, hooks, plugins and skills are for their coding
    // sessions, and would otherwise be injected into every meeting answer (overriding Glint's). The login still works.
    '--setting-sources=', '--disable-slash-commands',
    '--system-prompt-file', 'system.txt', // a file: reference files can be far past the argument size limit
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort === 'smart' ? 'high' : 'low'] : []),
    ...(think ? [] : ['--settings', JSON.stringify({ alwaysThinkingEnabled: false })]),
  ]
}

/** `busy`: started for an ask, so trimming never takes it for an idle one before the ask gets to use it. */
async function startClaude(args: string[], system: string, key: string, busy = false): Promise<Warm> {
  const PATH = await shellPath()
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX))
  await fs.promises.writeFile(path.join(dir, 'system.txt'), system)
  const child = spawn('claude', args, { cwd: dir, env: { ...process.env, PATH } }) // spawn searches env.PATH
  verbose(`[ai] Claude Code process started (${warm.length + 1} running)`)
  const w: Warm = { key, child, replies: [], busy, usedAt: Date.now(), onLine: null, stderr: '', exited: Promise.resolve(null), dead: false, passages: 0 }
  child.stderr.on('data', (d) => (w.stderr = (w.stderr + d).slice(-4000)))
  createInterface({ input: child.stdout }).on('line', (line) => w.onLine?.(line))
  w.exited = new Promise<number | null>((resolve) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      w.stderr = err.code === 'ENOENT' ? "Couldn't find the `claude` command. Install it and sign in, or pick another provider in Settings → AI." : err.message
      resolve(null)
    })
    child.on('close', resolve)
  }).then((code) => {
    w.dead = true
    warm.splice(warm.indexOf(w), 1)
    void fs.promises.rm(dir, { recursive: true, force: true })
    return code
  })
  warm.push(w)
  warmTimer ??= setInterval(trimWarm, 60_000).unref()
  trimWarm()
  return w
}

/**
 * Ends processes idle for 10 minutes, and the least recently used idle ones past two. Busy ones don't count: a
 * one-off (notes, a name guess) answering meanwhile mustn't push out the chat's own process or its spare.
 */
function trimWarm() {
  const idle = warm.filter((w) => !w.busy && !w.dead).sort((a, b) => a.usedAt - b.usedAt)
  for (const w of idle) if (Date.now() - w.usedAt > WARM_IDLE_MS) w.child.kill()
  let live = idle.length
  for (const w of idle) if (live-- > WARM_MAX) w.child.kill()
}
app.on('will-quit', () => warm.forEach((w) => w.child.kill()))

/** Glint is out of use (see warmForUse): ends every Claude Code process not answering right now. */
export function coolClaudeCli() {
  const idle = warm.filter((w) => !w.busy && !w.dead)
  if (idle.length) verbose(`[ai] ended ${idle.length} idle Claude Code process${idle.length > 1 ? 'es' : ''}`)
  for (const w of idle) w.child.kill()
}

const spareFor = (key: string) => warm.find((w) => w.key === key && !w.busy && !w.dead && !w.replies.length)

/** Makes sure a started, unused process is waiting for the next new chat with these settings. */
async function ensureSpare(args: string[], system: string, key: string) {
  if (!spareFor(key)) await startClaude(args, system, key).catch((err) => console.warn('[ai] claude warm start failed:', err))
}

/**
 * Starts a Claude Code process ahead of the next ask (Glint in use, see index), when Claude Code is what will answer:
 * the chosen provider, or the first fallback when the ones before it aren't set up (no API key).
 */
export async function warmClaudeCli(ai: State['ai'], system: string[], effort: AskPayload['effort']) {
  if (answerer(ai) !== 'claude-cli') return
  const own = ai.provider === 'claude-cli' // the CLI model fields belong to the chosen provider, as in askWithFallbacks
  const { smart, think } = speedOf(ai, { effort })
  const model = own ? (smart ? ai.cliSmartModel : ai.cliModel) : ''
  const args = claudeArgs(cliModelFor('claude-cli', model, smart), effort, think)
  const sys = system.join('\n\n')
  await ensureSpare(args, sys, warmKey(args, sys))
}

const warmKey = (args: string[], system: string) => createHash('sha256').update(JSON.stringify(args)).update(system).digest('hex')
const replyOf = (text: string) => scrub(text).trim()

async function askClaudeCli(model: string, think: boolean, system: string[], p: AskPayload, jpeg: Buffer | null, onDelta: OnDelta, signal: AbortSignal, alive?: () => void) {
  const args = claudeArgs(model, p.effort, think)
  const sys = system.join('\n\n')
  const key = warmKey(args, sys)
  const past = p.history.filter((m) => m.role === 'assistant' && m.text.trim()).map((m) => replyOf(m.text))
  // This chat's own process if it's free and holds exactly this conversation; else a fresh one, told the history.
  const own = warm.find((w) => w.key === key && !w.busy && !w.dead && w.replies.length > 0 && w.replies.join('\0') === past.join('\0'))
  const passages = (p.reference?.length ?? 0) + (jpeg ? SCREENSHOT_CHARS : 0)
  // Too many searched passages already in its conversation: start over, told the chat without them.
  if (own && own.passages + passages > WARM_PASSAGES_MAX) own.child.kill()
  const chat = own && own.passages + passages <= WARM_PASSAGES_MAX ? own : undefined
  // A one-off (complete(): notes, a name guess) is never asked again, so its process isn't kept and gets no spare.
  const oneOff = p.id === 'complete'
  const w = chat ?? spareFor(key) ?? (await startClaude(args, sys, key, true))
  // Stopped while it started: the fresh process stays as a spare, unless it was a one-off's.
  if (signal.aborted) return void (oneOff ? w.child.kill() : (w.busy = false))
  w.busy = true
  w.passages += passages
  const content = [
    ...(jpeg ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } }] : []),
    { type: 'text', text: chat ? userPrompt(p) : cliPrompt(p) },
  ]
  let reply = ''
  let cliError: string | undefined
  const answered = new Promise<'answered'>((resolve) => {
    w.onLine = (line) => {
      // Lines already read when it was stopped (timed out): not part of any answer, and showing one would count as started.
      if (signal.aborted) return
      alive?.()
      const r = parseClaudeLine(line)
      if (r.text) {
        reply += r.text
        onDelta(r.text)
      }
      if (r.error) cliError = r.error
      if (r.done) resolve('answered')
    }
  })
  const stop = () => w.child.kill()
  signal.addEventListener('abort', stop)
  try {
    w.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`)
    const outcome = await Promise.race([answered, w.exited])
    if (signal.aborted) return
    if (cliError) throw new Error(/auth|login|oauth/i.test(cliError) ? `${cliError}. The claude CLI signs in separately from the Claude app: run \`claude auth login\` in Terminal.` : cliError)
    if (outcome !== 'answered') throw new Error(w.stderr.includes('`claude`') ? w.stderr : `claude exited with code ${outcome}: ${w.stderr.trim().split('\n').at(-1) ?? ''}`)
    Object.assign(w, { replies: [...past, replyOf(reply)], busy: false, usedAt: Date.now(), onLine: null })
  } catch (err) {
    w.child.kill() // its conversation no longer matches the chat's
    throw err
  } finally {
    signal.removeEventListener('abort', stop)
  }
  if (oneOff) w.child.kill()
  else void ensureSpare(args, sys, key) // for the next new chat, or an ask while this one is busy
}

async function askCodexCli(model: string, _think: boolean, system: string[], p: AskPayload, jpeg: Buffer | null, onDelta: OnDelta, signal: AbortSignal) {
  await runCli(
    'codex',
    (dir) => [
      'exec', '--skip-git-repo-check', '--sandbox', 'read-only',
      // No shell tool: the prompt carries other people's speech and screen text, and read-only still allows
      // reading any file. Without a shell, an injected "cat ~/.ssh/…" has nothing to run it with.
      '-c', 'features.shell_tool=false',
      '--output-last-message', path.join(dir, 'reply.txt'),
      ...(model ? ['-m', model] : []),
      ...(p.effort ? ['-c', `model_reasoning_effort=${p.effort === 'smart' ? 'high' : 'low'}`] : []), // no lower level every Codex model takes
      ...(jpeg ? ['-i', 'screen.jpg'] : []),
      '-', // prompt from stdin
    ],
    `${system.join('\n\n')}\n\n${cliPrompt(p)}${jpeg ? '\n\n(A screenshot of my screen is attached.)' : ''}`,
    signal,
    {
      files: jpeg ? { 'screen.jpg': jpeg } : {},
      afterExit: (dir) => onDelta(fs.readFileSync(path.join(dir, 'reply.txt'), 'utf8').trim()), // no streaming
      // A private CODEX_HOME holding only the login: the user's MCP servers and plugins (computer use, file access)
      // stay out of reach of instructions planted in other people's speech or screen text, and Codex's own session
      // logs of this prompt land in the temp dir that's deleted afterwards.
      env: async (dir) => {
        const home = path.join(dir, 'codex-home')
        await fs.promises.mkdir(home)
        const auth = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json')
        await fs.promises.symlink(auth, path.join(home, 'auth.json')).catch(() => {}) // no login: codex says so
        return { CODEX_HOME: home }
      },
    },
  )
}

const TOO_LONG = /prompt is too long|context.{0,20}(length|window|limit)|maximum context|too many (input )?tokens/i
const TOO_LONG_MESSAGE = "Too long for this model: the mode's reference files and this chat together don't fit. A model with a bigger context (Claude, 1M tokens) takes them, or remove a file, or start a new chat."

function friendlyError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError)
    return new Error('The API key was rejected. Check it in Settings → AI.')
  if (err instanceof Anthropic.RateLimitError || err instanceof OpenAI.RateLimitError)
    return new Error(`Rate limited or out of credits: ${err.message}`)
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError)
    return new Error("Couldn't reach the API. Check your connection.")
  if (err instanceof Error && TOO_LONG.test(err.message)) return new Error(TOO_LONG_MESSAGE) // APIs and CLIs alike
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) return new Error(`API error ${err.status ?? ''}: ${err.message}`)
  if (err instanceof Anthropic.AnthropicError && /api key|authentication/i.test(err.message))
    return new Error('No Claude API key. Add one in Settings → AI.')
  if (err instanceof OpenAI.OpenAIError && /api key/i.test(err.message)) return new Error('No OpenAI API key. Add one in Settings → AI.')
  return err instanceof Error ? err : new Error(String(err))
}
