import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { plainLine } from '../../shared/markdown'
import type { State } from '../../shared/state'
import { glint, opacityStyle } from './glint'
import { Icon } from './icons'
import { Markdown } from './Markdown'

const DIM_AFTER_MS = 8_000
const COLLAPSE_AFTER_MS = 60_000

export interface Cue {
  id: string
  text: string
  /** Top line: who asked what, for automatic answers; otherwise the model and how it was asked. */
  meta?: string
  done: boolean
  /** When the reply finished (or started, while it streams). */
  at: number
}

/**
 * The overlay shrunk to a corner: a dot, or one still line of the latest answer. Nothing moves or pulses; the only
 * change is new text. Pointing at it shows the whole answer; clicking opens the full panel.
 */
export function Glance({ s, cue, error, onOpen, children }: {
  s: State; cue: Cue | null; error: string | null; onOpen: () => void; children?: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [, rerender] = useState(0)

  // Re-render when the current answer should dim, and when it should collapse back to the dot.
  useEffect(() => {
    if (!cue?.done) return
    const age = Date.now() - cue.at
    const timers = [DIM_AFTER_MS, COLLAPSE_AFTER_MS].filter((t) => t > age).map((t) => setTimeout(() => rerender((n) => n + 1), t - age + 50))
    return () => timers.forEach(clearTimeout)
  }, [cue?.id, cue?.done])

  // Main sizes the window to exactly this content.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const send = () => {
      const r = el.getBoundingClientRect()
      // Only the strip's own text animates the window; the hover card and Reduce Motion snap it.
      const animate = !el.querySelector('.glance-card') && !matchMedia('(prefers-reduced-motion: reduce)').matches
      glint.send('window:glance-size', { w: Math.ceil(r.width), h: Math.ceil(r.height), animate })
    }
    send()
    const ro = new ResizeObserver(send)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const age = cue ? Date.now() - cue.at : Infinity
  const line = cue ? plainLine(cue.text) : ''
  const showing = !!line && age < COLLAPSE_AFTER_MS
  const problem = error ?? s.audioError ?? s.aiFailure
  const dot = problem ? 'error' : s.chat.isStreaming ? 'working' : !s.session ? 'ring off' : s.pause.paused ? 'ring' : 'live'
  const hovered = s.overlayHovered
  const dim = showing && !!cue?.done && age > DIM_AFTER_MS
  const top = s.glance.corner.startsWith('top')

  const card = hovered && (cue?.text || problem || s.namePrompt) && (
    <div className="glance-card">
      {cue?.meta && <p className="meta">{cue.meta}</p>}
      {cue?.text && <div className="a"><Markdown text={cue.text} /></div>}
      {problem && <p className="error">{problem}</p>}
      {s.namePrompt && <p className="name-row"><Icon name="people" /><span><b>{s.namePrompt.label}</b> is waiting to be named</span><small>click to name</small></p>}
      {!s.namePrompt && <p className="hint">Click to open the full panel</p>}
    </div>
  )
  // The inactivity countdown takes the strip's place, and has its own button: clicking it mustn't also open the panel.
  const strip = children ? <div onClick={(e) => e.stopPropagation()}>{children}</div> : (
    // A failure is never just a dot: the strip turns red and says what went wrong, over any answer. The dot stays at
    // the corner end.
    <div className={`glance-strip ${showing || problem ? '' : 'dot-only'} ${problem ? 'failing' : ''}`} title={showing || problem ? undefined : dotTitle(dot)}>
      <span className={`dot ${dot}`} />
      {problem ? <span className="glance-text">{problem}</span> : showing && <span key={cue!.id} className="glance-text">{line}</span>}
    </div>
  )

  return (
    <div ref={ref} className={`glance ${s.glance.corner} ${s.isInvisible ? '' : 'on-share'} ${hovered ? 'hovered' : ''} ${dim && !problem && !children ? 'dim' : ''} ${problem ? 'failing' : ''}`} style={opacityStyle(s.opacity)} onClick={onOpen}>
      {top ? <>{strip}{card}</> : <>{card}{strip}</>}
    </div>
  )
}

function dotTitle(dot: string) {
  return { error: 'Something went wrong. Point here to see it.', working: 'Working on an answer…', 'ring off': 'No session', ring: 'Session paused', live: 'Listening' }[dot]
}
