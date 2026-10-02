import { useEffect, useRef, useState } from 'react'
import { SAMPLE_CALL, SAMPLE_CALL_S } from '../../shared/prompt'
import { formatElapsed, prettyAccelerator, speechModelFor, type ShortcutAction, type State } from '../../shared/state'
import { glint, isMac, patch, useAppState } from './glint'
import { Icon } from './icons'

const PERMS = [
  { kind: 'mic', icon: 'mic', name: 'Microphone', why: 'To transcribe what you say' },
  {
    kind: 'screen', icon: 'screen', name: 'Screen & system audio recording',
    why: 'To hear the other side of the call and to see your screen when you ask. Glint restarts after you allow it.',
  },
] as const

type Step = 'welcome' | 'permissions' | 'demos'
const STEP_LABELS: Record<Step, string> = { welcome: 'Welcome', permissions: 'Permissions', demos: 'Try it' }

// ponytail: sign-in and plan selection (spec §15 steps 1 and 4) come with auth and billing.
export function Onboarding() {
  const s = useAppState()
  const [step, setStep] = useState<Step | null>(null)
  const [dir, setDir] = useState(1)
  const [speech, setSpeech] = useState<string | null | undefined>(undefined) // undefined: loading; null: ready
  useEffect(() => void glint.invoke<string | null>('stt:prepare').then(setSpeech), [])
  if (!s) return null

  // Already onboarded but a permission was revoked, or back from the relaunch Screen Recording needs: start on
  // permissions.
  const current = step ?? (s.onboardingDone || PERMS.some((p) => s.permissions[p.kind] === 'granted') ? 'permissions' : 'welcome')
  const only = s.onboardingDone // a revoked permission: nothing else to show
  const steps: Step[] = only ? ['permissions'] : isMac ? ['welcome', 'permissions', 'demos'] : ['welcome', 'demos']
  const go = (to: Step) => (setDir(steps.indexOf(to) >= steps.indexOf(current) ? 1 : -1), setStep(to))
  const finish = () => {
    glint.send('practice:stop')
    if (s.session) glint.send('session:stop')
    void patch({ onboardingDone: true, practicing: false, teach: null })
  }

  return (
    <div className="ob">
      <Rail s={s} steps={steps} current={current} />
      <main className="ob-main" key={current} style={{ '--from': `${dir * 24}px` } as React.CSSProperties}>
        {current === 'welcome' && <Welcome s={s} onNext={() => go(isMac ? 'permissions' : 'demos')} />}
        {current === 'permissions' && (
          <Permissions s={s} speech={speech} onBack={only ? undefined : () => go('welcome')}
            onContinue={() => (only ? void patch({ onboardingDone: true }) : go('demos'))} />
        )}
        {current === 'demos' && <TryIt s={s} onDone={finish} />}
      </main>
    </div>
  )
}

function Rail({ s, steps, current }: { s: State; steps: Step[]; current: Step }) {
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
            </span>
          </li>
        ))}
      </ol>
      {current === 'welcome' && <p className="ob-rail-foot">Glint {s.appVersion}</p>}
    </nav>
  )
}

function Welcome({ s, onNext }: { s: State; onNext: () => void }) {
  const ask = prettyAccelerator(s.shortcuts.ask, isMac) || '⌘↩'
  const cards = [
    { icon: 'wave', title: 'Hears both sides', body: 'You and the call are transcribed separately, and each speaker is labelled.' },
    { icon: 'logo', title: `Answers on ${ask}`, body: 'From any app, using your screen and what was just said.' },
    { icon: 'mail', title: 'Follows up', body: 'Notes, action items and a draft email when the call ends.' },
  ] as const
  return (
    <div className="ob-page">
      <div className="ob-heading wide">
        <h1 className="big">A second pair of ears for every call</h1>
        <p>
          Glint sits above whatever you're doing, keeps a live transcript of both sides, and answers when you press {ask}.
          It runs on your Mac and talks only to the AI provider you choose.
        </p>
      </div>
      <div className="ob-cards">
        {cards.map((c) => (
          <div key={c.title} className="ob-card"><Icon name={c.icon} size={20} /><b>{c.title}</b><span>{c.body}</span></div>
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
        <span className="ob-hint">Takes about two minutes</span>
        <span className="grow" />
        <button className="ob-primary" onClick={onNext}>Get started</button>
      </div>
    </div>
  )
}

function Permissions({ s, speech, onBack, onContinue }: {
  s: State; speech: string | null | undefined; onBack?: () => void; onContinue: () => void
}) {
  const [askedScreen, setAskedScreen] = useState(false)
  // Asked once, on the first run through: applied on Continue, so macOS's "background item added" notice follows a choice.
  const [login, setLogin] = useState(true)
  const askLogin = !s.openAtLoginInitialized
  const next = PERMS.find((p) => s.permissions[p.kind] !== 'granted')
  return (
    <div className="ob-page">
      <div className="ob-heading">
        <h1>Let Glint hear the call and see your screen</h1>
        <p>macOS asks for each of these once. Glint only listens during a session, and only takes a screenshot when you ask.</p>
      </div>
      <ul className="ob-perms">
        {PERMS.map((p) => {
          const ok = s.permissions[p.kind] === 'granted'
          return (
            <li key={p.kind} className={`${ok ? 'ok' : ''} ${next === p ? 'next' : ''}`}>
              <span className="disc"><Icon name={p.icon} size={20} /></span>
              <span className="text"><b>{p.name}</b><span>{p.why}</span></span>
              {ok ? <span className="allowed"><Icon name="checkCircle" />Allowed</span> : (
                <button className="ob-action" disabled={next !== p}
                  onClick={() => (p.kind === 'screen' && setAskedScreen(true), void glint.invoke('permissions:request', p.kind))}>
                  Open System Settings
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
        <SpeechStatus s={s} speech={speech} />
        <span className="grow" />
        {onBack && <button className="ob-back" onClick={onBack}>Back</button>}
        <button className={`ob-primary ${next ? 'waiting' : ''}`} disabled={!!next}
          onClick={() => (askLogin && void patch({ openAtLogin: login, openAtLoginInitialized: true }), onContinue())}>Continue</button>
      </div>
    </div>
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

// Try it (5b): a practice run on a sample call, with the real overlay. Onboarding stays open in practice mode.

type Task = 'start' | 'ask' | 'invisible' | 'end'

function TryIt({ s, onDone }: { s: State; onDone: () => void }) {
  const [done, setDone] = useState<Record<Task, boolean>>({ start: false, ask: false, invisible: false, end: false })
  const session = useRef<string | null>(null)
  const k = (a: ShortcutAction) => prettyAccelerator(s.shortcuts[a], isMac)

  useEffect(() => {
    void patch({ practicing: true })
    return () => (glint.send('practice:stop'), void patch({ practicing: false, teach: null }))
  }, [])

  const tasks: { id: Task; title: string; sub: string; teach: State['teach'] }[] = [
    { id: 'start', title: 'Start a session', sub: `${k('toggleSession')} · the sample is playing through your speakers`, teach: 'start' },
    { id: 'ask', title: `When "Jordan" asks a question, press ${k('ask')}`, sub: 'You can press it from any app. Glint reads the transcript and this window, then answers above.', teach: 'ask' },
    { id: 'invisible', title: 'Turn on invisible mode, then check a screen share', sub: 'The dashed edge means hidden', teach: 'invisible' },
    { id: 'end', title: 'End the session and open its notes', sub: 'Action items and a follow-up email appear there', teach: 'stop' },
  ]
  const current = tasks.find((t) => !done[t.id])

  // Each task ticks from what really happened.
  useEffect(() => {
    const tick = (id: Task) => setDone((d) => (d[id] ? d : { ...d, [id]: true }))
    if (s.session && !session.current) session.current = s.session.id
    if (session.current) tick('start')
    if (s.session?.id === session.current && s.chat.isStreaming) tick('ask')
    if (current?.id === 'invisible' && s.isInvisible) tick('invisible')
    if (session.current && !s.session) tick('end')
  }, [s.session, s.chat.isStreaming, s.isInvisible, current?.id])
  useEffect(() => void patch({ teach: current?.teach ?? null }), [current?.teach])

  const all = !current
  return (
    <div className="ob-page tryit">
      <div className="tryit-left">
        <h1>Practise on a short sample call</h1>
        <ol className="ob-tasks">
          {tasks.map((t) => (
            <li key={t.id} className={done[t.id] ? 'done' : t === current ? 'current' : ''} aria-current={t === current ? 'step' : undefined}>
              <span className="mark">{done[t.id] ? <Icon name="checkCircle" size={20} /> : <i />}</span>
              <span><b>{t.title}</b><small>{t.sub}</small></span>
            </li>
          ))}
        </ol>
      </div>
      <SampleCall live={!!s.session && s.session.id === session.current} askKey={k('ask')} />
      <div className="ob-foot tryit-foot">
        <button className="ob-back" onClick={onDone}>Skip practice</button>
        <span className="grow" />
        <button className={`ob-primary ${all ? '' : 'waiting'}`} onClick={onDone}>Finish</button>
      </div>
    </div>
  )
}

/** Jordan's side of the call, spoken through the speakers once the practice session starts, with a running clock. */
function SampleCall({ live, askKey }: { live: boolean; askKey: string }) {
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [, rerender] = useState(0)
  useEffect(() => {
    if (!live || startedAt) return
    const t0 = Date.now()
    setStartedAt(t0)
    const timers = SAMPLE_CALL.map((line, i) => setTimeout(() => void glint.invoke('practice:say', i), line.at * 1000))
    const clock = setInterval(() => (rerender((n) => n + 1), Date.now() - t0 > SAMPLE_CALL_S * 1000 && clearInterval(clock)), 250)
    return () => (timers.forEach(clearTimeout), clearInterval(clock), glint.send('practice:stop'))
  }, [live])
  const t = startedAt ? Math.min(SAMPLE_CALL_S, (Date.now() - startedAt) / 1000) : 0
  const said = SAMPLE_CALL.filter((l) => t >= l.at)
  return (
    <aside className="sample">
      <b className="sample-head">Sample call · {formatElapsed(t * 1000)} / {formatElapsed(SAMPLE_CALL_S * 1000)}</b>
      <span className="track"><i style={{ width: `${(t / SAMPLE_CALL_S) * 100}%` }} /></span>
      <div className="sample-lines">
        {!startedAt && <p className="muted">Starts when you start the session.</p>}
        {said.map((l) => <p key={l.at}><b>Jordan</b>{'  '}{l.text}</p>)}
      </div>
      {said.length > 0 && <p className="sample-cue">That's a question. Press <b>{askKey}</b> now.</p>}
    </aside>
  )
}
