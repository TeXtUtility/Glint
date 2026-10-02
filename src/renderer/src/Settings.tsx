import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { HUMANIZER_LABELS, HUMANIZER_OPTIONS, HUMANIZERS, type HumanizerCustom, type HumanizerService } from '../../shared/humanize'
import { MODE_TEMPLATES } from '../../shared/prompt'
import { PROVIDER_LABELS } from '../../shared/providers'
import {
  AI_PROVIDERS, clashesWithEditing, CORNERS, DEFAULT_SHORTCUTS, GLANCE_COOLDOWN_RANGE, isDivider, isNewer, isSystemShortcut, NOTE_MAX, PERSISTED_DEFAULTS, prettyAccelerator, TERMINAL_APPS, toAccelerator, LOCAL_WHISPER_MODELS,
  OPACITY_DEFAULTS, OPACITY_RANGES, searchesFiles, VAD_DEFAULTS, VAD_RANGES, VOICE_DEFAULTS, VOICE_RANGES,
  type AiProvider, type AutoCopy, type CapsuleItem, type Corner, type KeyProvider, type VoiceSettings, type LocalWhisper, type Mode, type ModeFile, type OpacitySettings, type ShortcutAction, type State, type TerminalApp, type VadSettings,
} from '../../shared/state'
import notes from '../../../CHANGELOG.md?raw'
import { CapsuleItemView, languageOptions } from './ControlBar'
import { glint, isMac, patch, useAppState } from './glint'
import { Icon } from './icons'
import { MIC_CONSTRAINTS, startRecording, usePlayback, type Recording } from './mic'
import { ConfirmButton, DraftTextarea, Segmented } from './ui'

declare const __GLINT_COMMIT__: string // electron.vite.config.ts

const PAGES = {
  general: ['General', 'gear'], overlay: ['Overlay', 'tune'], ai: ['AI', 'logo'], voice: ['Voice', 'wave'], modes: ['Modes', 'layers'],
  shortcuts: ['Shortcuts', 'keyboard'], developer: ['Developer', 'code'], about: ['About', 'info'],
} as const
type Page = keyof typeof PAGES

const LABELS: Record<ShortcutAction, string> = {
  toggleOverlay: 'Show or hide overlay',
  toggleSession: 'Start or end session',
  togglePause: 'Pause session',
  toggleInvisible: 'Invisible mode',
  ask: 'Ask',
  openSettings: 'Settings',
  moveUp: 'Move overlay up',
  moveDown: 'Move overlay down',
  moveLeft: 'Move overlay left',
  moveRight: 'Move overlay right',
  scrollUp: 'Scroll chat up',
  scrollDown: 'Scroll chat down',
  toggleDiscreet: 'Discreet mode',
  toggleGlance: 'Glance',
  toggleGhost: 'Ghost',
  ghostAsk: 'Ghost: ask about the screen',
  ghostPrompt: 'Ghost: type a question',
  ghostPrev: 'Ghost: earlier answer',
  ghostNext: 'Ghost: later answer',
  ghostBack: 'Ghost: back a word',
  ghostSkip: 'Ghost: skip a word',
  ghostHide: 'Ghost: hide or show (or double-tap ⌃)',
  ghostFadeIn: 'Ghost: less faded',
  ghostFadeOut: 'Ghost: more faded',
  ghostBigger: 'Ghost: bigger text',
  ghostSmaller: 'Ghost: smaller text',
  ghostCorner: 'Ghost: back to its corner',
}

function initialPage(): Page {
  const asked = new URLSearchParams(location.hash.split('?')[1]).get('page') // opened on a page, e.g. by a glint:// link
  if (asked && asked in PAGES) return asked as Page
  try {
    const p = localStorage.getItem('settings.page')
    if (p && p in PAGES) return p as Page
  } catch {}
  return 'general'
}

export function Settings() {
  const s = useAppState()
  const [chosen, setPage] = useState<Page>(initialPage)
  useEffect(() => {
    try {
      localStorage.setItem('settings.page', chosen)
    } catch {}
  }, [chosen])
  // Main asks for a page when Settings is already open (a glint:// link, "Manage modes").
  useEffect(() => glint.on('settings:page', (p: string) => p in PAGES && setPage(p as Page)), [])
  if (!s) return null
  // The Developer page exists only with developer tools on (About).
  const pages = (Object.keys(PAGES) as Page[]).filter((p) => p !== 'developer' || s.devTools)
  const page = pages.includes(chosen) ? chosen : 'general'

  return (
    <div className="settings">
      <nav aria-label="Settings pages">
        {pages.map((p) => (
          <button key={p} aria-current={p === page ? 'page' : undefined} onClick={() => setPage(p)}>
            <Icon name={PAGES[p][1]} />{PAGES[p][0]}
            {p === 'general' && s.update.status === 'available' && <i className="nav-dot" aria-label="update available" />}
          </button>
        ))}
      </nav>
      <main>
        {/* Keyed by page: a page change crossfades, with nothing sliding. */}
        <div className="page" key={page}>
          {page !== 'developer' && page !== 'modes' && <h1>{PAGES[page][0]}</h1>}
          {page === 'general' && <General s={s} onReleaseNotes={() => setPage('about')} />}
          {page === 'overlay' && <Overlay s={s} />}
          {page === 'ai' && <Ai s={s} />}
          {page === 'voice' && <Voice s={s} />}
          {page === 'modes' && <Modes s={s} />}
          {page === 'shortcuts' && <Shortcuts s={s} />}
          {page === 'developer' && <Developer s={s} />}
          {page === 'about' && <About s={s} />}
        </div>
      </main>
    </div>
  )
}

// Building blocks: a labelled row with its hint on the left and the control on the right, and section labels.

function Row({ label, hint, children, as = 'div', blank }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; as?: 'div' | 'label'; blank?: boolean }) {
  const Tag = as
  return (
    <Tag className={`row ${blank ? 'blank' : ''}`}>
      <span className="row-text">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {children && <span className="row-control">{children}</span>}
    </Tag>
  )
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="group">
      <h2><span>{title}</span>{aside}</h2>
      {children}
    </section>
  )
}

function Toggle({ label, hint, checked, disabled, onChange }: {
  label: ReactNode; hint?: ReactNode; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void
}) {
  return (
    <Row as="label" label={label} hint={hint}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </Row>
  )
}

function Slider({ label, hint, range: [min, max, step], value, fallback, format = String, onChange }: {
  label: string; hint?: string; range: [number, number, number]; value: number; fallback: number
  format?: (v: number) => string; onChange: (v: number) => void
}) {
  return (
    <Row as="label" label={label} hint={hint && `${hint}${value !== fallback ? ` Default: ${format(fallback)}.` : ''}`}>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={fill(value, min, max)} />
      <output className="num">{format(value)}</output>
      <button className="reset" data-tip={`Reset to ${format(fallback)}`} aria-label={`Reset ${label}`} disabled={value === fallback}
        onClick={(e) => (e.preventDefault(), onChange(fallback))}>↺</button>
    </Row>
  )
}

// General

function General({ s, onReleaseNotes }: { s: State; onReleaseNotes: () => void }) {
  const key = (a: ShortcutAction) => (s.shortcuts[a] ? prettyAccelerator(s.shortcuts[a], isMac) : '')
  const g = s.glance
  const opacityDefault = (Object.keys(OPACITY_DEFAULTS) as (keyof OpacitySettings)[]).every((k) => s.opacity[k] === OPACITY_DEFAULTS[k])
  return (
    <>
      <UpdateBanner s={s} onReleaseNotes={onReleaseNotes} />

      <Section title="Overlay">
        <Toggle label="Compact capsule" hint="Only the dot, the chat box, Ask and Meeting options. Everything else moves to a row at the top of the chat panel."
          checked={s.compactBar} onChange={(v) => patch({ compactBar: v })} />
        <Row label="Layout" hint={`${key('toggleGlance') ? `${key('toggleGlance')} for Glance · ` : ''}also in Meeting options`}>
          <Segmented<State['layout']> label="Layout" value={s.layout} onChange={(layout) => patch({ layout })}
            options={[
              { value: 'full', label: 'Full', tip: 'The capsule, with the chat panel under it' },
              { value: 'glance', label: 'Glance', tip: 'A dot in a corner with one-line answers' },
              { value: 'ghost', label: 'Ghost', tip: 'An answer to type out by hand, a few letters at a time' },
            ]} />
        </Row>
        <Row label="Glance corner" hint="Where Glance and Ghost sit, 12 pt in from the edge">
          <CornerPicker value={g.corner} onChange={(corner) => patch({ glance: { corner } })} />
        </Row>
        {s.layout === 'ghost' && (
          <Row label="Follow my typing"
            hint="Ghost moves along as you type the answer in any app, so macOS asks to let Glint see keystrokes (Input Monitoring). Keys only move the strip: they're never saved or sent anywhere, and password fields are never seen.">
            {s.keysAllowed ? <span className="muted">Allowed</span> : <button onClick={() => glint.send('keys:request')}>Allow</button>}
          </Row>
        )}
        <Toggle label="Offer to take notes when a call starts"
          hint="When Zoom, Teams, Webex, FaceTime, Slack or a Meet, Teams or Zoom tab starts using your mic, a small prompt under the capsule offers to start a session. Glint sees which app uses the mic, never the audio."
          checked={s.meetingPrompt} onChange={(v) => patch({ meetingPrompt: v })} />
        <Toggle label="Ghost skips ahead when you go off script"
          hint={`Skip, swap or add a word, or click into the next field, and Ghost jumps to where you are. Off, it only moves on the right key${
            s.shortcuts.ghostBack || s.shortcuts.ghostSkip ? `, and ${[s.shortcuts.ghostBack, s.shortcuts.ghostSkip].filter(Boolean).map((a) => prettyAccelerator(a, isMac)).join(' and ')} move a word at a time` : ''}.`}
          checked={s.ghostAutoSkip} onChange={(v) => patch({ ghostAutoSkip: v })} />
        <Toggle label="Glance answers questions automatically" hint="One-line answers when someone else asks something. No screenshot is taken."
          checked={g.autoAnswer} disabled={s.layout !== 'glance'} onChange={(v) => patch({ glance: { autoAnswer: v } })} />
        <Slider label="Time between automatic answers" hint="At least this long between two answers." range={GLANCE_COOLDOWN_RANGE}
          value={g.cooldownS} fallback={PERSISTED_DEFAULTS.glance.cooldownS} format={(v) => `${v} s`} onChange={(v) => patch({ glance: { cooldownS: v } })} />
        <Toggle label="Invisible mode" checked={s.isInvisible} onChange={(v) => patch({ isInvisible: v })}
          hint="Hides Glint from screen sharing and recordings. It doesn't hide Glint's processes, permissions or audio capture from other software, and anyone looking at your screen can still see it." />
        <Toggle label="Keep focus in other apps while invisible" hint="Typing in Glint never steals focus from the shared window. The chat box can't be typed in while this is on."
          checked={s.lockFocusWhenInvisible} onChange={(v) => patch({ lockFocusWhenInvisible: v })} />
        <Toggle label="Discreet overlay" hint="For meetings in person: the controls fade to grey, nothing moves or lights up, and answers stay sharp, a sentence at a time. Pointing at it doesn't bring it back. Also in Meeting options." checked={s.discreet} onChange={(v) => patch({ discreet: v })} />
      </Section>

      <Section title="Asking">
        <Toggle label="Include a screenshot" hint="Each ask sends what's on your screen. Also the screen button on the capsule."
          checked={s.screenContext === 'on'} onChange={(v) => patch({ screenContext: v ? 'on' : 'off' })} />
        <div className="row stacked">
          <span className="row-text">
            Note on screenshots
            <small>Drawn on every screenshot sent to the AI, after it's taken, so it never appears on your screen. A mode can add its own under it.</small>
          </span>
          <DraftTextarea value={s.screenshotNote.text} rows={3} maxLength={NOTE_MAX}
            placeholder="e.g. I'm reviewing this pull request. Point out bugs first, then style."
            onSave={(text) => patch({ screenshotNote: { text } })} />
        </div>
        <Row label="Note position" hint="Where the screenshot note is drawn">
          <Segmented label="Note position" value={s.screenshotNote.position} onChange={(position) => patch({ screenshotNote: { position } })}
            options={[{ value: 'top', label: 'Above' }, { value: 'bottom', label: 'Below' }]} />
        </Row>
        <Row label="Copy replies automatically" hint="Each finished reply goes on the clipboard, ready to paste. Glance's automatic answers never do.">
          <Segmented<AutoCopy> label="Copy replies automatically" value={s.autoCopy} onChange={(autoCopy) => patch({ autoCopy })}
            options={[{ value: 'off', label: 'Off' }, { value: 'reply', label: 'Reply' }, { value: 'code', label: 'Code', tip: 'Only the first code block' }]} />
        </Row>
        <TerminalRow s={s} />
      </Section>

      <Section title="Opacity" aside={<button className="link" disabled={opacityDefault} onClick={() => patch({ opacity: OPACITY_DEFAULTS })}>Restore defaults</button>}>
        <div className="opacity-grid">
          {(Object.keys(OPACITY_LABELS) as (keyof OpacitySettings)[]).map((k) => {
            const [min, max, step] = OPACITY_RANGES[k]
            return (
              <Fragment key={k}>
                <label htmlFor={`opacity-${k}`} data-tip={OPACITY_LABELS[k][1]}>{OPACITY_LABELS[k][0]}</label>
                <input id={`opacity-${k}`} type="range" min={min} max={max} step={step} value={s.opacity[k]} style={fill(s.opacity[k], min, max)}
                  onChange={(e) => patch({ opacity: { [k]: Number(e.target.value) } })} />
                <output>{percent(s.opacity[k])}</output>
              </Fragment>
            )
          })}
        </div>
      </Section>

      <Section title="Mac">
        <Row label="Theme" hint="For Settings; the overlay is always dark">
          <Segmented<State['theme']> label="Theme" value={s.theme} onChange={(theme) => patch({ theme })}
            options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        </Row>
        <Toggle label="Open at login" checked={s.openAtLogin} onChange={(v) => patch({ openAtLogin: v })} />
        <MicTest />
        <Updates s={s} />
      </Section>

      <div className="footer-actions">
        <button data-tip="Go through permissions and the practice steps again" onClick={() => patch({ onboardingDone: false })}>Redo onboarding</button>
        <button data-tip="Quit and reopen Glint" onClick={() => glint.send('app:relaunch')}>Restart Glint</button>
        <button data-tip="Close Glint completely, ending any session" onClick={() => glint.send('app:quit')}>Quit Glint</button>
        <span className="grow" />
        <ConfirmButton label="Hold to reset all settings" confirmLabel="Reset and restart" onConfirm={() => glint.send('app:reset')} />
      </div>
    </>
  )
}

/** Where a command block's Run opens: the terminals this Mac has. */
function TerminalRow({ s }: { s: State }) {
  const [have, setHave] = useState<TerminalApp[] | null>(null)
  useEffect(() => void glint.invoke<TerminalApp[]>('run:terminals').then(setHave), [])
  const options = TERMINAL_APPS.filter((a) => a === 'auto' || a === s.terminalApp || have?.includes(a))
  return (
    <>
      <Row as="label" label="Run commands in" hint="A command block's Run types it into a window of this terminal that isn't busy, and asks y/N before running anything. Automatic uses a terminal that's already open.">
        <select value={s.terminalApp} onChange={(e) => patch({ terminalApp: e.target.value as TerminalApp })}>
          {options.map((a) => <option key={a} value={a}>{a === 'auto' ? 'Automatic' : a}</option>)}
        </select>
      </Row>
      <Toggle label="Open a new window every time" hint="Off: iTerm and Terminal use an open window that isn't busy, and open one only when there's none. Other terminals always open a new window."
        checked={s.runNewWindow} onChange={(v) => patch({ runNewWindow: v })} />
    </>
  )
}

const OPACITY_LABELS: Record<keyof OpacitySettings, [string, string]> = {
  overlay: ['Whole overlay', 'The capsule and panel, text included.'],
  background: ['Background glass', 'Lower lets more of your screen show through.'],
  idle: ['Discreet fade', 'How visible the controls and the frosted glass stay in discreet mode. Answers stay fully visible.'],
}
const percent = (v: number) => `${Math.round(v * 100)}%`

const CORNER_LABELS: Record<Corner, string> = { 'top-left': 'Top left', 'top-right': 'Top right', 'bottom-left': 'Bottom left', 'bottom-right': 'Bottom right' }

/** A little screen with a spot in each corner. */
function CornerPicker({ value, onChange }: { value: Corner; onChange: (c: Corner) => void }) {
  return (
    <span className="corner-picker" role="radiogroup" aria-label="Corner">
      {CORNERS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={c === value} aria-label={CORNER_LABELS[c]} data-tip={CORNER_LABELS[c]}
          className={c} onClick={() => onChange(c)} />
      ))}
    </span>
  )
}

/** An update waiting gets a banner at the top; otherwise the version and a check sit under Mac. */
function UpdateBanner({ s, onReleaseNotes }: { s: State; onReleaseNotes: () => void }) {
  const u = s.update
  const retry = u.status === 'failed' && !!u.version
  if (u.status !== 'available' && u.status !== 'queued' && u.status !== 'installing' && u.status !== 'ready' && !retry) return null
  const text = {
    available: `Updating downloads and builds it, then restarts Glint. It takes a minute or two${s.session ? ', and waits for this session to end so it doesn\'t slow the call' : ''}.`,
    queued: 'It starts building when this session ends, then restarts Glint.',
    installing: "Building it now. Glint restarts when it's done, or when your session ends if one is running.",
    ready: 'Glint restarts with it when this session ends.',
    failed: `The last try failed: ${u.message}`,
  }[u.status as 'available' | 'queued' | 'installing' | 'ready' | 'failed']
  const name = updateName(s)
  const back = u.channel === 'stable' && !isNewer(u.version ?? '', s.appVersion) // leaving the beta for main
  return (
    <div className={`update-banner ${u.status === 'failed' ? 'failed' : ''}`} role="status">
      <span className="row-text">
        <b>{u.status === 'ready' ? `Glint ${name} is ready` : u.status === 'installing' ? `Building Glint ${name}…` : u.status === 'queued' ? `Glint ${name} installs after this session` : back ? `Back to stable: Glint ${name}` : `Glint ${name} is out`}</b>
        <small>{text}</small>
        {!!u.commits?.length && <ul className="update-commits">{u.commits.map((c, i) => <li key={i}>{c}</li>)}</ul>}
      </span>
      {u.channel !== 'beta' && <button className="text" onClick={onReleaseNotes}>Release notes</button>}
      {(u.status === 'available' || retry) && (
        <button className="primary" onClick={() => glint.send('update:install')}>
          {`${retry ? 'Try again' : 'Install update'}${s.session ? ' after this session' : ''}`}
        </button>
      )}
      {u.status === 'queued' && <button onClick={() => glint.send('update:cancel')}>Cancel</button>}
    </div>
  )
}

/** A beta build is named by its commit; a release by its version. */
const updateName = (s: State) => (s.update.channel === 'beta' ? `beta ${s.update.version}` : s.update.version)

function Updates({ s }: { s: State }) {
  const u = s.update
  const hint = {
    idle: `Glint checks GitHub for ${s.updateChannel === 'beta' ? 'new beta builds' : 'a new version'} every hour.`,
    checking: 'Checking…',
    current: "You're on the latest version.",
    available: `Glint ${updateName(s)} is out: see the top of this page.`,
    queued: 'Installing when this session ends.',
    installing: 'Updating…',
    ready: 'Updating when this session ends.',
    failed: <span className="error">Update failed: {u.message}</span>,
  }[u.status]
  return (
    <>
      <Row label="Update channel" hint={s.updateChannel === 'beta'
        ? 'Builds from the beta branch: the newest work, before it\'s released. It can break.'
        : 'Releases from the main branch.'}>
        <Segmented<State['updateChannel']> label="Update channel" value={s.updateChannel} onChange={(updateChannel) => patch({ updateChannel })}
          options={[{ value: 'stable', label: 'Stable' }, { value: 'beta', label: 'Beta' }]} />
      </Row>
      <Row label={`Updates · Glint ${s.appVersion}`} hint={hint}>
        <button disabled={u.status === 'checking' || u.status === 'queued' || u.status === 'installing' || u.status === 'ready'} onClick={() => glint.send('update:check')}>Check now</button>
      </Row>
    </>
  )
}

function MicTest() {
  const [level, setLevel] = useState<number | null>(null)
  const [device, setDevice] = useState('')
  const [error, setError] = useState('')
  const on = level !== null
  useEffect(() => {
    if (!on) return
    let cancelled = false
    let raf = 0
    let stream: MediaStream | undefined
    let ctx: AudioContext | undefined
    navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS }).then((st) => {
      if (cancelled) return st.getTracks().forEach((t) => t.stop())
      stream = st
      setDevice(st.getAudioTracks()[0]?.label ?? '')
      ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      ctx.createMediaStreamSource(st).connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      const tick = () => {
        analyser.getFloatTimeDomainData(buf)
        let peak = 0
        for (const v of buf) peak = Math.max(peak, Math.abs(v))
        setLevel(Math.sqrt(peak)) // sqrt: normal speech lands mid-meter instead of near the bottom
        raf = requestAnimationFrame(tick)
      }
      tick()
    }, (err: Error) => {
      if (cancelled) return
      setError(err.message)
      setLevel(null)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
    }
  }, [on])

  return (
    <Row label="Microphone test"
      hint={error ? <span className="error">{error}</span> : on ? (device || 'Listening…') : 'Check that Glint hears you before a call.'}>
      {on && (
        <span className="meter" aria-label="Microphone level" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level ?? 0}>
          {METER_BARS.map((h, i) => <i key={i} className={i < Math.round((level ?? 0) * METER_BARS.length) ? 'on' : ''} style={{ height: h }} />)}
        </span>
      )}
      <button onClick={() => (setError(''), setLevel(on ? null : 0))}>{on ? 'Stop test' : 'Test'}</button>
    </Row>
  )
}

const METER_BARS = [6, 10, 14, 9, 5, 5]

// AI

const CONSOLES: Record<KeyProvider, string> = { anthropic: 'https://console.anthropic.com/settings/keys', openai: 'https://platform.openai.com/api-keys' }
const isCli = (p: AiProvider) => p === 'claude-cli' || p === 'codex-cli'

/** Every provider in the order Glint tries them: the chosen one, its fallbacks in order, then the rest. */
function providerList(ai: State['ai']): AiProvider[] {
  const first = [ai.provider, ...ai.fallbacks.filter((p) => p !== ai.provider)]
  return [...first, ...AI_PROVIDERS.filter((p) => !first.includes(p))]
}

const ITEM_NAMES: Record<CapsuleItem, string> = {
  activity: 'Voice activity', mode: 'Mode', screen: 'Screen context', humanize: 'Humanizer', invisible: 'Invisible mode', room: 'Room mode', labels: 'Speaker labels',
  session: 'Session controls', chat: 'Chat box', ask: 'Ask', 'divider-1': 'Divider', 'divider-2': 'Divider', 'divider-3': 'Divider', 'divider-4': 'Divider',
}

/** The capsule's controls in two wells, as Ice arranges the menu bar: drag one to the other well to hide or show it. */
function Overlay({ s }: { s: State }) {
  const [drag, setDrag] = useState<CapsuleItem | null>(null)
  const [over, setOver] = useState<{ hidden: boolean; at: number } | null>(null)
  const [said, setSaid] = useState('')
  const refocus = useRef<CapsuleItem | null>(null)
  // A keyboard move to the other well remounts the item, so focus follows it there.
  useEffect(() => {
    if (refocus.current) document.querySelector<HTMLElement>(`[data-item="${refocus.current}"]`)?.focus()
    refocus.current = null
  })
  const place = (id: CapsuleItem, hidden: boolean, at: number) => {
    const lists = [s.capsule.shown.filter((x) => x !== id), s.capsule.hidden.filter((x) => x !== id)]
    lists[+hidden].splice(Math.max(0, at), 0, id)
    return { shown: lists[0], hidden: lists[1] }
  }
  const move = (id: CapsuleItem, hidden: boolean, at: number) => {
    const next = place(id, hidden, at)
    void patch({ capsule: next })
    setSaid(`${ITEM_NAMES[id]} moved to ${hidden ? 'Meeting options' : 'the overlay'}, position ${(hidden ? next.hidden : next.shown).indexOf(id) + 1}`)
  }
  const end = () => (setDrag(null), setOver(null))
  // While dragging, the wells show where the item would land, so the others make room.
  const { shown, hidden } = drag && over ? place(drag, over.hidden, over.at) : s.capsule
  // Drawn idle, as the capsule looks between calls.
  const idle: State = { ...s, session: null, chat: { ...s.chat, isStreaming: false, visible: false }, teach: null, namePrompt: null }
  const isDefault = JSON.stringify(s.capsule) === JSON.stringify(PERSISTED_DEFAULTS.capsule)

  const well = (isHidden: boolean, ids: CapsuleItem[]) => (
    <div className="capsule-well" role="list" aria-label={isHidden ? 'In Meeting options' : 'Shown on the overlay'}
      onDragOver={(e) => {
        if (!drag) return
        e.preventDefault()
        if (e.target === e.currentTarget) setOver({ hidden: isHidden, at: ids.filter((x) => x !== drag).length })
      }}
      onDrop={(e) => (e.preventDefault(), drag && over && move(drag, over.hidden, over.at), end())}>
      {!isHidden && <span className="well-item locked" data-tip="Always shown"><span inert><span className="logo"><i /></span><span className="cap-label">Ready</span></span></span>}
      {ids.map((id, i) => (
        <span key={id} role="listitem" data-item={id} tabIndex={0} draggable
          data-tip={id === 'humanize' && s.humanizer.service === 'none' ? 'Humanizer: shows once a service is connected in Settings → AI' : ITEM_NAMES[id]}
          aria-label={`${ITEM_NAMES[id]}: left and right arrows reorder, ${isHidden ? 'up arrow shows it on the overlay' : 'down arrow moves it to Meeting options'}`}
          className={`well-item ${isDivider(id) ? 'div' : ''} ${drag === id ? 'dragging' : ''}`}
          onDragStart={(e) => (setDrag(id), e.dataTransfer.setData('text/plain', id), (e.dataTransfer.effectAllowed = 'move'))}
          onDragEnd={end}
          onDragOver={(e) => {
            if (!drag) return
            e.preventDefault()
            e.stopPropagation()
            if (over?.hidden !== isHidden || over.at !== i) setOver({ hidden: isHidden, at: i })
          }}
          onKeyDown={(e) => {
            const to: [boolean, number] | null = e.key === 'ArrowLeft' && i > 0 ? [isHidden, i - 1]
              : e.key === 'ArrowRight' && i < ids.length - 1 ? [isHidden, i + 1]
              : (e.key === 'ArrowDown' && !isHidden) || (e.key === 'ArrowUp' && isHidden) ? [!isHidden, i]
              : null
            if (!to) return
            e.preventDefault()
            refocus.current = id
            move(id, ...to)
          }}>
          <span inert><CapsuleItemView id={id} c={{ s: idle, preview: true }} /></span>
        </span>
      ))}
      {!isHidden && <span className="well-item locked end" data-tip="Always shown: it holds the hidden controls"><span inert><span className="circle tune"><Icon name="tune" /></span></span></span>}
      {isHidden && !ids.length && <span className="well-empty">Drag controls here to tuck them into Meeting options</span>}
    </div>
  )

  return (
    <>
      <p className="well-tip"><Icon name="bulb" size={14} />Hidden controls wait under Meeting options on the overlay, and keep their shortcuts.</p>
      <Section title="Shown on the overlay">{well(false, shown)}</Section>
      <Section title="In Meeting options">{well(true, hidden)}</Section>
      <p className="note">Drag to rearrange, or focus a control and use the arrow keys. Logo, status and Meeting options always show.</p>
      <div className="footer-actions">
        <button disabled={isDefault} onClick={() => (patch({ capsule: PERSISTED_DEFAULTS.capsule }), setSaid('Default layout restored'))}>Restore default</button>
      </div>
      <p className="visually-hidden" aria-live="polite">{said}</p>
    </>
  )
}

function Ai({ s }: { s: State }) {
  const { ai } = s
  const setAi = (p: Partial<State['ai']>) => patch({ ai: p })
  const list = providerList(ai)
  const ticked = new Set(ai.fallbacks)
  const [drag, setDrag] = useState<AiProvider | null>(null)
  const [over, setOver] = useState<number | null>(null)

  /** Saves a new order: the top one answers first; below it, the ticked ones are the fallbacks, in this order. */
  const commit = (next: AiProvider[], keep = ticked) => {
    const first = next[0]
    const tickedNext = new Set(keep)
    if (first !== ai.provider) tickedNext.add(ai.provider) // the old first stays in the chain, just lower
    tickedNext.delete(first)
    // A CLI model name means nothing to the other CLI, or to an API.
    setAi({ provider: first, fallbacks: next.slice(1).filter((p) => tickedNext.has(p)), ...(first !== ai.provider ? { cliModel: '', cliSmartModel: '' } : {}) })
  }
  const move = (p: AiProvider, to: number) => {
    if (list[to] === p) return // dropped where it was
    const next = list.filter((x) => x !== p)
    const at = Math.max(0, Math.min(to, next.length))
    next.splice(at, 0, p)
    // Moved in among the ones in use (the first and the ticked ones): it's in use too. Otherwise it would snap back to
    // the unused rows, since only the chain's order is saved.
    const chain = 1 + ai.fallbacks.filter((x) => x !== p && x !== ai.provider).length
    commit(next, ticked.has(p) || at > chain ? ticked : new Set([...ticked, p]))
  }
  const tick = (p: AiProvider, on: boolean) => {
    const keep = new Set(ticked)
    if (on) keep.add(p)
    else keep.delete(p)
    commit(list, keep)
  }
  let fallbackN = 0
  // While dragging, the list shows where the row would land, so the others make room.
  const shown = drag && over !== null ? list.filter((x) => x !== drag).toSpliced(over, 0, drag) : list

  return (
    <>
      <Section title="Providers · drag to set fallback order">
        <ul className="providers" onDragEnd={() => (setDrag(null), setOver(null))}>
          {shown.map((p, i) => {
            const first = i === 0
            const on = first || ticked.has(p)
            if (!first && on) fallbackN++
            return (
              <li key={p} className={`provider ${drag === p ? 'dragging' : ''} ${on ? '' : 'off'}`}
                draggable onDragStart={(e) => (setDrag(p), e.dataTransfer.setData('text/plain', p), (e.dataTransfer.effectAllowed = 'move'))}
                onDragOver={(e) => (e.preventDefault(), over !== i && setOver(i))} onDrop={(e) => (e.preventDefault(), drag && move(drag, over ?? i), setDrag(null), setOver(null))}>
                <button className="grip" aria-label={`Move ${PROVIDER_LABELS[p]}: arrow up or down`} data-tip="Drag, or use the arrow keys"
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowUp' && i > 0) (e.preventDefault(), move(p, i - 1))
                    if (e.key === 'ArrowDown' && i < list.length - 1) (e.preventDefault(), move(p, i + 1))
                  }}>
                  <Icon name="grip" />
                </button>
                {first ? <input type="checkbox" checked disabled aria-label={`${PROVIDER_LABELS[p]} answers first`} />
                  : <input type="checkbox" checked={on} aria-label={`Use ${PROVIDER_LABELS[p]} as a fallback`} onChange={(e) => tick(p, e.target.checked)} />}
                <span className="pname">{PROVIDER_LABELS[p]}{(first || on) && <span className={`order ${first ? 'first' : ''}`}>{first ? 'answers first' : `fallback ${fallbackN}`}</span>}</span>
                <ProviderStatus s={s} provider={p} />
              </li>
            )
          })}
        </ul>
        <p className="note">
          A provider that hasn't started answering within 15 s (longer for smart mode, Codex and large reference files) counts as failed, and the
          next ticked one answers. The panel shows in red what failed and who answered instead.
          {s.aiFailure && <span className="error"> Last failure: {s.aiFailure}</span>}
        </p>
      </Section>

      <Section title="Models">
        <div className="models" role="table" aria-label="Models">
          <div role="row" className="models-head">
            <span role="columnheader" />
            <span role="columnheader"><Icon name="bolt" size={13} />Fast</span>
            <span role="columnheader"><Icon name="bulb" size={13} filled />Smart</span>
          </div>
          <div role="row">
            <span role="rowheader">Claude API</span>
            <ModelField value={ai.anthropicModel} fallback={PERSISTED_DEFAULTS.ai.anthropicModel} label="Claude API fast model" onSave={(m) => setAi({ anthropicModel: m })} />
            <ModelField value={ai.anthropicSmartModel} fallback={PERSISTED_DEFAULTS.ai.anthropicSmartModel} label="Claude API smart model" onSave={(m) => setAi({ anthropicSmartModel: m })} />
          </div>
          <div role="row">
            <span role="rowheader">OpenAI API</span>
            <ModelField value={ai.openaiModel} fallback={PERSISTED_DEFAULTS.ai.openaiModel} label="OpenAI fast model" onSave={(m) => setAi({ openaiModel: m })} />
            <ModelField value={ai.openaiSmartModel} fallback={PERSISTED_DEFAULTS.ai.openaiSmartModel} label="OpenAI smart model" onSave={(m) => setAi({ openaiSmartModel: m })} />
          </div>
          <div role="row">
            <span role="rowheader">
              {isCli(ai.provider) ? PROVIDER_LABELS[ai.provider] : 'Claude Code · Codex'}
              <small>{isCli(ai.provider) ? 'Blank: the CLI default' : 'When a CLI answers first'}</small>
            </span>
            <ModelField value={ai.cliModel} fallback="" disabled={!isCli(ai.provider)} label="CLI fast model"
              placeholder={ai.provider === 'claude-cli' ? 'sonnet' : 'From the CLI'} onSave={(m) => setAi({ cliModel: m })} />
            <ModelField value={ai.cliSmartModel} fallback="" disabled={!isCli(ai.provider)} label="CLI smart model"
              placeholder={ai.provider === 'claude-cli' ? 'opus' : 'From the CLI'} onSave={(m) => setAi({ cliSmartModel: m })} />
          </div>
        </div>
        <Toggle label="Smart mode" hint="The same switch as the bulb by Send. Thinks it through; slower to start. Glance stays fast." checked={s.smart} onChange={(v) => patch({ smart: v })} />
        <Toggle label="Think before fast answers" hint="More careful on hard questions, slower to start. Smart mode always thinks."
          checked={ai.fastThinking} onChange={(v) => setAi({ fastThinking: v })} />
      </Section>

      <Transcription s={s} />
      <Humanize s={s} />
    </>
  )
}

/** Rewriting answers with a humanizer service before they're shown. */
function Humanize({ s }: { s: State }) {
  const h = s.humanizer
  const [connecting, setConnecting] = useState(false)
  const acct = s.humanizerAccount
  const setApply = (p: Partial<State['humanizer']['apply']>) => patch({ humanizer: { apply: { ...h.apply, ...p } } }) // replaced whole
  const title = <span className="hz-title"><Icon name="person" size={14} />Humanize answers</span>
  if (connecting || h.service === 'none') {
    return (
      <Section title="Humanize answers">
        {connecting ? <HumanizerConnect s={s} onClose={() => setConnecting(false)} /> : (
          <Row label={title} hint="Rewrite answers with a humanizer service before showing them. You bring the account and key.">
            <button onClick={() => setConnecting(true)}>Connect a service</button>
          </Row>
        )}
      </Section>
    )
  }
  const label = HUMANIZER_LABELS[h.service]
  const account = [label, acct?.plan, acct?.wordsLeft !== undefined && `${acct.wordsLeft.toLocaleString()} words left`, acct?.maxPerCall && `${acct.maxPerCall.toLocaleString()} per call`]
  return (
    <Section title="Humanize answers">
      <Row label={<span className="hz-title"><Icon name="person" size={14} />{account.filter(Boolean).join(' · ')}</span>} hint="Key saved, encrypted with your keychain.">
        <button className="text" onClick={() => setConnecting(true)}>Change</button>
        <ConfirmButton quiet label="Disconnect" confirmLabel="Hold to disconnect" onConfirm={() => void glint.invoke('humanizer:disconnect')} />
      </Row>
      <Toggle label="Rewrite answers before showing them" hint="Answers take longer: the model writes, then the service rewrites."
        checked={h.on} onChange={(on) => patch({ humanizer: { on } })} />
      <Row label="Apply to" hint="Glance lines are usually under the service's minimum, and a rewrite slows them down.">
        <span className="checks">
          <label><input type="checkbox" checked={h.apply.chat} disabled={!h.on} onChange={(e) => setApply({ chat: e.target.checked })} />Chat answers</label>
          <label><input type="checkbox" checked={h.apply.email} disabled={!h.on} onChange={(e) => setApply({ email: e.target.checked })} />Follow-up emails</label>
          <label><input type="checkbox" checked={h.apply.glance} disabled={!h.on} onChange={(e) => setApply({ glance: e.target.checked })} />Glance</label>
        </span>
      </Row>
      <Toggle label="Always humanize in Ghost" hint="Asking about your screen in Ghost is always humanized while a service is connected, whatever the switch says."
        checked={h.ghost} onChange={(ghost) => patch({ humanizer: { ghost } })} />
      <p className="note">
        Rewritten answers are sent to {label} and billed by it per word. Only the answer is sent: never the transcript, the screenshot or your
        question. Code, maths and links stay in Glint. Meeting notes are never rewritten.
      </p>
    </Section>
  )
}

const HUMANIZER_SITES: Record<Exclude<HumanizerService, 'custom'>, string> = {
  emulate: 'https://www.tryemulate.ai/docs/api', stealthgpt: 'https://docs.stealthgpt.ai', writehuman: 'https://writehuman.ai/api/docs',
  undetectable: 'https://help.undetectable.ai/en/article/humanization-api-v2-p28b2n/',
}
const OPTION_LABELS: Record<string, string> = { model: 'Model', tone: 'Tone', readability: 'Readability', purpose: 'Purpose', strength: 'Strength' }
const EMPTY_CUSTOM: HumanizerCustom = { url: '', header: 'Authorization', body: '{"text": "{{text}}"}', result: 'text' }

/** Service, key and options; Save only once Test connection has passed with exactly these. */
function HumanizerConnect({ s, onClose }: { s: State; onClose: () => void }) {
  const h = s.humanizer
  const [service, setService] = useState<HumanizerService>(h.service === 'none' ? 'emulate' : h.service)
  const [key, setKey] = useState('')
  const [options, setOptions] = useState(h.options)
  const [custom, setCustom] = useState(h.custom ?? EMPTY_CUSTOM)
  const [test, setTest] = useState<{ busy?: boolean; passed?: string; error?: string }>({})
  const cfg = { service, options, custom: service === 'custom' ? custom : null }
  const edit = <T,>(set: (v: T) => void) => (v: T) => (set(v), setTest({})) // any change needs a new test
  const fields = HUMANIZER_OPTIONS[service] ?? {}

  async function run() {
    setTest({ busy: true })
    try {
      const r = await glint.invoke<{ account: State['humanizerAccount']; sample?: string }>('humanizer:test', cfg, key)
      const a = r.account
      const plan = [a?.plan && `${a.plan} plan`, a?.wordsLeft !== undefined && `${a.wordsLeft.toLocaleString()} words left`, a?.maxPerCall && `${a.maxPerCall.toLocaleString()} per call`].filter(Boolean).join(' · ')
      setTest({ passed: r.sample ? `Rewrote the sample: "${r.sample.slice(0, 140)}${r.sample.length > 140 ? '…' : ''}"` : `Connected${plan ? `: ${plan}` : ''}.` })
    } catch (err) {
      setTest({ error: (err as Error).message })
    }
  }
  async function save() {
    try {
      await glint.invoke('humanizer:connect', cfg, key)
      onClose()
    } catch (err) {
      setTest({ error: (err as Error).message })
    }
  }

  return (
    <form className="hz-connect" onSubmit={(e) => (e.preventDefault(), test.passed ? void save() : void run())}>
      <Row as="label" label={<span className="hz-title"><Icon name="person" size={14} />Service</span>}
        hint={service === 'custom' ? 'Any service that takes JSON and answers at once.' : <a href={HUMANIZER_SITES[service]} target="_blank" rel="noreferrer">Its API docs and keys</a>}>
        <select value={service} onChange={(e) => (edit(setService)(e.target.value as HumanizerService), setOptions({}))}>
          {HUMANIZERS.map((x) => <option key={x} value={x}>{x === 'custom' ? 'Custom' : HUMANIZER_LABELS[x]}</option>)}
        </select>
      </Row>
      <Row as="label" label="API key" hint={service === 'custom' ? `Sent as the ${custom.header || 'header'} value, so include "Bearer " if the service wants it.` : 'Encrypted with your keychain, and never shown again.'}>
        <input type="password" autoComplete="off" spellCheck={false} placeholder={service === 'emulate' ? 'ak_live_…' : 'Paste key'} value={key} onChange={(e) => edit(setKey)(e.target.value)} />
      </Row>
      {Object.entries(fields).map(([name, values]) => (
        <Row as="label" key={name} label={OPTION_LABELS[name] ?? name}>
          <select value={options[name] ?? values[0]} onChange={(e) => edit(setOptions)({ ...options, [name]: e.target.value })}>
            {values.map((v) => <option key={v} value={v}>{v || 'Default'}</option>)}
          </select>
        </Row>
      ))}
      {service === 'custom' && (
        <>
          <Row as="label" label="URL" hint="POST, JSON">
            <input type="text" spellCheck={false} placeholder="https://" value={custom.url} onChange={(e) => edit(setCustom)({ ...custom, url: e.target.value })} />
          </Row>
          <Row as="label" label="Key header">
            <input type="text" spellCheck={false} value={custom.header} onChange={(e) => edit(setCustom)({ ...custom, header: e.target.value })} />
          </Row>
          <Row as="label" label="Body" hint="{{text}} is where the answer goes.">
            <input type="text" spellCheck={false} value={custom.body} onChange={(e) => edit(setCustom)({ ...custom, body: e.target.value })} />
          </Row>
          <Row as="label" label="Rewritten text at" hint="A path into the reply, like results.0 or data.text.">
            <input type="text" spellCheck={false} value={custom.result} onChange={(e) => edit(setCustom)({ ...custom, result: e.target.value })} />
          </Row>
        </>
      )}
      <div className="hz-actions">
        {test.error ? <small className="error">{HUMANIZER_LABELS[service]} failed: {test.error}</small>
          : test.passed ? <small className="ok">{test.passed}</small>
          : <small>{service === 'emulate' ? 'The test checks your account. It costs nothing.' : 'The test rewrites a 60-word sample, which costs about 60 words.'}</small>}
        <span className="grow" />
        <button type="button" className="text" onClick={onClose}>Cancel</button>
        {test.passed ? <button type="submit" className="primary">Save</button>
          : <button type="submit" disabled={!key.trim() || test.busy}>{test.busy ? 'Testing…' : 'Test connection'}</button>}
      </div>
    </form>
  )
}

/** A provider's key or sign-in, with what can be done about it. */
function ProviderStatus({ s, provider }: { s: State; provider: AiProvider }) {
  if (isCli(provider)) return <CliStatus provider={provider as 'claude-cli' | 'codex-cli'} />
  const p = provider as KeyProvider
  return <KeyField provider={p} status={s.aiKeys[p]} />
}

function KeyField({ provider, status }: { provider: KeyProvider; status: State['aiKeys'][KeyProvider] }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const save = async (key: string | null) => {
    setError('')
    try {
      await glint.invoke('ai:set-key', provider, key)
      setValue('')
    } catch (err) {
      setError((err as Error).message)
    }
  }
  const text = { none: 'No key saved.', saved: 'Key saved, encrypted with your keychain.', unreadable: "A key is saved but can't be read: the keychain key that protected it is gone. Paste it again." }[status]
  return (
    <>
      <small className={status === 'unreadable' ? 'error' : ''}>
        {text} {status !== 'saved' && <a href={CONSOLES[provider]} target="_blank" rel="noreferrer">Get a key</a>}
        {error && <span className="error"> {error}</span>}
      </small>
      <span className="row-control">
        {status === 'saved' ? (
          <button className="text" onClick={() => void save(null)}>Remove key</button>
        ) : (
          <form className="inline" onSubmit={(e) => (e.preventDefault(), void save(value))}>
            <input type="password" autoComplete="off" spellCheck={false} placeholder="Paste key" aria-label={`${PROVIDER_LABELS[provider]} key`}
              value={value} onChange={(e) => setValue(e.target.value)} />
            <button type="submit" disabled={!value.trim()}>Save</button>
          </form>
        )}
      </span>
    </>
  )
}

/** What the CLI reports about its own sign-in, checked when the page opens and on demand. */
function CliStatus({ provider }: { provider: 'claude-cli' | 'codex-cli' }) {
  const [status, setStatus] = useState<{ ok: boolean; detail: string } | null>(null)
  const [busy, setBusy] = useState(false)
  async function check() {
    setBusy(true)
    try {
      setStatus(await glint.invoke<{ ok: boolean; detail: string }>('ai:cli-status', provider))
    } catch (err) {
      setStatus({ ok: false, detail: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => void check(), [])
  return (
    <>
      <small>
        {busy ? 'Checking…' : withCode(provider === 'claude-cli' && status?.ok ? status.detail.replace(/\.$/, '') : status?.detail ?? '')}
        {provider === 'claude-cli' && status?.ok && !busy && ' · kept running while Glint is on screen (~1 s to start)'}
      </small>
      <span className="row-control">
        {status?.ok && !busy ? <span className="ready">Ready</span> : <button className="text accent" disabled={busy} onClick={() => void check()}>Check again</button>}
      </span>
    </>
  )
}

/** A model id that saves on blur or Enter; blank means `fallback`. */
function ModelField({ value, fallback, label, placeholder, disabled, onSave }: {
  value: string; fallback: string; label: string; placeholder?: string; disabled?: boolean; onSave: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const v = draft.trim() || fallback
    if (v !== value) onSave(v)
    else setDraft(value)
  }
  return (
    <input type="text" spellCheck={false} aria-label={label} value={draft} disabled={disabled} placeholder={placeholder ?? fallback}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && commit()} />
  )
}

const WHISPER_SIZES: Record<LocalWhisper, string> = { tiny: 'Tiny · 75 MB, fastest', base: 'Base · 150 MB', small: 'Small · 500 MB, most accurate' }

function Transcription({ s }: { s: State }) {
  const t = s.transcription
  const setT = (p: Partial<State['transcription']>) => patch({ transcription: p })
  const progress = /(\d+)%/.exec(s.sttStatus ?? '')?.[1]
  return (
    <Section title="Transcription">
      <Row label="Engine" hint={t.engine === 'local' ? 'On this Mac keeps audio on the device. English uses Parakeet v2, 24 other European languages Parakeet v3, the rest Whisper.' : `Billed per minute of speech. ${s.aiKeys.openai === 'saved' ? 'Uses your saved OpenAI key.' : 'Needs an OpenAI key (above).'}`}>
        <Segmented label="Transcription engine" value={t.engine} onChange={(engine) => setT({ engine })}
          options={[{ value: 'local', label: 'On this Mac' }, { value: 'openai', label: 'OpenAI' }]} />
      </Row>
      {t.engine === 'local' ? (
        <Row as="label" label="Whisper model" hint={progress ? (
          <span className="download"><span className="bar"><i style={{ width: `${progress}%` }} /></span>{s.sttStatus}</span>
        ) : s.sttStatus ? <span className="error">{s.sttStatus}</span> : 'For languages Parakeet doesn\'t cover. Each model downloads once, the first time it\'s needed.'}>
          <select value={t.localModel} onChange={(e) => setT({ localModel: e.target.value as LocalWhisper })}>
            {LOCAL_WHISPER_MODELS.map((m) => <option key={m} value={m}>{WHISPER_SIZES[m]}</option>)}
          </select>
        </Row>
      ) : (
        <Row label="Model" hint="Any transcription model your account can use.">
          <ModelField value={t.openaiModel} fallback={PERSISTED_DEFAULTS.transcription.openaiModel} label="Transcription model" onSave={(m) => setT({ openaiModel: m })} />
        </Row>
      )}
      {t.engine === 'local' && (
        <Toggle label="Show words as they're spoken" checked={t.liveWords} onChange={(v) => setT({ liveWords: v })}
          hint="English. The transcript fills in word by word while someone talks, then settles on the final text. Uses a second, streaming model (440 MB) and a little more CPU." />
      )}
      <Row as="label" label="Default spoken language" hint="Change it for one meeting in Meeting options">
        <select value={t.language} onChange={(e) => setT({ language: e.target.value })}>
          {languageOptions(t.language)}
        </select>
      </Row>
      <ModelStorage s={s} />
    </Section>
  )
}

const sizeLabel = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`)

/** How much disk the on-device models take, and removing the ones the current settings don't use. */
function ModelStorage({ s }: { s: State }) {
  const [use, setUse] = useState<{ total: number; unused: number } | null>(null)
  const idle = !s.sttStatus // re-measured after a download finishes
  useEffect(() => void glint.invoke<{ total: number; unused: number }>('models:usage').then(setUse), [s.transcription, idle])
  if (!use?.total) return null
  return (
    <Row label="Models on this Mac" hint={use.unused ? `${sizeLabel(use.unused)} of it is for languages or features you aren't using. Removed models download again if you need them.` : 'All in use by your current settings.'}>
      <span className="storage">
        {sizeLabel(use.total)}
        <button disabled={!use.unused || !!s.session || !idle} data-tip={s.session ? 'Not during a session' : !idle ? 'After the download finishes' : undefined}
          onClick={() => void glint.invoke<{ total: number; unused: number }>('models:remove-unused').then(setUse)}>Remove unused</button>
      </span>
    </Row>
  )
}

// Modes

function Modes({ s }: { s: State }) {
  const [selected, setSelected] = useState<string | null>(s.activeModeId ?? s.modes[0]?.id ?? null)
  const [picking, setPicking] = useState(false)
  const mode = s.modes.find((m) => m.id === selected)
  const add = async (m: Omit<Mode, 'id'>) => setSelected(await glint.invoke<string>('modes:add', m))
  return (
    <div className="modes">
      <div className="mode-list">
        <h2>Your modes</h2>
        {[{ id: null, name: 'General', files: [] as ModeFile[] }, ...s.modes].map((m) => (
          <button key={m.id ?? 'general'} className={`mode-item ${selected === m.id ? 'selected' : ''}`} aria-current={selected === m.id || undefined}
            onClick={() => setSelected(m.id)}>
            <span>{m.name || 'Untitled mode'}</span>
            {!!m.files?.length && <Icon name="clip" size={13} />}
            {s.activeModeId === m.id && <span className="active">active</span>}
          </button>
        ))}
        <hr />
        <button className="mode-add" onClick={() => void add({ name: 'New mode', prompt: '' })}><Icon name="plus" />New mode</button>
        <button className="mode-add template" onClick={() => setPicking(true)}><Icon name="layers" />From a template</button>
      </div>
      <div className="mode-pane">
        {mode ? (
          <ModeEditor key={mode.id} mode={mode} active={s.activeModeId === mode.id} jobs={s.modeFileJobs.filter((j) => j.modeId === mode.id)} />
        ) : (
          <>
            <div className="mode-head">
              <b>General</b>
              <ActiveButton active={s.activeModeId === null} onClick={() => patch({ activeModeId: null })} />
            </div>
            <p className="muted">No extra instructions: Glint's usual help for whatever's on screen and in the call. Pick or add a mode to steer answers for a kind of meeting.</p>
          </>
        )}
      </div>
      {picking && (
        <TemplateSheet onClose={() => setPicking(false)}
          onAdd={(t) => (setPicking(false), void add({ name: t.name, prompt: t.prompt, templateId: t.id }))} />
      )}
    </div>
  )
}

function ActiveButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return active ? <span className="active-pill"><Icon name="check" size={15} />Active</span> : <button onClick={onClick}>Make active</button>
}

const TEMPLATE_GROUPS = [['interviewed', 'Being interviewed'], ['work', 'Work and study']] as const

/** 5c: an in-page sheet, since a native sheet or window would show in screen shares. */
function TemplateSheet({ onClose, onAdd }: { onClose: () => void; onAdd: (t: (typeof MODE_TEMPLATES)[number]) => void }) {
  const [query, setQuery] = useState('')
  const [pick, setPick] = useState<string | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.isComposing && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const q = query.trim().toLowerCase()
  const shown = MODE_TEMPLATES.filter((t) => !q || `${t.title} ${t.blurb}`.toLowerCase().includes(q))
  const chosen = MODE_TEMPLATES.find((t) => t.id === pick)
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Start from a template" onClick={(e) => e.stopPropagation()}>
        <header><b>Start from a template</b><span>You can edit everything afterwards</span></header>
        <label className="sheet-search">
          <Icon name="search" />
          <input type="search" autoFocus placeholder={`Search ${MODE_TEMPLATES.length} templates`} aria-label="Search templates" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="sheet-body">
          {TEMPLATE_GROUPS.map(([g, label]) => {
            const ts = shown.filter((t) => t.group === g)
            return ts.length > 0 && (
              <section key={g}>
                <h3>{label}</h3>
                <div className="tgrid">
                  {ts.map((t) => (
                    <button key={t.id} className={`tcard ${pick === t.id ? 'on' : ''}`} onClick={() => setPick(t.id)} onDoubleClick={() => onAdd(t)}>
                      <b>{t.title}</b><span>{t.blurb}</span>
                    </button>
                  ))}
                </div>
              </section>
            )
          })}
          {!shown.length && <p className="muted sheet-empty">No template matches.</p>}
        </div>
        <footer>
          <p>{chosen ? <><b>{chosen.title}:</b> tip for this one: {chosen.tip}</> : 'Pick a template to see a tip for it.'}</p>
          <span className="sheet-buttons">
            <button className="text" onClick={onClose}>Cancel</button>
            <button className="primary" disabled={!chosen} onClick={() => chosen && onAdd(chosen)}>Add mode</button>
          </span>
        </footer>
      </div>
    </div>
  )
}

/** Edits autosave ~600 ms after typing stops, and on unmount so nothing typed is lost. */
function ModeEditor({ mode, active, jobs }: { mode: Mode; active: boolean; jobs: State['modeFileJobs'] }) {
  const [draft, setDraft] = useState(mode)
  const saved = useRef(mode)
  const latest = useRef(draft)
  latest.current = draft
  const save = () => {
    const d = latest.current
    if (d.name === saved.current.name && d.prompt === saved.current.prompt && d.screenshotNote === saved.current.screenshotNote) return
    saved.current = d
    // Main updates just this mode, and only if it still exists: a deleted mode can't come back.
    void glint.invoke('modes:update', { id: d.id, name: d.name, prompt: d.prompt, screenshotNote: d.screenshotNote ?? '' })
  }
  useEffect(() => {
    const t = setTimeout(save, 600)
    return () => clearTimeout(t)
  }, [draft])
  useEffect(() => save, [])

  return (
    <>
      <div className="mode-head">
        <input className="mode-name" type="text" aria-label="Mode name" value={draft.name} maxLength={40} placeholder="Untitled mode"
          onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <ActiveButton active={active} onClick={() => patch({ activeModeId: mode.id })} />
      </div>
      <label className="mfield">
        <span className="mlabel">Instructions</span>
        <textarea rows={7} maxLength={8000} value={draft.prompt} placeholder="e.g. I'm a nurse on handover calls. Summarise each patient in three lines."
          onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
      </label>
      <label className="mfield">
        <span className="mlabel">Note on screenshots <small>· drawn under the note from General while this mode is active</small></span>
        <input type="text" className="note-line" maxLength={NOTE_MAX} value={draft.screenshotNote ?? ''} placeholder="Optional"
          onChange={(e) => setDraft({ ...draft, screenshotNote: e.target.value })} />
      </label>
      <ModeFiles mode={mode} jobs={jobs} />
      <div className="footer-actions mode-foot">
        <span className="grow" />
        <ConfirmButton label="Hold to delete mode" confirmLabel={`Delete "${draft.name || 'Untitled mode'}"`} onConfirm={() => void glint.invoke('modes:delete', mode.id)} />
      </div>
    </>
  )
}

/** About 6 characters to a word, for showing a file's size the way people think of documents. */
const words = (chars: number) => `${Math.max(1, Math.round(chars / 6 / 100) * 100).toLocaleString()} words`
const fileIcon = (name: string) => (/\.(png|jpe?g|gif|heic|tiff?|webp|bmp)$/i.test(name) ? 'image' : 'file')
/** Colours a file's icon: PDFs red, documents blue, the rest grey. */
const fileKind = (name: string) => (/\.pdf$/i.test(name) ? 'pdf' : /\.(docx?|rtf|odt|pages|html?)$/i.test(name) ? 'doc' : '')

/** Reference files: read by main from a file picker, since the page can't reach the disk. */
function ModeFiles({ mode, jobs }: { mode: Mode; jobs: State['modeFileJobs'] }) {
  const [adding, setAdding] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const files = mode.files ?? []
  const reading = jobs.filter((j) => j.ocr)
  // Files added after the page opened grow into the list.
  const born = useRef<{ at: number; ids: Map<string, number> }>({ at: Date.now(), ids: new Map() })
  const isNew = (id: string) => {
    if (!born.current.ids.has(id)) born.current.ids.set(id, Date.now())
    return born.current.ids.get(id)! > born.current.at + 50
  }
  const total = files.reduce((n, f) => n + f.chars, 0)
  const searched = searchesFiles(mode)
  const add = async () => {
    setAdding(true)
    setProblems([])
    try {
      setProblems(await glint.invoke<string[]>('modes:add-files', mode.id))
    } catch (err) {
      setProblems([err instanceof Error ? err.message : String(err)])
    } finally {
      setAdding(false)
    }
  }
  return (
    <div className="mfield">
      <span className="mfield-head">
        <span className="mlabel">Reference files <small>· {searched ? 'searched for each ask while this mode is active' : 'full text goes with every ask while this mode is active'}</small></span>
        <button className="add-files" onClick={() => void add()} disabled={adding}><Icon name="plus" size={15} />Add files…</button>
      </span>
      {(files.length > 0 || reading.length > 0) && (
        <ul className="files">
          {files.map((f) => (
            <li key={f.id} className={isNew(f.id) ? 'expand-in' : ''}>
              <span className={`ficon ${fileKind(f.name)}`}><Icon name={fileIcon(f.name)} /></span>
              <span className="row-text">{f.name}<small>{f.pages ? `${f.pages} ${f.pages === 1 ? 'page' : 'pages'} · ` : ''}{words(f.chars)}</small></span>
              <ConfirmButton quiet label="Remove" confirmLabel="Hold to remove" onConfirm={() => void glint.invoke('modes:remove-file', mode.id, f.id)} />
            </li>
          ))}
          {reading.map((j) => (
            <li key={j.id} className="reading">
              <span className={`ficon ${fileKind(j.name)}`}><Icon name={fileIcon(j.name)} /></span>
              <span className="row-text">{j.name}
                <span className="ocr"><span className="track"><i style={{ width: `${(j.done / Math.max(1, j.total)) * 100}%` }} /></span>Reading text with macOS text recognition…</span>
              </span>
              <button className="text" disabled>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {problems.map((p) => <small className="error" key={p}>Couldn't add {p}.</small>)}
      <small className="files-hint">
        {searched
          ? `Too big to send whole: Glint searches these files for each question and sends the passages that match (${files.length} ${files.length === 1 ? 'file' : 'files'}, about ${words(total)}). Questions about a file as a whole may miss parts.`
          : files.length > 0
          ? `PDF, Word, Markdown, text, EPUB or images · ${files.length} ${files.length === 1 ? 'file' : 'files'}, about ${words(total)} with each ask. Large files can slow the first words.`
          : 'PDF, Word, Markdown, text, EPUB or images. Scans and pictures are read with text recognition, and the text is stored encrypted on this Mac.'}
      </small>
    </div>
  )
}

// Voice

const PASSAGE = 'The morning train was later than usual, so I walked the long way past the harbour. Boats were coming in with the tide, gulls circled overhead, and someone was selling coffee from a small cart. By the time I reached the office the rain had cleared, and the whole street smelled of bread from the bakery on the corner.'
/** Main needs four 3 s windows with speech; the extra seconds cover pauses between sentences. */
const ENROLL_MIN_S = 15
const ENROLL_MAX_S = 30

/** Name guesses read the invite for the meeting in progress: who's on it, and its title. */
function CalendarRow() {
  const [access, setAccess] = useState<'granted' | 'denied' | 'ask' | null>(null)
  useEffect(() => void glint.invoke<'granted' | 'denied' | 'ask'>('calendar:status').then(setAccess, () => setAccess('denied')), [])
  const allow = () => void glint.invoke<'granted' | 'denied' | 'ask'>('calendar:allow').then(setAccess)
  return (
    <Row label="Calendar invites"
      hint={access === 'denied'
        ? 'Glint can\'t read your calendars. Allow it in System Settings → Privacy & Security → Calendars, then come back.'
        : 'Guess matches speakers to the people on the invite for the meeting you\'re in. Only that invite is read, on this Mac, when you press Guess.'}>
      {access === 'granted' ? <span className="muted">Allowed</span> : access && <button onClick={allow}>{access === 'denied' ? 'Open System Settings' : 'Allow'}</button>}
    </Row>
  )
}

function Voice({ s }: { s: State }) {
  const player = usePlayback()
  const model = {
    missing: 'The voice model downloads once (40 MB) the first time it\'s needed.',
    downloading: `Downloading the voice model…${s.voiceModelPct !== null ? ` ${s.voiceModelPct}%` : ''}`,
    ready: '',
    failed: 'The voice model failed to load. It will try again next session.',
  }[s.voiceModel]
  return (
    <>
      <p className="muted intro">
        Glint tells voices apart on this Mac: you from the call playing through your speakers, and other people from each other.
        Voices are stored on this Mac, encrypted with your keychain. {model}
      </p>
      <Enroll s={s} player={player} />
      <Toggle label="Room mode" checked={s.roomMode && s.voiceprint === 'enrolled'} disabled={s.voiceprint !== 'enrolled'} onChange={(v) => patch({ roomMode: v })}
        hint={<>For meetings in person, where one mic hears everyone: your voice tells you apart. {s.voiceprint !== 'enrolled' ? 'Record your voice first.' : 'If macOS Mic Mode is Voice Isolation, other people get filtered out; set it to Standard.'}</>} />
      <Toggle label="Speaker labels" hint={'Split "Them" into named people · also on the overlay'} checked={s.speakerLabels} onChange={(v) => patch({ speakerLabels: v })} />
      <CalendarRow />

      <Section title={`People Glint knows · ${s.people.length}`} aside={<small>Save a voice only with that person's agreement</small>}>
        {s.people.length ? s.people.map((p) => <PersonRow key={p.id} p={p} player={player} />) : (
          <p className="muted">No one saved yet. When Glint has heard a new voice for a few lines, it asks who it is.</p>
        )}
        {!!s.people.length && (
          <div className="footer-actions forget">
            <span className="grow" />
            <ConfirmButton label="Hold to forget everyone" confirmLabel="Forget all saved voices" onConfirm={() => void glint.invoke('people:forget-all')} />
          </div>
        )}
      </Section>
    </>
  )
}

/**
 * The user's voiceprint as a card; recording shows the passage first, then Start. While recording: a timer, a level
 * meter, Done once there's enough speech, and Cancel. Stops by itself at ENROLL_MAX_S.
 */
function Enroll({ s, player }: { s: State; player: Player }) {
  const [stage, setStage] = useState<'idle' | 'ready' | 'starting' | 'recording' | 'saving'>('idle')
  const [level, setLevel] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null)
  const rec = useRef<Recording | null>(null)
  /** Cancel pressed while the mic was still opening. */
  const cancelled = useRef(false)

  // Leaving the page mid-recording must release the mic, including while it's still opening.
  useEffect(() => () => {
    cancelled.current = true
    rec.current?.cancel()
  }, [])

  useEffect(() => {
    if (stage !== 'recording') return
    const t = setInterval(() => {
      const secs = rec.current?.seconds() ?? 0
      setSeconds(secs)
      if (secs >= ENROLL_MAX_S) void finish()
    }, 200)
    return () => clearInterval(t)
  }, [stage])

  async function start() {
    cancelled.current = false
    setNote(null)
    setSeconds(0)
    setStage('starting')
    try {
      const r = await startRecording(setLevel)
      if (cancelled.current) return r.cancel()
      rec.current = r
      setStage('recording')
    } catch (err) {
      setNote({ text: `Couldn't use the microphone: ${(err as Error).message}`, error: true })
      setStage('idle')
    }
  }

  async function finish() {
    const r = rec.current
    if (!r) return
    rec.current = null
    const pcm = r.stop()
    setStage('saving')
    try {
      await glint.invoke('voice:enroll', pcm)
      setNote({ text: 'Saved. Glint knows your voice now.' })
    } catch (err) {
      setNote({ text: (err as Error).message, error: true })
    } finally {
      setStage('idle')
    }
  }

  function cancel() {
    cancelled.current = true
    rec.current?.cancel()
    rec.current = null
    setStage('idle')
    setNote({ text: 'Cancelled. Nothing was saved.' })
  }

  const bars = useWaveform(s.voiceprint === 'enrolled', s.voiceprintSeconds)
  const busy = stage !== 'idle'
  const enough = seconds >= ENROLL_MIN_S
  const clock = (n: number) => `0:${String(Math.floor(n)).padStart(2, '0')}`
  const status = s.voiceprint === 'unreadable'
    ? <span className="error">Saved voices can't be read anymore: the keychain key that protected them is gone. Record your voice again; saved people need saving again too.</span>
    : s.voiceprint === 'enrolled' ? `Recorded${s.voiceprintSeconds ? ` ${s.voiceprintSeconds} s` : ''} · room mode is available` : 'Not recorded yet · needed for room mode'
  return (
    <div className="voice-card">
      <div className="voice-card-head">
        <span className="voice-icon"><Icon name="person" size={22} /></span>
        <span className="row-text">
          <b>Your voice</b>
          <span className="wave-row">
            {bars && <span className="wave" aria-hidden="true">{bars.map((h, i) => <i key={i} style={{ height: h }} />)}</span>}
            <small>{status}{note && <> · {note.error ? <span className="error">{note.text}</span> : note.text}</>}</small>
          </span>
        </span>
        {!busy && (
          <span className="row-control">
            {bars && <PlayButton id="me" label="your voice" player={player} />}
            <button onClick={() => (setNote(null), setStage('ready'))}>{s.voiceprint === 'enrolled' ? 'Re-record' : 'Record my voice'}</button>
            {s.voiceprint === 'enrolled' && <ConfirmButton quiet label="Delete" confirmLabel="Hold to delete" onConfirm={() => void glint.invoke('voice:delete-me')} />}
          </span>
        )}
      </div>
      {busy && (
        <div className="enroll">
          <p className="muted">
            {stage === 'ready' && `Press Start, then read this aloud at your normal pace, like you'd talk in a meeting. It takes about 20 seconds.`}
            {stage === 'starting' && 'Opening the microphone…'}
            {stage === 'recording' && (enough ? 'That\'s enough to save. Keep reading for a better voiceprint, or press Done.' : 'Keep reading…')}
            {stage === 'saving' && 'Checking your recording…'}
          </p>
          <p className="passage">{PASSAGE}</p>
          <div className="enroll-controls">
            {stage === 'recording' && (
              <>
                <span className="rec-dot" aria-hidden="true" /> <span>Recording</span>
                <span className="num">{clock(seconds)} / {clock(ENROLL_MAX_S)}</span>
                <span className="level" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level}><i style={{ width: `${Math.round(level * 100)}%` }} /></span>
              </>
            )}
            <span className="grow" />
            {stage === 'ready' && <button className="primary" onClick={() => void start()}>Start recording</button>}
            {stage === 'recording' && (
              <button className="primary" disabled={!enough} onClick={() => void finish()}>
                {enough ? 'Done' : `Done in ${Math.ceil(ENROLL_MIN_S - seconds)} s`}
              </button>
            )}
            {stage !== 'saving' && <button onClick={cancel}>Cancel</button>}
          </div>
        </div>
      )}
    </div>
  )
}

function lastHeard(ms: number) {
  const d = new Date(ms)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return 'last heard today'
  return `last heard ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })}`
}

type Player = ReturnType<typeof usePlayback>

/** A 28 px play button that turns into a stop button while its clip plays. */
function PlayButton({ id, label, player, disabled }: { id: string; label: string; player: Player; disabled?: boolean }) {
  const on = player.playing === id
  return (
    <button className={`play ${on ? 'playing' : ''}`} aria-label={on ? 'Stop' : `Play ${label}`} disabled={disabled}
      data-tip={disabled ? 'No sample saved' : on ? 'Stop' : `Hear ${label}`} onClick={() => void player.toggle(id)}>
      <Icon name={on ? 'pause' : 'play'} />
    </button>
  )
}

/** 12 bars from the saved sample's loudness, 5 to 17 px high; null without a sample. */
function useWaveform(enrolled: boolean, key: unknown) {
  const [bars, setBars] = useState<number[] | null>(null)
  useEffect(() => {
    if (!enrolled) return setBars(null)
    void glint.invoke<Uint8Array | null>('voice:audio', 'me').then((b) => setBars(b?.byteLength ? waveform(b) : null))
  }, [enrolled, key])
  return bars
}

function waveform(bytes: Uint8Array, n = 12): number[] {
  const s16 = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1)))
  const size = Math.max(1, Math.floor(s16.length / n))
  const rms = Array.from({ length: n }, (_, i) => {
    let e = 0
    for (let j = i * size; j < Math.min((i + 1) * size, s16.length); j++) e += (s16[j] / 0x8000) ** 2
    return Math.sqrt(e / size)
  })
  const max = Math.max(...rms) || 1
  return rms.map((r) => Math.round(5 + 12 * (r / max)))
}

function PersonRow({ p, player }: { p: State['people'][number]; player: Player }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft !== null && draft.trim() && draft.trim() !== p.name) void glint.invoke('people:rename', p.id, draft)
    setDraft(null)
  }
  return (
    <div className={`person ${draft === null ? '' : 'editing'}`}>
      <PlayButton id={p.id} label={`${p.name}'s voice`} player={player} disabled={!p.hasSample} />
      {draft === null ? (
        <>
          <span className="row-text">{p.name}<small>{p.sessions === 1 ? '1 session' : `${p.sessions} sessions`} · {lastHeard(p.lastHeard)}</small></span>
          <span className="person-actions">
            <button className="text" onClick={() => setDraft(p.name)}>Rename</button>
            <ConfirmButton quiet label="Delete" confirmLabel="Hold…" onConfirm={() => void glint.invoke('people:delete', p.id)} />
          </span>
        </>
      ) : (
        <form className="rename" onSubmit={(e) => (e.preventDefault(), commit())}>
          <input type="text" autoFocus maxLength={40} value={draft} aria-label="Name"
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && !e.nativeEvent.isComposing && setDraft(null)} />
          <span className="person-actions">
            <button type="submit" className="text accent" disabled={!draft.trim()}>Save</button>
            <button type="button" className="text" onClick={() => setDraft(null)}>Cancel</button>
          </span>
        </form>
      )}
    </div>
  )
}

// Shortcuts

const PANEL_KEYS: [string, string][] = [
  ['Tab', 'Type in the chat box'],
  [isMac ? '⌘T' : 'Ctrl+T', 'Transcript'],
  [isMac ? '⌘R' : 'Ctrl+R', 'New chat (outside a session)'],
  ['↓', 'History (in an empty chat box)'],
  ['Esc', 'Step back, then return focus to your app, then hide'],
]

/** One recorder at a time, owned here, so a combo can't be captured by two actions at once. */
function Shortcuts({ s }: { s: State }) {
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [note, setNote] = useState<{ action: ShortcutAction; text: string } | null>(null)
  const shortcuts = s.shortcuts
  // Read through a ref: every state broadcast brings a new object, and re-running the recorder effect on each one
  // flips isRecordingShortcut off and on, which broadcasts again, forever.
  const shortcutsRef = useRef(shortcuts)
  shortcutsRef.current = shortcuts
  const ownerOf = (acc: string, except: ShortcutAction) =>
    (Object.keys(shortcutsRef.current) as ShortcutAction[]).find((a) => a !== except && shortcutsRef.current[a] === acc)

  useEffect(() => {
    if (!recording) return
    const action = recording
    void patch({ isRecordingShortcut: true }) // main drops all global hotkeys so any combo reaches us
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
      if (e.code === 'Escape' && plain) return setRecording(null)
      const acc = toAccelerator(e, isMac)
      if (acc === null) return
      if (acc === 'no-modifier') {
        const why = e.altKey ? ": macOS won't give ⌥ alone to an app, and it types accents" : ''
        return setNote({ action, text: isMac ? `Include ⌘ or ⌃${why}.` : 'Include Ctrl or Alt.' })
      }
      if (isSystemShortcut(acc, isMac)) return setNote({ action, text: 'Used by macOS in every app.' })
      const owner = ownerOf(acc, action)
      if (owner) return setNote({ action, text: `Already used for "${LABELS[owner]}".` })
      setNote(clashesWithEditing(acc) ? { action, text: 'Saved, but this replaces a common editing shortcut in every app.' } : null)
      void patch({ shortcuts: { [action]: acc } })
      setRecording(null)
    }
    const cancel = () => setRecording(null)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', cancel)
      void patch({ isRecordingShortcut: false }) // main also clears this if the window closes mid-recording
    }
  }, [recording])

  const restoreDefault = (action: ShortcutAction) => {
    setRecording(null)
    const owner = DEFAULT_SHORTCUTS[action] && ownerOf(DEFAULT_SHORTCUTS[action], action) // blank: clearing it clashes with nothing
    if (owner) return setNote({ action, text: `The default is now used for "${LABELS[owner]}".` })
    setNote(null)
    void patch({ shortcuts: { [action]: DEFAULT_SHORTCUTS[action] } })
  }

  const row = (a: ShortcutAction) => (
    <Row key={a} blank={!shortcuts[a] && recording !== a} label={LABELS[a]} hint={note?.action === a ? note.text
      : s.shortcutFailures.includes(a) ? <span className="error">Not working: another app has these keys, or macOS refuses them</span>
      : a.startsWith('move') ? 'Only while Glint is on screen' : undefined}>
      <button className={`keycap ${recording === a ? 'recording' : ''} ${shortcuts[a] ? '' : 'unset'}`}
        onClick={() => (setNote(null), setRecording(a))} onDoubleClick={() => restoreDefault(a)}>
        {recording === a ? 'Press keys…' : shortcuts[a] ? prettyAccelerator(shortcuts[a], isMac) : 'Record…'}
      </button>
    </Row>
  )
  const groups: [string, ShortcutAction[]][] = [
    ['During a call', ['toggleOverlay', 'toggleSession', 'togglePause', 'toggleInvisible', 'ask', 'openSettings']],
    ['Overlay', ['toggleDiscreet', 'toggleGlance', 'toggleGhost', 'moveUp', 'moveDown', 'moveLeft', 'moveRight', 'scrollUp', 'scrollDown']],
    ['Ghost', ['ghostAsk', 'ghostPrompt', 'ghostPrev', 'ghostNext', 'ghostBack', 'ghostSkip', 'ghostHide', 'ghostFadeIn', 'ghostFadeOut', 'ghostBigger', 'ghostSmaller', 'ghostCorner']],
  ]
  return (
    <>
      <p className="muted intro">Click a shortcut, then press the keys. Double-click to restore the default, or to clear one that has none.</p>
      {groups.map(([title, actions]) => <Section key={title} title={title}>{actions.map(row)}</Section>)}
      <Section title="In the chat panel">
        {PANEL_KEYS.map(([key, what]) => <Row key={key} label={what}><kbd>{key}</kbd></Row>)}
      </Section>
    </>
  )
}

// Developer

const VAD_LABELS: Record<keyof VadSettings, [string, string]> = {
  positive: ['Speech threshold', 'Probability above which a frame counts as speech. Lower catches quiet voices, and more noise.'],
  negative: ['Silence threshold', 'Probability below which a frame counts as silence. Kept at or below the speech threshold.'],
  preSpeechPadMs: ['Pre-speech pad', 'Audio kept from before speech starts, so first syllables aren\'t clipped. Try 300–800.'],
  redemptionMs: ['Pause before a line ends', 'Lower splits lines at short pauses; higher merges them. Try 300–1400.'],
  minSpeechMs: ['Shortest line', 'Speech shorter than this is ignored as a cough or click.'],
  maxSegmentMs: ['Longest line', 'Longer speech is cut here so transcription keeps up.'],
}

const VOICE_LABELS: Record<keyof VoiceSettings, [string, string]> = {
  meKeep: ['You, at least', 'Mic speech this close to your voice is you, even while someone else talks.'],
  notMe: ['Not you, at most', 'Mic speech this far from your voice is someone else, or the call playing back through your speakers.'],
  match: ['Same person, at least', 'How close a line must be to a saved person or an earlier voice to be labelled as them.'],
  margin: ['Lead over the next best', 'The best match must beat the runner-up by this much, so similar voices don\'t swap.'],
  newBelow: ['New voice, below', 'A line this unlike every known voice starts a new speaker.'],
}

function Developer({ s }: { s: State }) {
  const vadKeys = Object.keys(VAD_LABELS) as (keyof VadSettings)[]
  const voiceKeys = Object.keys(VOICE_LABELS) as (keyof VoiceSettings)[]
  const vadDefault = vadKeys.every((k) => s.vad[k] === VAD_DEFAULTS[k])
  const voiceDefault = voiceKeys.every((k) => s.voice[k] === VOICE_DEFAULTS[k])
  const ms = (v: number) => `${v} ms`
  return (
    <>
      <h1 className="with-aside">Developer
        <button className="link" disabled={vadDefault && voiceDefault} onClick={() => patch({ vad: VAD_DEFAULTS, voice: VOICE_DEFAULTS })}>Restore defaults</button>
      </h1>
      <p className="muted intro">Tuning for real meetings. Changes apply at once, including to a live session.</p>
      <LiveLog />
      <Section title={`Speech detection · ${vadKeys.length}`}>
        {vadKeys.map((k) => (
          <DevSlider key={k} label={VAD_LABELS[k][0]} hint={VAD_LABELS[k][1]} range={VAD_RANGES[k]} value={s.vad[k]}
            format={k.endsWith('Ms') ? ms : (v) => v.toFixed(2)} onChange={(v) => patch({ vad: { [k]: v } })} />
        ))}
      </Section>
      <Section title={`Voice matching · ${voiceKeys.length}`}>
        {voiceKeys.map((k) => (
          <DevSlider key={k} label={VOICE_LABELS[k][0]} hint={VOICE_LABELS[k][1]} range={VOICE_RANGES[k]} value={s.voice[k]}
            format={(v) => v.toFixed(2)} onChange={(v) => patch({ voice: { [k]: v } })} />
        ))}
      </Section>
    </>
  )
}

// About

function About({ s }: { s: State }) {
  const commit = typeof __GLINT_COMMIT__ === 'string' ? __GLINT_COMMIT__ : ''
  const info = `Glint ${s.appVersion}${commit ? ` (${commit})` : ''} · ${s.systemInfo}`
  return (
    <>
      <div className="about-head">
        <span className="about-logo"><i /></span>
        <span className="row-text">
          <b>Glint {s.appVersion}</b>
          <small>{[commit, s.systemInfo].filter(Boolean).join(' · ')}</small>
        </span>
      </div>
      <button className="copy-info" data-tip="Copies Glint's version and your Mac's details, to paste into a bug report" onClick={() => glint.send('app:copy', info)}>
        <Icon name="copy" size={15} />Copy system info
      </button>
      <Section title="Troubleshooting">
        <Toggle label="Developer tools" checked={s.devTools} onChange={(v) => patch({ devTools: v })}
          hint="Adds a Developer page: speech and voice tuning, a live log with more detail, and a bug report to download. The log holds timings and errors, never what was said." />
      </Section>
      <Section title="What's new">
        <ul className="whats-new">
          {RELEASES.map((r) => <li key={r.version}><b>{r.version}</b> · {r.summary}</li>)}
        </ul>
      </Section>
    </>
  )
}

/** One line per release from the changelog: its version and the lead of its first entry. */
const RELEASES = notes.split(/^## /m).slice(1).map((block) => {
  const version = block.split(/[\s(]/)[0]
  const first = /^- (.+)$/m.exec(block)?.[1] ?? ''
  const lead = /^\*\*(.+?)\*\*/.exec(first)?.[1] ?? first.split(/(?<=\.)\s/)[0]
  return { version, summary: lead.replace(/\*\*/g, '').replace(/[.:]$/, '') }
})

/**
 * Main's log as it's written (verbose while developer tools are on), and a bug report to download: the version,
 * the Mac, settings that change behaviour, and the whole log. Nothing that was said is ever in it.
 */
function LiveLog() {
  const [text, setText] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  const box = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const read = () => void glint.invoke<string>('log:tail').then((t) => {
      const el = box.current
      const atEnd = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 24 // keep following unless scrolled up
      setText(t)
      if (atEnd) requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight))
    })
    read()
    const t = setInterval(read, 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <Section title="Log" aside={
      <button className="link" onClick={() => void glint.invoke<string | null>('log:save-report').then((p) => p && setSaved(p))}>Download bug report</button>
    }>
      <pre className="live-log" ref={box}>{text || 'Nothing logged yet.'}</pre>
      {saved && <p className="muted">Saved to {saved}. Attach it to your bug report.</p>}
    </Section>
  )
}

/** A Developer tuning row: label (its explanation on hover), a slider and the value. */
function DevSlider({ label, hint, range: [min, max, step], value, format, onChange }: {
  label: string; hint: string; range: [number, number, number]; value: number; format: (v: number) => string; onChange: (v: number) => void
}) {
  return (
    <label className="dev-row">
      <span data-tip={hint}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} style={fill(value, min, max)} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{format(value)}</output>
    </label>
  )
}

/** A slider's filled part, for the track's gradient. */
const fill = (v: number, min: number, max: number) => ({ '--fill': `${((v - min) / (max - min)) * 100}%` }) as CSSProperties

/** Commands in `backticks` as monospace. */
const withCode = (text: string) => text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))
