import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { HUMANIZER_LABELS } from '../../shared/humanize'
import { PROVIDER_LABELS, splitFailure } from '../../shared/providers'
import {
  AI_PROVIDERS, CAPSULE_ITEMS, elapsedMs, formatElapsed, isDivider, NOTE_MAX, OPACITY_RANGES, prettyAccelerator, tidyDividers, type AiProvider,
  type AutoCopy, type CapsuleItem, type State,
} from '../../shared/state'
import { GuessButton } from './ChatPanel'
import { glint, isMac, opacityStyle, patch, useAppState, useGlass, useTick } from './glint'
import { Icon } from './icons'
import { usePlayback } from './mic'
import { DraftTextarea, Presence, Segmented } from './ui'

// 1a Island: one capsule that holds every in-call control. Main sizes this window to what the page reports (the
// capsule, the new-voice tray under it, an open popover and a tooltip), keeps the capsule centred, and hangs the
// panel under it.

/** The keyboard only reaches this window on request (the tray's name field, Meeting options' note). */
const wantFocus = () => void glint.invoke('window:focus-bar')

export function ControlBar() {
  const s = useAppState()
  const root = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const [open, setOpen] = useState<'options' | 'mode' | null>(null)
  useTick(!!s?.session && !s.pause.paused)
  useGlass('.capsule, .tray, .popover.options', isMac) // before useReportSize (see useGlass)
  useReportSize(root)
  useClickThrough()

  // No key focus, so Esc can't close a popover; a click anywhere else in this window does.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => !(e.target as Element).closest('.popover, [aria-haspopup]') && setOpen(null)
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  if (!s) return null
  const live = !!s.session
  const streaming = s.chat.isStreaming
  const failure = s.aiFailure ?? s.audioError
  const updateReady = s.update.status === 'available'
  // Compact: only the dot, the chat box, Ask and Meeting options. Onboarding's practice run needs the whole capsule.
  const compact = s.compactBar && !s.practicing
  const faded = s.discreet && !open && !failure
  const toggle = (which: 'options' | 'mode') => setOpen(open === which ? null : which)
  const endDrag = () => {
    if (!dragging.current) return
    dragging.current = false
    glint.send('window:drag-end') // main toggles the panel if the pointer didn't move
  }

  // Compact keeps its own fixed set; the user's layout shapes the full capsule.
  const { shown, hidden } = compact ? { shown: [], hidden: [] } : layout(s)
  const moved = hidden.filter((id) => !isDivider(id) && usable(s, id))
  const c: ItemCtx = { s, mode: { open: open === 'mode', onToggle: () => toggle('mode'), onClose: () => setOpen(null) } }

  return (
    <div ref={root} className="island" style={opacityStyle(s.opacity)}>
      <div className={`capsule surface ${s.isInvisible ? '' : 'on-share'} ${failure ? 'failing' : ''} ${faded ? 'faded' : ''} ${compact ? 'compact' : ''}`}>
        <div className={`logo ${failure ? 'error' : streaming ? 'working' : ''} ${compact && live && !failure ? 'recording' : ''}`}
          data-tip={compact && failure ? failure : `${compact && live ? `Recording · ${formatElapsed(elapsedMs(s, Date.now()))} · ` : ''}Drag to move · click to show or hide the panel · double-click to reset`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            dragging.current = true
            glint.send('window:drag-start')
          }}
          onPointerUp={endDrag}
          onLostPointerCapture={endDrag}
          onDoubleClick={() => glint.send('window:reset-position')}>
          <i />
        </div>

        {compact ? <><CapsuleItemView id="chat" c={c} /><CapsuleItemView id="ask" c={c} /></>
          : <SessionControls s={s} items={shown} modeOpen={open === 'mode'} onMode={(o) => setOpen(o ? 'mode' : null)} />}
        {(!failure || compact) && (
          <button className={`circle tune ${open === 'options' ? 'open' : ''}`} aria-label="Meeting options" aria-haspopup="dialog" aria-expanded={open === 'options'}
            data-tip={open === 'options' ? undefined : updateReady ? 'Meeting options. An update is ready: All settings…'
              : moved.length ? 'Meeting options, and the controls kept there'
              : 'Meeting options: layout, discreet, copying, language, AI provider, note, opacity'} onClick={() => toggle('options')}>
            <Icon name="tune" />
            {s.namePrompt && hidden.includes('labels') ? <i className="badge" /> : updateReady && <i className="badge update" />}
          </button>
        )}
      </div>

      {s.namePrompt && !failure && <NameTray key={s.namePrompt.id} s={s} prompt={s.namePrompt} />}
      {s.callDetected && !s.session && !failure && <CallTray s={s} app={s.callDetected} />}
      <Presence open={open === 'options'}>{(closing) => <MeetingOptions c={c} hidden={hidden} more={moved} closing={closing} onClose={() => setOpen(null)} />}</Presence>
    </div>
  )
}


/** Compact mode's panel row: everything but the chat box and Ask, in the default order. */
const PANEL_ITEMS = CAPSULE_ITEMS.filter((id) => id !== 'divider-4' && id !== 'chat' && id !== 'ask')

/**
 * The capsule's middle: the status, then the user's items in order (a failure takes the calm ones' room). Compact mode
 * moves it into the chat panel, so every control is still one click away.
 */
export function SessionControls({ s, items = PANEL_ITEMS, modeOpen, onMode }: {
  s: State; items?: CapsuleItem[]; modeOpen: boolean; onMode: (open: boolean) => void
}) {
  const live = !!s.session
  const paused = live && s.pause.paused
  const failure = s.aiFailure ?? s.audioError
  const run = tidyDividers(items.filter((id) => usable(s, id) && !(failure && CALM.has(id))))
  const c: ItemCtx = { s, mode: { open: modeOpen, onToggle: () => onMode(!modeOpen), onClose: () => onMode(false) } }
  return (
    <>
      {live ? (
        <span key="rec" className={`rec ${paused ? 'paused' : ''}`}>
          {paused ? <Icon name="pause" size={12} /> : <i className="rec-dot" />}
          <span className="clock">{formatElapsed(elapsedMs(s, Date.now()))}</span>
        </span>
      ) : !failure && <span key="ready" className="cap-label">Ready</span>}

      {failure && (
        <>
          <span className="divider" />
          <span className="fail-msg" role="alert" data-tip={failure}><Icon name="alert" size={15} /><FailLine line={failure} /></span>
          <button className="chip danger" onClick={() => patch(s.aiFailure ? { aiFailure: null } : { audioError: null })}>Dismiss</button>
          {run.length > 0 && !isDivider(run[0]) && <span className="divider" />}
        </>
      )}
      {run.map((id) => <CapsuleItemView key={id} id={id} c={c} />)}
    </>
  )
}

/**
 * Clicks on the window's empty part (under a tooltip, beside the tray) go through to the panel below. An open popover
 * keeps them, so clicking outside it closes it. Main reports the pointer, since this window gets no hover events.
 */
function useClickThrough() {
  const hit = useRef(true)
  // null: the pointer is in the empty room or off the window, so clicks there go through.
  useEffect(() => glint.on('pointer:at', (p: { x: number; y: number } | null) => {
    const on = !!document.querySelector('.popover') || (!!p && !!document.elementFromPoint(p.x, p.y)?.closest('.capsule, .tray'))
    if (on === hit.current) return
    hit.current = on
    glint.send('window:bar-hit', on)
  }), [])
}

/** Reports what this window must hold: the capsule and tray (`flow`, which the panel sits under), plus any popover. */
function useReportSize(root: React.RefObject<HTMLDivElement | null>) {
  const last = useRef('')
  const report = () => {
    const el = root.current
    if (!el) return
    // Layout sizes, not getBoundingClientRect: a popover's opening scale must not shrink the window under it.
    const bottom = (e: HTMLElement) => {
      let y = e.offsetHeight
      for (let n: HTMLElement | null = e; n && n !== el; n = n.offsetParent as HTMLElement | null) y += n.offsetTop
      return y
    }
    const flow = el.offsetHeight
    let h = flow
    // Room below for its shadow: Meeting options' reaches 24 + 60 px.
    el.querySelectorAll<HTMLElement>('.popover').forEach((p) => (h = Math.max(h, bottom(p) + (p.classList.contains('options') ? 84 : 16))))
    const tip = document.querySelector<HTMLElement>('.tip') // fixed, outside the island: offsetTop is from the window's top
    if (tip) h = Math.max(h, tip.offsetTop + tip.offsetHeight + 6)
    const size = { w: el.offsetWidth, h, flow }
    const k = JSON.stringify(size)
    if (k === last.current) return
    last.current = k
    glint.send('window:bar-size', size)
  }
  useLayoutEffect(report) // every render: a state change can add or drop a control, a popover or the tray
  useEffect(() => {
    const ro = new ResizeObserver(report) // and late changes, like a font loading
    if (root.current) ro.observe(root.current)
    // A tooltip comes and goes outside this component, and is placed after it renders.
    const mo = new MutationObserver(report)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
    return () => (ro.disconnect(), mo.disconnect())
  }, [])
}

/** The humanizer's switch exists only while a service is connected (Settings still shows it, to arrange). */
const usable = (s: State, id: CapsuleItem) => id !== 'humanize' || s.humanizer.service !== 'none'

/** Items a failure hides, wherever they sit. */
const CALM = new Set<CapsuleItem>(['activity', 'mode', 'screen', 'invisible', 'room', 'labels'])
/** The control Try it teaches shows on the capsule even when the user hid it. */
const TAUGHT: Record<NonNullable<State['teach']>, CapsuleItem> = { start: 'session', stop: 'session', ask: 'ask', invisible: 'invisible' }

function layout(s: State) {
  const taught = s.teach && TAUGHT[s.teach]
  if (!taught || !s.capsule.hidden.includes(taught)) return s.capsule
  return { shown: [...s.capsule.shown, taught], hidden: s.capsule.hidden.filter((id) => id !== taught) }
}

/** What an item needs to draw itself. `preview`: Settings' layout wells, drawn idle and never acted on. */
interface ItemCtx {
  s: State
  mode?: { open: boolean; onToggle: () => void; onClose: () => void }
  preview?: boolean
}

/** One movable capsule item, the same on the capsule, in Meeting options and in Settings' preview. */
export function CapsuleItemView({ id, c }: { id: CapsuleItem; c: ItemCtx }) {
  const { s } = c
  const live = !!s.session
  const paused = live && s.pause.paused
  const streaming = s.chat.isStreaming
  const key = (a: keyof State['shortcuts']) => prettyAccelerator(s.shortcuts[a], isMac)
  switch (id) {
    case 'activity':
      return streaming ? <span className="answering">Answering…</span>
        : paused ? <span className="chip quiet">Not listening</span>
        : (live || c.preview) && (
          <span className="voice-dots" aria-label="Voice activity">
            <span className={s.voiceActivity.me ? 'on' : ''} data-tip="Lights up while your mic hears you"><i />Me</span>
            <span className={s.voiceActivity.them ? 'on' : ''} data-tip="Lights up while the other side is talking"><i />Them</span>
          </span>
        )
    case 'mode':
      return <ModeChip s={s} {...(c.mode ?? { open: false, onToggle: () => {}, onClose: () => {} })} />
    case 'screen': {
      const on = s.screenContext === 'on'
      return (
        <button className={`circle toggle ${on ? 'on' : ''}`} aria-label="Screen context" aria-pressed={on}
          data-tip={on ? 'Screen context on: each ask sends a screenshot' : "Screen context off: asks don't send a screenshot"}
          onClick={() => patch({ screenContext: on ? 'off' : 'on' })}>
          <Icon name="screen" filled={on} />
        </button>
      )
    }
    case 'humanize': {
      if (!usable(s, id) && !c.preview) return null
      const on = s.humanizer.on && usable(s, id)
      const by = s.humanizer.service === 'none' ? 'a humanizer service' : HUMANIZER_LABELS[s.humanizer.service]
      return (
        <button className={`circle toggle ${on ? 'on' : ''}`} aria-label="Humanizer" aria-pressed={on}
          data-tip={on ? `Humanizer on: ${by} rewrites each answer before it shows (slower)` : 'Humanizer off: answers come straight from the model'}
          onClick={() => patch({ humanizer: { on: !on } })}>
          <Icon name="person" filled={on} />
        </button>
      )
    }
    case 'invisible':
      return (
        <button className={`circle toggle ${s.isInvisible ? 'on' : 'ringed'} ${s.teach === 'invisible' ? 'teach' : ''}`} aria-label="Invisible mode" aria-pressed={s.isInvisible}
          data-tip={(s.isInvisible ? 'Invisible mode on: hidden from screen sharing and recordings' : 'Invisible mode off: Glint shows up in screen shares')
            + (s.shortcuts.toggleInvisible ? ` (${key('toggleInvisible')})` : '')}
          onClick={() => patch({ isInvisible: !s.isInvisible })}>
          <Icon name={s.isInvisible ? 'eyeOff' : 'eye'} />
        </button>
      )
    case 'room': {
      const canRoom = s.voiceprint === 'enrolled'
      const room = s.roomMode && canRoom
      return (
        <button className={`circle toggle ${room ? 'on' : ''}`} aria-label="Room mode" aria-pressed={room}
          data-tip={!canRoom ? 'Room mode: record your voice first (opens Settings)' : room ? 'Room mode on: one mic hears everyone in the room' : 'Room mode off: the mic is you'}
          onClick={() => (canRoom ? patch({ roomMode: !room }) : glint.send('window:open-settings', 'voice'))}>
          <Icon name="people" filled={room} />
        </button>
      )
    }
    case 'labels':
      return (
        <button className={`circle toggle ${s.speakerLabels ? 'on' : ''}`} aria-label="Speaker labels" aria-pressed={s.speakerLabels}
          data-tip={s.speakerLabels ? 'Telling voices apart: each speaker gets their own label' : 'Not telling voices apart: everyone else is "Them"'}
          onClick={() => patch({ speakerLabels: !s.speakerLabels })}>
          <Icon name="tag" filled={s.speakerLabels} />
          {s.namePrompt && <i className="badge" />}
        </button>
      )
    case 'session': {
      const pauseKey = s.shortcuts.togglePause ? ` (${key('togglePause')})` : ''
      return (
        <>
          {live ? (
            <>
              {paused ? (
                <button className="circle toggle on" aria-label="Resume listening" data-tip={`Resume listening${pauseKey}`} onClick={() => glint.send('session:toggle-pause')}><Icon name="play" size={13} /></button>
              ) : (
                <button className="circle pause" aria-label="Pause" data-tip={`Pause listening; the timer stops too${pauseKey}`} onClick={() => glint.send('session:toggle-pause')}><Icon name="pause" /></button>
              )}
              <button className={`circle stop ${s.teach === 'stop' ? 'teach' : ''}`} aria-label="Stop session" data-tip="End the session; notes are written for History" onClick={() => glint.send('session:stop')}>
                <Icon name="stop" size={12} />
              </button>
            </>
          ) : (
            <>
              <button className={`circle ${s.teach === 'start' ? 'teach' : ''}`} aria-label="Start session" data-tip={`Start a session (${key('toggleSession')}): transcribe the call as it happens`} onClick={() => glint.send('session:start')}>
                <Icon name="mic" />
              </button>
              {(s.lastSessionId || c.preview) && (
                <button className="circle" aria-label="Resume last session" data-tip="Resume your last session where it stopped" onClick={() => glint.send('session:resume')}><Icon name="history" /></button>
              )}
            </>
          )}
        </>
      )
    }
    case 'chat': {
      const shown = s.overlayVisible && s.chat.visible
      return (
        <button className={`circle toggle ${shown ? 'on' : ''}`} aria-label="Chat box" aria-pressed={shown}
          data-tip={shown ? 'Hide the chat panel' : 'Open the chat box to type a question'} onClick={() => glint.send('chat:toggle')}>
          <Icon name="chat" filled={shown} />
        </button>
      )
    }
    case 'ask':
      // One pill that morphs between Ask and Stop.
      return (
        <button className={`pill ask ${streaming ? 'stopping' : ''} ${s.teach === 'ask' && !streaming ? 'teach' : ''}`}
          data-tip={streaming ? 'Stop the reply' : 'Ask about your screen and the conversation'} onClick={() => glint.send(streaming ? 'chat:stop' : 'chat:ask')}>
          <span key={streaming ? 'stop' : 'ask'} className="pill-label">{streaming ? <><i className="stop-glyph" />Stop</> : 'Ask'}</span><kbd>{key('ask')}</kbd>
        </button>
      )
    default:
      return <span className="divider" />
  }
}

function ModeChip({ s, open, onToggle, onClose }: { s: State; open: boolean; onToggle: () => void; onClose: () => void }) {
  const active = s.modes.find((m) => m.id === s.activeModeId)
  const pick = (id: string | null) => (patch({ activeModeId: id }), onClose())
  return (
    <span className="mode-chip-wrap">
      <button className="chip mode" aria-haspopup="menu" aria-expanded={open} data-tip={open ? undefined : 'Mode: changes how Glint answers'} onClick={onToggle}>
        <span>{active?.name || 'General'}</span><Icon name="chevron" size={16} />
      </button>
      <Presence open={open}>{(closing) => (
        <div className={`popover menu ${closing ? 'closing' : ''}`} role="menu">
          {[{ id: null, name: 'General' }, ...s.modes].map((m) => (
            <button key={m.id ?? 'general'} role="menuitemradio" aria-checked={s.activeModeId === m.id} onClick={() => pick(m.id)}>
              <span className="check">{s.activeModeId === m.id && <Icon name="check" size={13} />}</span>{m.name || 'Untitled mode'}
            </button>
          ))}
          <hr />
          <button role="menuitem" onClick={() => (onClose(), glint.send('window:open-settings', 'modes'))}>
            <span className="check" />Manage modes…
          </button>
        </div>
      )}</Presence>
    </span>
  )
}

/** Languages offered here and in Settings; the one in use is added if it isn't among them. */
const LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'fi', 'pl', 'cs', 'tr', 'ru', 'uk', 'ar', 'he', 'hi', 'ja', 'ko', 'zh']
const languageName = (code: string) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}
export const languageOptions = (current: string) =>
  (LANGUAGES.includes(current) ? LANGUAGES : [current, ...LANGUAGES]).map((c) => <option key={c} value={c}>{languageName(c)} · {c}</option>)

/** Tier 2: what changes per meeting, gathered in one sheet under the tune button. */
function MeetingOptions({ c, hidden, more: moved, closing, onClose }: { c: ItemCtx; hidden: CapsuleItem[]; more: CapsuleItem[]; closing: boolean; onClose: () => void }) {
  const { s } = c
  const updateReady = s.update.status === 'available'
  const more = moved.filter((id) => id !== 'mode')
  const lang = s.transcription.language
  const [min, max, step] = OPACITY_RANGES.background
  return (
    <div className={`popover options ${s.isInvisible ? '' : 'on-share'} ${closing ? 'closing' : ''}`} role="dialog" aria-label="Meeting options">
      <div className="options-head"><b>Meeting options</b><span>this call</span></div>
      {more.length > 0 && <div className="more-controls" aria-label="More controls">{more.map((id) => <CapsuleItemView key={id} id={id} c={c} />)}</div>}
      <div className="opt layout">
        <span>Layout</span>
        <Segmented<State['layout']> label="Layout" value={s.layout} onChange={(layout) => patch({ layout })}
          options={[{ value: 'full', label: 'Full' }, { value: 'glance', label: 'Glance' }, { value: 'ghost', label: 'Ghost' }]} />
      </div>
      <Switch label="Discreet" checked={s.discreet} onChange={(v) => patch({ discreet: v })} />
      <Switch label="Glance auto-answers" checked={s.glance.autoAnswer} disabled={s.layout !== 'glance'} onChange={(v) => patch({ glance: { autoAnswer: v } })} />
      <div className="opt">
        <span>Copy replies</span>
        <Segmented<AutoCopy> label="Copy replies" value={s.autoCopy} onChange={(autoCopy) => patch({ autoCopy })}
          options={[{ value: 'off', label: 'Off' }, { value: 'reply', label: 'Reply' }, { value: 'code', label: 'Code' }]} />
      </div>
      <hr />
      {hidden.includes('mode') && (
        <label className="opt">
          <span className="opt-label"><Icon name="layers" />Mode</span>
          <select value={s.activeModeId ?? ''} onChange={(e) => patch({ activeModeId: e.target.value || null })}>
            <option value="">General</option>
            {s.modes.map((m) => <option key={m.id} value={m.id}>{m.name || 'Untitled mode'}</option>)}
          </select>
        </label>
      )}
      <label className="opt">
        <span className="opt-label"><Icon name="translate" />Spoken language</span>
        <select value={lang} onChange={(e) => void glint.invoke('session:language', e.target.value)}>
          {languageOptions(lang)}
        </select>
      </label>
      <label className="opt">
        <span className="opt-label"><Icon name="bolt" />AI provider</span>
        <select value={s.ai.provider} onChange={(e) => {
          const provider = e.target.value as AiProvider
          // As in Settings: the old first stays in the chain, just lower, and a CLI model name means nothing to the other CLI.
          const fallbacks = [s.ai.provider, ...s.ai.fallbacks.filter((f) => f !== provider && f !== s.ai.provider)]
          void patch({ ai: { provider, fallbacks, cliModel: '', cliSmartModel: '' } })
        }}>
          {AI_PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
        </select>
      </label>
      <label className="opt stacked">
        <span>Note on screenshots</span>
        <DraftTextarea value={s.screenshotNote.text} rows={2} maxLength={NOTE_MAX} placeholder="Context for every screenshot sent to the AI"
          onMouseDown={wantFocus} onSave={(text) => patch({ screenshotNote: { text } })} />
      </label>
      <label className="opt">
        <span>Opacity</span>
        <input type="range" min={min} max={max} step={step} value={s.opacity.background} onChange={(e) => patch({ opacity: { background: Number(e.target.value) } })}
          style={{ '--fill': `${((s.opacity.background - min) / (max - min)) * 100}%` } as React.CSSProperties} />
        <output>{Math.round(s.opacity.background * 100)}%</output>
      </label>
      <hr />
      <button className="opt-settings" onClick={() => (onClose(), glint.send('window:open-settings', updateReady ? 'general' : undefined))}>
        <Icon name="gear" size={14} />All settings…{updateReady && <i className="badge update" aria-label="update available" />}<kbd>{s.shortcuts.openSettings ? prettyAccelerator(s.shortcuts.openSettings, isMac) : ''}</kbd>
      </button>
    </div>
  )
}

function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`opt ${disabled ? 'disabled' : ''}`}>
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

function FailLine({ line }: { line: string }) {
  const [what, instead] = splitFailure(line)
  return <span><b>{what}</b>{instead && ` · ${instead}`}</span>
}

/** A call just started: take notes on it? "Turn off" stops these offers (Settings → General). */
function CallTray({ s, app }: { s: State; app: string }) {
  return (
    <div className={`tray surface call-tray ${s.isInvisible ? '' : 'on-share'} ${s.discreet ? 'faded' : ''}`} role="status">
      <Icon name="mic" size={14} />
      <span className="tray-q"><b>{app}</b> call started</span>
      <button className="chip accent" onClick={() => glint.send('session:start')}>Take notes</button>
      <button className="chip plain" onClick={() => glint.send('call:dismiss')}>Not now</button>
      <button className="chip plain" data-tip="Stop offering. Turn it back on in Settings → General" onClick={() => patch({ meetingPrompt: false })}>Turn off</button>
    </div>
  )
}

/** "Who's Speaker 2?": a voice heard enough to be worth saving. Play a clip, type or guess a name, or skip it. */
function NameTray({ s, prompt }: { s: State; prompt: NonNullable<State['namePrompt']> }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const act = (p: Promise<unknown>) => void p.catch((err: Error) => setError(err.message))
  const player = usePlayback()
  const on = player.playing === prompt.id
  return (
    <form className={`tray surface ${s.isInvisible ? '' : 'on-share'} ${s.discreet && !(s.aiFailure ?? s.audioError) ? 'faded' : ''}`}
      onSubmit={(e) => (e.preventDefault(), name.trim() && act(glint.invoke('voice:name', prompt.id, name)))}>
      <span className="tray-q">Who's <b>{prompt.label}</b>?</span>
      <button type="button" className={`circle small ${on ? 'playing' : ''}`} aria-label={on ? 'Stop' : 'Play their voice'} data-tip={on ? 'Stop' : `Hear ${prompt.label} (${prompt.seconds} s)`}
        onClick={() => act(player.toggle(prompt.id))}>
        <Icon name={on ? 'pause' : 'play'} />
      </button>
      <input type="text" placeholder="Name…" aria-label="Their name" maxLength={40} value={name} onMouseDown={wantFocus} onChange={(e) => setName(e.target.value)} />
      <GuessButton id={prompt.id} className="chip accent" onGuess={(guess, note) => (guess ? setName(guess) : setError(note))} />
      {name.trim() && <button type="submit" className="chip">Save</button>}
      <button type="button" className="chip plain" onClick={() => act(glint.invoke('voice:skip', prompt.id))}>Not now</button>
      {error && <span className="tray-error" role="alert">{error}</span>}
    </form>
  )
}
