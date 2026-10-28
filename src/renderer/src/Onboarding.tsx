import { useEffect, useRef, useState } from 'react'
import { MODE_TEMPLATES, PRACTICE_CALLS, practiceSplit } from '../../shared/prompt'
import { PROVIDER_LABELS, readyFirst } from '../../shared/providers'
import { prettyAccelerator, speechModelFor, type AiProvider, type KeyProvider, type PracticeId, type ShortcutAction, type State } from '../../shared/state'
import { COMPUTER, glint, isMac, patch, SYSTEM_SETTINGS, useAppState } from './glint'
import { Icon } from './icons'
import { METER_BARS, openMic, peak } from './mic'
import { CHECKLIST } from '../../shared/tips'
import { CONSOLES, withCode } from './ui'

const PERMS = isMac
  ? [
      { kind: 'mic', icon: 'mic', name: 'Microphone', why: 'To transcribe what you say' },
      {
        kind: 'screen', icon: 'screen', name: 'Screen & system audio recording',
        why: 'So Glint hears the other side and can read your screen when you ask. Glint restarts after you allow it.',
      },
    ] as const
  : ([{ kind: 'mic', icon: 'mic', name: 'Microphone', why: 'To transcribe what you say. Windows turns it on for all desktop apps at once.' }] as const)

type Step = 'use' | 'permissions' | 'ai' | 'practice' | 'mode' | 'try' | 'ready'
const STEP_LABELS: Record<Step, string> = {
  use: 'Start', permissions: 'Permissions', ai: 'AI', practice: 'Practice call', mode: 'Your mode', try: 'Ask anything', ready: 'Done',
}

export function Onboarding() {
  const s = useAppState()
  const [step, setStep] = useState<Step | null>(null)
  const [dir, setDir] = useState(1)
  const [fast, setFast] = useState(false) // "I've used Glint before": straight to the app after the AI
  const [speech, setSpeech] = useState<string | null | undefined>(undefined) // undefined: loading; null: ready
  useEffect(() => void glint.invoke<string | null>('stt:prepare').then(setSpeech), [])
  // Each screen reached goes in the log, so a bug report shows where setup stopped.
  const current: Step | null = !s ? null : step ?? (s.onboardingDone || (isMac && PERMS.some((p) => s.permissions[p.kind] === 'granted')) ? 'permissions' : 'use')
  useEffect(() => void (current && glint.send('setup:step', current)), [current])
  if (!s || !current) return null

  // (Above) already onboarded but a permission was revoked, or back from the relaunch Screen Recording needs: start on
  // permissions.
  const only = s.onboardingDone // a revoked permission: nothing else to show
  const steps: Step[] = only ? ['permissions'] : fast ? ['use', 'permissions', 'ai'] : ['use', 'permissions', 'ai', 'practice', 'mode', 'try', 'ready']
  const go = (to: Step) => (setDir(steps.indexOf(to) >= steps.indexOf(current) ? 1 : -1), setStep(to))
  const finish = () => {
    glint.send('practice:stop')
    if (s.session) glint.send('session:stop')
    void patch({ onboardingDone: true, practicing: false, teach: null })
  }
  const practice: PracticeId = s.useCase && s.useCase !== 'other' ? s.useCase : 'team'

  return (
    <div className="ob">
      <Rail s={s} steps={steps} current={current} speech={speech} />
      <main className="ob-main" key={current} style={{ '--from': `${dir * 24}px` } as React.CSSProperties}>
        {current === 'use' && <UseCase s={s} onNext={() => go('permissions')} onFast={() => (setFast(true), go('permissions'))} />}
        {current === 'permissions' && (
          <Permissions s={s} onBack={only ? undefined : () => go('use')}
            onContinue={() => (only ? void patch({ onboardingDone: true }) : go('ai'))} />
        )}
        {current === 'ai' && <AiSetup s={s} onBack={() => go('permissions')} onContinue={() => (fast ? finish() : go('practice'))} />}
        {current === 'practice' && <Practice s={s} id={practice} onDone={() => go('mode')} />}
        {current === 'mode' && <YourMode s={s} onDone={() => go('try')} />}
        {current === 'try' && <AskAnything s={s} onDone={() => go('ready')} />}
        {current === 'ready' && <Ready s={s} onDone={finish} />}
      </main>
    </div>
  )
}

function Rail({ s, steps, current, speech }: { s: State; steps: Step[]; current: Step; speech: string | null | undefined }) {
  const at = steps.indexOf(current)
  const granted = PERMS.filter((p) => s.permissions[p.kind] === 'granted').length
  return (
    <nav className="ob-rail" aria-label="Setup steps">
      <i className="ob-logo" aria-hidden="true" />
      <ol>
        {steps.map((st, i) => (
          <li key={st} className={i < at ? 'done' : i === at ? 'current' : ''} aria-current={i === at ? 'step' : undefined}>
            <span className="marker">{i < at ? <Icon name="check" size={14} /> : i + 1}</span>
            <span className="label">
              {STEP_LABELS[st]}
              {st === 'permissions' && i === at && <small>{granted} of {PERMS.length} granted</small>}
              {st === 'practice' && i === at && <small>About a minute</small>}
            </span>
          </li>
        ))}
      </ol>
      {/* The speech model downloads from the first screen; its progress follows you through setup. */}
      <div className="ob-rail-foot">
        <SpeechStatus s={s} speech={speech} />
        {current === 'use' && <span>Glint {s.appVersion}</span>}
      </div>
    </nav>
  )
}

const USES: { id: PracticeId | 'other'; icon: 'tag' | 'people' | 'person' | 'bulb' | 'more'; title: string; body: string }[] = [
  { id: 'sales', icon: 'tag', title: 'Sales calls', body: 'Prices, objections and next steps' },
  { id: 'team', icon: 'people', title: 'Team meetings', body: 'Who said what, and who does what' },
  { id: 'hiring', icon: 'person', title: 'Hiring interviews', body: "You're the one asking the questions" },
  { id: 'lecture', icon: 'bulb', title: 'Lectures and classes', body: 'Explanations while you listen' },
  { id: 'other', icon: 'more', title: 'Something else', body: 'Any call or meeting' },
]

/** One tap: picks the practice call and turns on the matching mode, so answers fit that kind of call from the start. */
function UseCase({ s, onNext, onFast }: { s: State; onNext: () => void; onFast: () => void }) {
  const ask = prettyAccelerator(s.shortcuts.ask, isMac) || (isMac ? '⌘↩' : 'Ctrl+Enter')
  const choose = async (use: PracticeId | 'other') => {
    const t = use === 'other' ? undefined : MODE_TEMPLATES.find((m) => m.id === PRACTICE_CALLS[use].template)
    let modeId = t && s.modes.find((m) => m.templateId === t.id)?.id
    if (t && !modeId) modeId = await glint.invoke<string>('modes:add', { templateId: t.id, name: t.name, prompt: t.prompt })
    void patch({ useCase: use, ...(modeId ? { activeModeId: modeId } : {}) })
    onNext()
  }
  return (
    <div className="ob-page">
      <div className="ob-heading wide">
        <h1 className="big">What will you use Glint for first?</h1>
        <p>
          Glint listens to your calls, answers when you press {ask}, and writes the notes after. Pick one, and you'll
          practise on a short call like it. It runs on your {COMPUTER} and talks only to the AI you choose.
        </p>
      </div>
      <div className="ob-uses">
        {USES.map((u) => (
          <button key={u.id} className={`ob-card ob-use ${s.useCase === u.id ? 'on' : ''}`} onClick={() => void choose(u.id)}>
            <Icon name={u.icon} size={20} /><b>{u.title}</b><span>{u.body}</span>
          </button>
        ))}
      </div>
      <p className="ob-notice">
        <Icon name="info" size={18} />
        <span>
          Many places require <b>everyone's consent</b> to transcribe a conversation. Many interviews, exams and assessments forbid
          outside help, whether or not it can be seen. Invisible mode hides Glint from screen sharing, but it doesn't make that help allowed.
        </span>
      </p>
      <div className="ob-foot wide">
        <button className="ob-link" onClick={onFast}>I've used Glint before</button>
        <span className="grow" />
        <span className="ob-hint">Takes about two minutes</span>
      </div>
    </div>
  )
}

function Permissions({ s, onBack, onContinue }: { s: State; onBack?: () => void; onContinue: () => void }) {
  const [askedScreen, setAskedScreen] = useState(false)
  // Asked once, on the first run through: applied on Continue, so macOS's "background item added" notice follows a choice.
  const [login, setLogin] = useState(true)
  const askLogin = !s.openAtLoginInitialized
  const next = PERMS.find((p) => s.permissions[p.kind] !== 'granted')
  const leave = (skip: boolean) => {
    if (askLogin) void patch({ openAtLogin: login, openAtLoginInitialized: true })
    if (skip) void patch({ skippedPermissions: true })
    onContinue()
  }
  return (
    <div className="ob-page">
      <div className="ob-heading">
        <h1>{isMac ? 'Let Glint hear the call and see your screen' : 'Let Glint hear the call'}</h1>
        <p>{isMac ? 'macOS asks for each of these once. ' : ''}Glint only listens during a session, and only takes a screenshot when you ask.</p>
      </div>
      <ul className="ob-perms">
        {PERMS.map((p) => {
          const ok = s.permissions[p.kind] === 'granted'
          return (
            <li key={p.kind} className={`${ok ? 'ok' : ''} ${next === p ? 'next' : ''}`}>
              <span className="disc"><Icon name={p.icon} size={20} /></span>
              <span className="text"><b>{p.name}</b><span>{p.why}</span>{p.kind === 'mic' && ok && <MicMeter />}</span>
              {ok ? <span className="allowed"><Icon name="checkCircle" />Allowed</span> : (
                <button className="ob-action" disabled={next !== p}
                  onClick={() => (p.kind === 'screen' && setAskedScreen(true), void glint.invoke('permissions:request', p.kind))}>
                  Open {SYSTEM_SETTINGS}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {askedScreen && s.permissions.screen !== 'granted' && (
        <p className="ob-hint">
          Allowed it already? macOS applies it after a restart. <button className="ob-link" onClick={() => glint.send('app:relaunch')}>Quit and reopen</button>
        </p>
      )}
      {askLogin && (
        <label className="ob-login">
          <input type="checkbox" checked={login} onChange={(e) => setLogin(e.target.checked)} />
          Open Glint when you log in, so it's ready before a call
        </label>
      )}
      <div className="ob-foot">
        <span className="grow" />
        {onBack && <button className="ob-back" onClick={onBack}>Back</button>}
        {next ? <button className="ob-back" onClick={() => leave(true)}>Skip for now</button>
          : <button className="ob-primary" onClick={() => leave(false)}>Continue</button>}
      </div>
    </div>
  )
}

/** A live level for the mic, once it's allowed: proof Glint hears you. */
function MicMeter() {
  const [level, setLevel] = useState(0)
  const [heard, setHeard] = useState(false)
  useEffect(() => {
    let cancelled = false
    let close: (() => void) | undefined
    openMic((pcm) => {
      if (cancelled) return
      const l = peak(pcm)
      setLevel(l)
      if (l > 0.25) setHeard(true)
    }).then((c) => (cancelled ? c() : (close = c)), () => {})
    return () => ((cancelled = true), close?.())
  }, [])
  return (
    <span className="ob-meter">
      <span className="meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level}>
        {METER_BARS.map((h, i) => <i key={i} className={i < Math.round(level * METER_BARS.length) ? 'on' : ''} style={{ height: h }} />)}
      </span>
      {heard ? "That's you." : 'Say something to test it.'}
    </span>
  )
}

const AI_ROWS: { p: AiProvider; icon: 'terminal' | 'bolt'; why: string; setUp?: string }[] = [
  { p: 'claude-cli', icon: 'terminal', why: 'Your Claude subscription, through Claude Code. Nothing extra to pay.', setUp: '`npm install -g @anthropic-ai/claude-code`, then `claude auth login`' },
  { p: 'codex-cli', icon: 'terminal', why: 'Your ChatGPT plan, through Codex. Nothing extra to pay.', setUp: '`npm install -g @openai/codex`, then `codex login`' },
  { p: 'anthropic', icon: 'bolt', why: 'An Anthropic API key. You pay Anthropic a few cents an answer.' },
  { p: 'openai', icon: 'bolt', why: 'An OpenAI API key. You pay OpenAI a few cents an answer.' },
]

/** Which AI answers: a subscription CLI that's signed in, or an API key, checked and saved here as in Settings → AI. */
function AiSetup({ s, onBack, onContinue }: { s: State; onBack: () => void; onContinue: () => void }) {
  const [cli, setCli] = useState<Partial<Record<AiProvider, { ok: boolean; detail: string } | 'checking'>>>({})
  const check = (p: 'claude-cli' | 'codex-cli') => {
    setCli((c) => ({ ...c, [p]: 'checking' }))
    void glint.invoke<{ ok: boolean; detail: string }>('ai:cli-status', p).then(
      (r) => setCli((c) => ({ ...c, [p]: r })),
      (err: Error) => setCli((c) => ({ ...c, [p]: { ok: false, detail: err.message } })),
    )
  }
  const [keyError, setKeyError] = useState<Partial<Record<KeyProvider, string>>>({})
  useEffect(() => (check('claude-cli'), check('codex-cli')), [])
  const isReady = (p: AiProvider) => (p === 'anthropic' || p === 'openai' ? s.aiKeys[p] === 'saved' : (cli[p] as { ok?: boolean } | undefined)?.ok === true)
  const ready = new Set(AI_ROWS.map((r) => r.p).filter(isReady))
  const auto = (['claude-cli', 'codex-cli'] as const).find((p) => ready.has(p))
  // The ready ones answer first, so the first question goes to one that works.
  const next = () => {
    const order = readyFirst(s.ai, ready)
    if (order) void patch({ ai: order })
    onContinue()
  }
  return (
    <div className="ob-page">
      <div className="ob-heading">
        <h1>{auto ? `Glint will use your ${auto === 'claude-cli' ? 'Claude subscription' : 'ChatGPT plan'}` : 'Pick the AI that answers'}</h1>
        <p>
          {auto ? 'It was already signed in, so there is nothing to set up and nothing extra to pay. ' : 'Use a subscription you already have, or a pay-as-you-go key at about a cent an answer. '}
          Glint talks only to the ones you set up, and tries the next if one fails.
        </p>
      </div>
      <ul className="ob-perms">
        {AI_ROWS.map(({ p, icon, why, setUp }) => {
          const ok = ready.has(p)
          const status = cli[p]
          const missing = status && status !== 'checking' && !status.ok && /isn't installed/.test(status.detail)
          const detail = status && status !== 'checking' && !status.ok && !missing ? status.detail : ''
          return (
            <li key={p} className={ok ? 'ok' : ''}>
              <span className="disc"><Icon name={icon} size={20} /></span>
              <span className="text">
                <b>{PROVIDER_LABELS[p]}</b>
                <span>{why}</span>
                {detail && <span>{withCode(detail)}</span>}
                {missing && setUp && (
                  <details className="ob-dev"><summary>Not installed yet. For developers</summary><span>{withCode(setUp)}</span></details>
                )}
                {(p === 'anthropic' || p === 'openai') && !ok && (keyError[p]
                  ? <span className="error">{keyError[p]}</span>
                  : <span><a href={CONSOLES[p]} target="_blank" rel="noreferrer">Get a key</a></span>)}
              </span>
              {ok ? <span className="allowed"><Icon name="checkCircle" />Ready</span>
                : p === 'anthropic' || p === 'openai' ? <KeyInput provider={p} onError={(e) => setKeyError((k) => ({ ...k, [p]: e }))} />
                : <button className="ob-action" disabled={status === 'checking'} onClick={() => check(p as 'claude-cli' | 'codex-cli')}>
                    {status === 'checking' ? 'Checking…' : 'Check again'}
                  </button>}
            </li>
          )
        })}
      </ul>
      <div className="ob-foot">
        {!ready.size && <button className="ob-link" onClick={onContinue}>Set it up later</button>}
        <span className="grow" />
        <button className="ob-back" onClick={onBack}>Back</button>
        <button className={`ob-primary ${ready.size ? '' : 'waiting'}`} disabled={!ready.size} onClick={next}>Continue</button>
      </div>
    </div>
  )
}

/** An API key, saved encrypted like Settings → AI saves it; the row turns Ready once it is. */
function KeyInput({ provider, onError }: { provider: KeyProvider; onError: (error: string) => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const fail = (e: string) => (setError(e), onError(e))
  const save = () => void glint.invoke('ai:set-key', provider, value).then(() => setValue(''), (err: Error) => fail(err.message))
  return (
    <form className="ob-key" onSubmit={(e) => (e.preventDefault(), save())}>
      <input type="password" autoComplete="off" spellCheck={false} placeholder="Paste key" aria-label={`${PROVIDER_LABELS[provider]} key`}
        aria-invalid={!!error} value={value} onChange={(e) => (setValue(e.target.value), error && fail(''))} />
      <button type="submit" className="ob-action" disabled={!value.trim()}>Save</button>
    </form>
  )
}

/** The on-device models downloading during setup (stt:prepare), each named with its size, one after another. */
function SpeechStatus({ s, speech }: { s: State; speech: string | null | undefined }) {
  const t = s.transcription
  if (t.engine !== 'local') return null
  const model = speechModelFor(t.language, t.localModel).label
  const pct = /(\d+)%/.exec(s.sttStatus ?? '')?.[1]
  if (speech) return <span className="ob-speech error">{speech}</span>
  if (s.sttStatus?.startsWith('Downloading')) {
    return <span className="ob-speech">{pct && <span className="track"><i style={{ width: `${pct}%` }} /></span>}{s.sttStatus.replace(/… \d+%$/, ` · ${pct}%`)}</span>
  }
  return <span className="ob-speech">{speech === null ? `Speech models ready: ${model}` : 'Speech models: getting ready…'}</span>
}

// The practice call: two system voices and big captions in this window (so it works muted), the real overlay answering.
// The session records nothing; main writes each line into the transcript as it's spoken (practice:say).

/** How long the call waits for the ask before carrying on without it. */
const ASK_WAIT_MS = 30_000
type Beat = 'idle' | 'talking' | 'ask' | 'ended'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function Practice({ s, id, onDone }: { s: State; id: PracticeId; onDone: () => void }) {
  const call = PRACTICE_CALLS[id]
  const k = (a: ShortcutAction) => prettyAccelerator(s.shortcuts[a], isMac)
  const [beat, setBeat] = useState<Beat>('idle')
  const [caption, setCaption] = useState<{ who: 0 | 1; text: string } | null>(null)
  const [asked, setAsked] = useState(false) // the answer has started: the call waits for it to finish
  const since = useRef(Date.now())
  const answered = !!s.lastAnswer?.inSession && s.lastAnswer.at > since.current // an answer that failed doesn't tick
  const [shot, setShot] = useState<string | null | undefined>(undefined) // undefined: not looked yet; null: no screen permission
  const [hide, setHide] = useState<0 | 1 | 2>(0) // hidden once, then back
  const alive = useRef(true)
  const ran = useRef(false)
  const waitAsk = useRef<{ resolve: () => void; timer: number } | null>(null)

  useEffect(() => {
    alive.current = true
    void patch({ practicing: true })
    return () => {
      alive.current = false
      waitAsk.current?.resolve()
      glint.send('practice:stop')
      glint.send('practice:end')
      void patch({ teach: null })
    }
  }, [])

  // Each line waits for its time and for the one before to finish being spoken (`at` alone if speech isn't available).
  const play = async (lines: typeof call.lines, offset: number) => {
    const t0 = Date.now()
    let free = 0
    for (const [i, line] of lines.entries()) {
      const wait = Math.max(t0 + line.at * 1000, free + 400) - Date.now()
      if (wait > 0) await sleep(wait)
      if (!alive.current) return false
      setCaption(line)
      await glint.invoke('practice:say', offset + i)
      free = Date.now()
    }
    return alive.current
  }
  const live = !!s.session?.practice
  useEffect(() => {
    if (!live || ran.current) return
    ran.current = true
    const { before, after } = practiceSplit(id)
    void (async () => {
      if (!(await play(before, 0))) return
      setBeat('ask')
      void patch({ teach: 'ask' })
      await new Promise<void>((resolve) => (waitAsk.current = { resolve, timer: window.setTimeout(resolve, ASK_WAIT_MS) }))
      if (!alive.current) return
      void patch({ teach: null })
      setBeat('talking')
      if (!(await play(after, before.length))) return
      await sleep(1200)
      setCaption(null)
      setBeat('ended')
      glint.send('practice:end') // the overlay opens its notes
    })()
  }, [live])

  // The ask ticks once the answer starts; the call carries on a moment after it finishes.
  useEffect(() => {
    if (beat !== 'ask') return
    if (s.chat.isStreaming) return void (setAsked(true), clearTimeout(waitAsk.current?.timer))
    if (!asked) return
    const t = setTimeout(() => waitAsk.current?.resolve(), 1500)
    return () => clearTimeout(t)
  }, [beat, asked, s.chat.isStreaming])
  useEffect(() => {
    if (!s.overlayVisible && hide === 0) setHide(1)
    if (s.overlayVisible && hide === 1) setHide(2)
  }, [s.overlayVisible])

  const look = () => void glint.invoke<string | null>('practice:screen').then(setShot, () => setShot(null))
  const ended = beat === 'ended'
  const tasks = [
    { done: answered, title: `${call.cue} Press ${k('ask')}`, sub: `From any app. Glint reads what was said and the ${call.material.title.toLowerCase()}, then answers in the overlay.` },
    { done: shot !== undefined, title: 'See what a screen share sees', sub: "Glint's windows aren't in it.", action: { label: 'Show me', run: look } },
    { done: hide === 2, title: `Press ${k('toggleOverlay')} to hide Glint, then again to bring it back`, sub: 'Works from any app.' },
    { done: ended, title: 'Get the notes', sub: 'The call ends by itself. Summary, action items and a follow-up email open in the overlay.' },
  ]
  const current = beat === 'idle' ? undefined : tasks.find((t) => !t.done)
  const who = caption ? call.people[caption.who] : ''
  return (
    <div className="ob-page tryit">
      <div className="tryit-left">
        <h1>Practise on {call.title.toLowerCase()}</h1>
        <div className={`ob-cc ${caption ? `voice-${caption.who}` : ''}`} aria-live="polite">
          {beat === 'idle' ? (
            <>
              <span className="muted">{call.people.join(' and ')} are on the call. Captions show every line, so it works with the sound off.</span>
              <button className="ob-primary" onClick={() => glint.send('practice:start', id)}>Start the call</button>
            </>
          ) : caption ? <p><b>{who}</b>{caption.text}</p>
            : <span className="muted">{ended ? 'The call has ended.' : 'Connecting…'}</span>}
        </div>
        <ol className="ob-tasks">
          {tasks.map((t) => (
            <li key={t.title} className={t.done ? 'done' : t === current ? 'current' : ''} aria-current={t === current ? 'step' : undefined}>
              <span className="mark">{t.done ? <Icon name="checkCircle" size={20} /> : <i />}</span>
              <span>
                <b>{t.title}</b><small>{t.sub}</small>
                {t.action && !t.done && beat !== 'idle' && <button className="ob-action" onClick={t.action.run}>{t.action.label}</button>}
              </span>
            </li>
          ))}
        </ol>
        {shot !== undefined && (
          <figure className="ob-shot">
            {shot ? <><img src={shot} alt="Your screen as a screen share sees it" /><figcaption>This is what the other side sees when you share. Glint isn't there.</figcaption></>
              : <span className="muted">Allow screen recording in {SYSTEM_SETTINGS} to see this. Glint stays out of shares either way.</span>}
          </figure>
        )}
      </div>
      <aside className="sample">
        <b className="sample-head">{call.material.title}</b>
        <ul className="ob-sheet">{call.material.rows.map((r) => <li key={r}>{r}</li>)}</ul>
        <p className="sample-cue">Glint uses what's on your screen too. This sheet is for the practice call.</p>
      </aside>
      <div className="ob-foot tryit-foot">
        <button className="ob-back" onClick={onDone}>Skip practice</button>
        <span className="grow" />
        <button className={`ob-primary ${ended ? '' : 'waiting'}`} onClick={onDone}>Continue</button>
      </div>
    </div>
  )
}

/** The mode setup turned on, made the user's own: its name, its instructions, and files to answer from. Or one from scratch. */
function YourMode({ s, onDone }: { s: State; onDone: () => void }) {
  const mode = s.modes.find((m) => m.id === s.activeModeId)
  const [name, setName] = useState(mode?.name ?? '')
  const [prompt, setPrompt] = useState(mode?.prompt ?? '')
  const [error, setError] = useState('')
  const jobs = s.modeFileJobs.filter((j) => j.modeId === mode?.id)
  const save = async () => {
    try {
      if (mode) await glint.invoke('modes:update', { id: mode.id, name: name.trim() || mode.name, prompt })
      else if (name.trim() || prompt.trim()) {
        const id = await glint.invoke<string>('modes:add', { name: name.trim() || 'My calls', prompt })
        await patch({ activeModeId: id })
      }
      onDone()
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <div className="ob-page">
      <div className="ob-heading">
        <h1>{mode ? `Make ${mode.name} yours` : 'Make a mode of your own'}</h1>
        <p>
          A mode tells Glint what your calls are about and how you like answers. Say what you sell, teach or work on, and add
          files to answer from: a price sheet, notes, slides. You can have as many as you like and switch on the capsule.
        </p>
      </div>
      <div className="ob-mode">
        <label>
          <span>Name</span>
          <input type="text" value={name} maxLength={60} placeholder="Client calls" onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>What Glint should know</span>
          <textarea rows={7} value={prompt}
            placeholder="I run onboarding calls for new customers of our accounting app. Answers: short, friendly, with the exact menu path when someone asks how to do something."
            onChange={(e) => setPrompt(e.target.value)} />
        </label>
        {mode && (
          <div className="ob-files">
            <button className="ob-action" onClick={() => void glint.invoke('modes:add-files', mode.id).catch((err: Error) => setError(err.message))}>Add files</button>
            <span>
              {jobs.length ? `Reading ${jobs.map((j) => j.name).join(', ')}…`
                : mode.files?.length ? mode.files.map((f) => f.name).join(', ')
                : 'PDFs, Word, slides, text. Kept on this ' + COMPUTER + ', encrypted.'}
            </span>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
      <p className="ob-hint">Glint comes with eleven ready-made modes too, for interviews, coding, lectures and more, in Settings → Modes.</p>
      <div className="ob-foot">
        <button className="ob-back" onClick={onDone}>Skip</button>
        <span className="grow" />
        <button className="ob-primary" onClick={() => void save()}>Save and continue</button>
      </div>
    </div>
  )
}

const EXAMPLES = ['What does this error mean?', 'Write a short, kind reply to this email', 'Explain this chart in two sentences', 'What should I ask in my next one-on-one?']

/** Glint without a call: ask about the screen or anything at all, then the same with smart mode. */
function AskAnything({ s, onDone }: { s: State; onDone: () => void }) {
  const k = (a: ShortcutAction) => prettyAccelerator(s.shortcuts[a], isMac)
  const since = useRef(Date.now())
  const a = s.lastAnswer && !s.lastAnswer.inSession && s.lastAnswer.at > since.current ? s.lastAnswer : null
  const [plain, setPlain] = useState(false)
  const [smart, setSmart] = useState(false)
  useEffect(() => void (a && (a.smart ? setSmart(true) : setPlain(true))), [a?.at])
  const tasks = [
    { done: plain, teach: 'ask' as const, title: `Press ${k('ask')} with something on screen`, sub: 'With no call, Glint answers about your screen. Or type any question in the chat box.' },
    {
      done: smart, teach: 'smart' as const, title: 'Turn on smart mode and ask something hard',
      sub: `The bulb beside the chat box, or ${k('toggleSmart')}. Smart mode thinks before it answers: slower, more careful. Turn it off for quick ones.`,
    },
  ]
  const current = tasks.find((t) => !t.done)
  useEffect(() => void patch({ overlayVisible: true, chat: { visible: true, view: 'chat' } }), [])
  useEffect(() => void patch({ teach: current ? (current.teach === 'smart' && s.smart ? 'ask' : current.teach) : null }), [current?.teach, s.smart])
  return (
    <div className="ob-page">
      <div className="ob-heading">
        <h1>Ask it anything, any time</h1>
        <p>Glint doesn't need a call. It's on top of every app, ready for a question about what you're looking at, or anything else.</p>
      </div>
      <ol className="ob-tasks ob-try">
        {tasks.map((t) => (
          <li key={t.title} className={t.done ? 'done' : t === current ? 'current' : ''} aria-current={t === current ? 'step' : undefined}>
            <span className="mark">{t.done ? <Icon name="checkCircle" size={20} /> : <i />}</span>
            <span><b>{t.title}</b><small>{t.sub}</small></span>
          </li>
        ))}
      </ol>
      <div className="ob-examples">
        <b>Try</b>
        {EXAMPLES.map((e) => <span key={e}>{e}</span>)}
      </div>
      <div className="ob-foot">
        <button className="ob-back" onClick={onDone}>Skip</button>
        <span className="grow" />
        <button className={`ob-primary ${current ? 'waiting' : ''}`} onClick={onDone}>Continue</button>
      </div>
    </div>
  )
}

/** The ideas to remember, each with its key, the checklist so far, and one question. */
function Ready({ s, onDone }: { s: State; onDone: () => void }) {
  const k = (a: ShortcutAction) => prettyAccelerator(s.shortcuts[a], isMac)
  const ideas = [
    { key: k('ask'), text: 'Ask, from any app, in a call or not. Glint answers from what was said and your screen.' },
    { key: k('toggleSmart'), text: 'Smart mode, the bulb beside the chat box, for hard questions: it thinks it through first. Off again for quick answers.' },
    { key: k('toggleOverlay'), text: 'Hide Glint, and bring it back.' },
    { key: k('toggleSession'), text: 'Start or end notes. Every call ends with notes and a follow-up email.' },
    { key: k('toggleInvisible'), text: 'Invisible mode, from the eye in Meeting options: Glint stays out of screen shares.' },
  ]
  const done = (id: string) => id === 'setup' || !!s.firsts[id]
  return (
    <div className="ob-page">
      <div className="ob-heading">
        <h1>You're set</h1>
        <p>
          The things to remember. Everything else you'll meet one tip at a time, when it's useful.
          {s.meetingPrompt && ' Glint offers to take notes when your next call starts.'}
        </p>
      </div>
      <ul className="ob-ideas">{ideas.map((i) => <li key={i.text}>{i.key ? <kbd>{i.key}</kbd> : <i />}<span>{i.text}</span></li>)}</ul>
      {!s.firsts.hidden && (
        <ol className="ob-tasks ob-check">
          {CHECKLIST.map((c) => (
            <li key={c.id} className={done(c.id) ? 'done' : ''}>
              <span className="mark">{done(c.id) ? <Icon name="checkCircle" size={20} /> : <i />}</span><span><b>{c.label}</b></span>
            </li>
          ))}
        </ol>
      )}
      <div className="ob-ease" role="group" aria-label="How easy was setup?">
        <span>How easy was setup?</span>
        <small>Very hard</small>
        {[1, 2, 3, 4, 5, 6, 7].map((n) => (
          <button key={n} className={s.setupEase === n ? 'on' : ''} aria-pressed={s.setupEase === n} onClick={() => void patch({ setupEase: n })}>{n}</button>
        ))}
        <small>Very easy</small>
      </div>
      <div className="ob-foot">
        {!s.firsts.hidden && <button className="ob-link" onClick={() => glint.send('checklist:hide')}>Hide tips and checklist</button>}
        <span className="grow" />
        <button className="ob-primary" onClick={onDone}>Done</button>
      </div>
    </div>
  )
}
