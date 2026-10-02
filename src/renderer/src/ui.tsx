// Motion components ported from GodUI (godui.design) into plain React + styles.css: no Tailwind or animation library.
// Their springs are reproduced as CSS linear() easings (--spring-* in styles.css).
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { glint } from './glint'

const TIP_DELAY_MS = 500
/** Right after a tip hides, the next one shows at once, so sliding along a toolbar reads each button. */
const TIP_WARM_MS = 300

/**
 * Hover anything with `data-tip` for a moment to see its short description. One per window (mounted in main.tsx).
 * Found from the pointer position rather than event targets, so disabled buttons can still say why they're disabled.
 * The overlays belong to a background app, which macOS sends no hover events, so main also reports the pointer there.
 */
export function Tooltips() {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let target: HTMLElement | null = null
    let visible = false
    let timer = 0
    let warmUntil = 0
    const hide = () => {
      clearTimeout(timer)
      if (!visible) return
      visible = false
      warmUntil = Date.now() + TIP_WARM_MS
      setTip(null)
    }
    const pointAt = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y)
      const el = hit?.closest('.faded') ? null : hit?.closest<HTMLElement>('[data-tip]') ?? null // discreet: nothing shows on hover
      if (el !== target) {
        hide()
        target = el
        if (!el) return
        const open = () => {
          if (!el.dataset.tip || !el.isConnected) return
          visible = true
          setTip({ text: el.dataset.tip, rect: el.getBoundingClientRect() })
        }
        if (Date.now() < warmUntil) open()
        else timer = window.setTimeout(open, TIP_DELAY_MS)
      }
    }
    // Clicking hides the tip until the pointer moves to something else, like the native one.
    const onDown = () => hide()
    const onLeave = () => (hide(), (target = null))
    const onMove = (e: PointerEvent) => pointAt(e.clientX, e.clientY)
    const offPointer = glint.on('pointer:at', (p: { x: number; y: number } | null) => (p ? pointAt(p.x, p.y) : onLeave()))
    // Only a scroll that moves the hovered element: a reply streaming into the chat mustn't hide a toolbar tip.
    const onScroll = (e: Event) => target && e.target instanceof Node && e.target.contains(target) && hide()
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onDown, true)
    document.addEventListener('scroll', onScroll, true)
    document.documentElement.addEventListener('pointerleave', onLeave)
    window.addEventListener('blur', onLeave)
    return () => {
      clearTimeout(timer)
      offPointer()
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onDown, true)
      document.removeEventListener('scroll', onScroll, true)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('blur', onLeave)
    }
  }, [])

  // Above the element, or below when there's no room; kept inside the window, which is all an overlay has.
  useLayoutEffect(() => {
    const el = box.current
    if (!tip || !el) return
    const { rect } = tip
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.max(4, Math.min(innerWidth - w - 4, rect.left + rect.width / 2 - w / 2))
    const below = rect.top - h - 8 < 0
    el.style.left = `${left}px`
    el.style.top = `${below ? rect.bottom + 8 : rect.top - h - 8}px`
    el.style.setProperty('--arrow-x', `${rect.left + rect.width / 2 - left}px`)
    el.classList.toggle('below', below)
  }, [tip])

  if (!tip) return null
  return <div ref={box} className="tip" role="tooltip">{tip.text}</div>
}

/** iOS-style selector: a pill springs between the options. `value` null shows none selected. */
export function Segmented<T extends string>({ label, value, options, onChange, tabs }: {
  label: string
  value: T | null
  options: { value: T; label: ReactNode; tip?: string }[]
  onChange: (v: T) => void
  /** Tabs switch views (role tab); otherwise it's a choice (role radio). */
  tabs?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[data-on]')
    setPill(el ? { left: el.offsetLeft, width: el.offsetWidth } : null)
  }, [value, options.length])
  return (
    <div className="segmented" role={tabs ? 'tablist' : 'radiogroup'} aria-label={label} ref={ref}>
      {/* Mounted fresh when a selection appears, so it shows in place instead of sliding from the left. */}
      {pill && <span className="segmented-pill" aria-hidden="true" style={{ transform: `translateX(${pill.left}px)`, width: pill.width }} />}
      {options.map((o) => {
        const on = o.value === value
        return (
          <button key={o.value} type="button" role={tabs ? 'tab' : 'radio'} {...(tabs ? { 'aria-selected': on } : { 'aria-checked': on })}
            data-on={on || undefined} data-tip={o.tip} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

const HOLD_MS = 900

/**
 * Press and hold to confirm a destructive action: a fill sweeps across and commits at 100%; letting go early springs
 * it back. Space or Enter held down works too. A quick click says to hold instead.
 * Not confirm(): native dialogs are separate OS windows that invisible mode can't hide from a screen share.
 */
/** `quiet`: plain text at rest, a red pill only while held. */
export function ConfirmButton({ label, confirmLabel, onConfirm, quiet }: { label: string; confirmLabel: string; onConfirm: () => void; quiet?: boolean }) {
  const [status, setStatus] = useState<'idle' | 'holding' | 'hint' | 'done'>('idle')
  const timer = useRef(0)
  const startedAt = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])

  const start = () => {
    if (status === 'holding' || status === 'done') return
    clearTimeout(timer.current)
    startedAt.current = Date.now()
    setStatus('holding')
    timer.current = window.setTimeout(() => {
      setStatus('done')
      onConfirm()
      timer.current = window.setTimeout(() => setStatus('idle'), 1100)
    }, HOLD_MS)
  }
  const cancel = () => {
    if (status !== 'holding') return
    clearTimeout(timer.current)
    const tapped = Date.now() - startedAt.current < 250
    setStatus(tapped ? 'hint' : 'idle')
    if (tapped) timer.current = window.setTimeout(() => setStatus('idle'), 1500)
  }
  const isKey = (k: string) => k === ' ' || k === 'Enter'

  // Every label shares one grid cell, so the button is as wide as the longest and never jumps.
  const labels = { idle: label, holding: confirmLabel, hint: 'Hold to confirm', done: 'Done' }
  return (
    <button type="button" className={`hold ${quiet ? 'quiet' : ''}`} data-status={status} data-tip={`Press and hold: ${confirmLabel}`}
      onPointerDown={(e) => e.button === 0 && start()} onPointerUp={cancel} onPointerLeave={cancel} onPointerCancel={cancel}
      onKeyDown={(e) => isKey(e.key) && (e.preventDefault(), !e.repeat && start())} onKeyUp={(e) => isKey(e.key) && cancel()}>
      <span className="hold-fill" aria-hidden="true" />
      <span className="hold-labels">
        {(Object.keys(labels) as (keyof typeof labels)[]).map((k) => (
          <span key={k} className={k === status ? 'on' : ''} aria-hidden={k !== status || undefined}>
            {k === 'done' && <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path pathLength={1} d="M5 12.5 10 17.5 19 7" /></svg>}
            {labels[k]}
          </span>
        ))}
      </span>
      {status === 'idle' && <span className="visually-hidden"> (press and hold)</span>}
    </button>
  )
}

const SWIPE_PX = 80
const SWIPE_PX_PER_S = 500

/** A notice that springs in; with `onDismiss`, swipe it sideways to dismiss (GodUI's toast, kept in the panel's flow). */
export function Toast({ children, onDismiss, className = '', ...rest }: {
  children: ReactNode; onDismiss?: () => void; className?: string; role?: string
}) {
  const drag = useRef<{ x: number; t: number } | null>(null)
  const [dx, setDx] = useState(0)
  const [leaving, setLeaving] = useState(0) // -1 or 1 while flying out

  const end = (x: number) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const moved = x - d.x
    const speed = Math.abs(moved) / Math.max(1, Date.now() - d.t) * 1000
    if (onDismiss && (Math.abs(moved) > SWIPE_PX || speed > SWIPE_PX_PER_S)) {
      setLeaving(Math.sign(moved) || 1)
      setTimeout(onDismiss, 200)
    } else setDx(0)
  }

  return (
    <div {...rest} className={`banner toast ${onDismiss ? 'swipeable' : ''} ${drag.current ? 'dragging' : ''} ${className}`}
      style={leaving ? { transform: `translateX(${leaving * 110}%)`, opacity: 0 } : dx ? { transform: `translateX(${dx * 0.6}px)` } : undefined}
      onPointerDown={(e) => {
        if (!onDismiss || e.button !== 0 || (e.target as Element).closest('button, input, a, textarea')) return
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, t: Date.now() }
      }}
      onPointerMove={(e) => drag.current && setDx(e.clientX - drag.current.x)}
      onPointerUp={(e) => end(e.clientX)}
      onPointerCancel={() => ((drag.current = null), setDx(0))}>
      {children}
    </div>
  )
}

/** Textarea that saves ~600 ms after typing stops, on blur, and on unmount, so nothing typed is lost. */
export function DraftTextarea({ value, onSave, ...rest }: { value: string; onSave: (v: string) => void } & Omit<ComponentProps<'textarea'>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value)
  const latest = useRef({ draft, value, onSave })
  latest.current = { draft, value, onSave }
  const save = () => {
    if (latest.current.draft !== latest.current.value) latest.current.onSave(latest.current.draft)
  }
  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    const t = setTimeout(save, 600)
    return () => clearTimeout(t)
  }, [draft])
  useEffect(() => save, [])
  return <textarea {...rest} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={save} />
}

/** Renders `children` while open, and for its closing animation after (`closing` true). */
export function Presence({ open, children }: { open: boolean; children: (closing: boolean) => ReactNode }) {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) return setMounted(true)
    const t = setTimeout(() => setMounted(false), 100)
    return () => clearTimeout(t)
  }, [open])
  return open || mounted ? <>{children(!open)}</> : null
}

