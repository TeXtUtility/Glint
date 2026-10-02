import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { HUMANIZER_LABELS, type HumanizeStatus } from '../../shared/humanize'
import { typeable } from '../../shared/markdown'
import { ghostHints, type State } from '../../shared/state'
import { FIELD, TypingEngine } from '../../shared/typing'
import { glint, isMac, opacityStyle, patch } from './glint'
import { Icon } from './icons'

/** Characters in the strip, and how many of them are already typed: the Ghost app's 18 and 5. */
const WINDOW = 18
const LEAD = 5
/** The hover card shows this much of a long answer around the cursor. */
const CARD_BEFORE = 160
const CARD_AFTER = 360

type Key = { type: 'text'; text: string } | { type: 'backspace' }
interface GhostReply { id: string; text: string; done?: boolean; hz?: HumanizeStatus }

/**
 * Ghost: the corner strip shows an answer to type out by hand in any app, a few characters at a time, moving along
 * as the user types it (main watches the keys). The answer appears only once it's complete, humanized or not, so the
 * text never changes under the user's typing. Its keys are the app's shortcuts (Settings → Shortcuts → Ghost), and
 * the hover card lists them as set. Pointing at it shows the whole answer.
 */
export function GhostPill({ s, replies, error, onOpen, onAsk }: {
  s: State; replies: GhostReply[]; error: string | null; onOpen: () => void; onAsk: (question: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const engine = useRef(new TypingEngine()).current
  engine.autoSkip = s.ghostAutoSkip
  const [, render] = useReducer((n: number) => n + 1, 0)
  /** Which answer is shown; null follows the latest. */
  const [index, setIndex] = useState<number | null>(null)
  /** The question being typed into Glint's own box, or null when it's closed. */
  const [question, setQuestion] = useState<string | null>(null)
  const dragging = useRef(false)
  const live = useRef({ asking: false, count: 0 })
  live.current = { asking: question !== null, count: replies.length }

  const at = Math.min(index ?? replies.length - 1, replies.length - 1)
  const reply = replies[at]
  // Nothing to type until the whole answer is in: a streaming answer would shift under the user's typing.
  const text = useMemo(() => (reply?.done ? typeable(reply.text) : ''), [reply?.text, reply?.done])
  // Each answer remembers the user's place when browsing away and back.
  const places = useRef(new Map<string, number>())
  const shown = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (shown.current && shown.current !== reply?.id) places.current.set(shown.current, engine.position)
    const other = shown.current !== reply?.id
    engine.setText(text)
    if (other && reply) engine.position = Math.min(places.current.get(reply.id) ?? 0, engine.total)
    shown.current = reply?.id
    render()
  }, [text, reply?.id])
  useEffect(() => setIndex(null), [replies.length]) // a new answer takes over from browsing

  useEffect(() => {
    const offs = [
      glint.on('ghost:key', (k: Key) => {
        if (live.current.asking) return // keys typed into Glint's own box aren't the answer being typed
        if (k.type === 'backspace') engine.backspace()
        else for (const c of k.text) engine.handle(c)
        render()
      }),
      glint.on('ghost:word', (d: number) => {
        if (d > 0) engine.nextWord()
        else engine.prevWord()
        render()
      }),
      glint.on('ghost:browse', (d: number) =>
        setIndex((i) => {
          const last = live.current.count - 1
          const next = Math.max(0, Math.min(last, (i ?? last) + d))
          return next === last ? null : next
        }),
      ),
      glint.on('ghost:prompt', () => setQuestion('')),
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // Main sizes the window to exactly this content.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const send = () => {
      const r = el.getBoundingClientRect()
      glint.send('window:glance-size', { w: Math.ceil(r.width), h: Math.ceil(r.height) })
    }
    send()
    const ro = new ResizeObserver(send)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // A failed rewrite still leaves the original to type: the strip turns red around it, and the card says why.
  const hzFailed = reply?.hz?.stage === 'failed' && !error
  const problem = error ?? s.aiFailure
  const hz = reply?.hz && !reply.done ? reply.hz : null
  const needsKeys = isMac && !s.keysAllowed
  const thinking = s.chat.isStreaming && !text
  const top = s.glance.corner.startsWith('top')
  const browsing = index !== null && replies.length > 1
  const stop = (e: React.SyntheticEvent) => e.stopPropagation() // clicks in here mustn't open the panel

  // Closing the box hands the keys back to the user's app, where the answer is typed.
  const closeBox = () => (setQuestion(null), glint.send('window:blur-chat'))
  let body: React.ReactNode
  if (question !== null) {
    body = (
      <form className="ghost-ask" onClick={stop} onSubmit={(e) => {
        e.preventDefault()
        if (question.trim()) onAsk(question.trim())
        closeBox()
      }}>
        <input autoFocus value={question} placeholder="Ask, then type the answer" aria-label="Question"
          onChange={(e) => setQuestion(e.target.value)} onBlur={closeBox}
          onKeyDown={(e) => e.key === 'Escape' && !e.nativeEvent.isComposing && closeBox()} />
      </form>
    )
  } else if (problem && !(hzFailed && text)) {
    body = <span className="glance-text">{problem}</span>
  } else if (needsKeys) {
    body = <button className="link" onClick={(e) => (stop(e), glint.send('keys:request'))}>Allow Glint to follow your typing</button>
  } else if (thinking && hz) {
    body = <><Icon name="person" size={13} /><span className="glance-text">{hz.stage === 'humanizing' ? `Humanizing with ${HUMANIZER_LABELS[hz.service]}…` : 'Replying…'}</span></>
  } else if (thinking) {
    body = <><span className="dot working" /><span className="glance-text">{reply?.text.trim() && !reply.done ? 'Replying…' : 'Thinking…'}</span></>
  } else if (text && !engine.isComplete) {
    body = <Strip engine={engine} />
  } else if (text) {
    body = <span className="glance-text muted">Done</span>
  }

  const card = s.overlayHovered && question === null && (
    <div className="glance-card ghost-card" onClick={onOpen}>
      {text && <CardText engine={engine} />}
      {problem && <p className="error">{problem}</p>}
      {hz && (
        <p className="hz-line"><Icon name="person" size={12} />
          <button className="link" onClick={(e) => (stop(e), patch({ humanizer: { ghost: false } }))}>Stop humanizing in Ghost for faster answers</button>
        </p>
      )}
      <p className="hint">{[...ghostHints(s.shortcuts, isMac), 'click for the full panel'].join(' · ')}</p>
    </div>
  )
  // Dragged like the Ghost app's strip; main tells a click (open the panel) from a drag. Its own links and box keep
  // their clicks.
  const endDrag = () => dragging.current && ((dragging.current = false), glint.send('window:drag-end'))
  const drag = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || (e.target as Element).closest('button, a, input, form')) return
      e.currentTarget.setPointerCapture(e.pointerId)
      dragging.current = true
      glint.send('window:drag-start')
    },
    onPointerUp: endDrag,
    onLostPointerCapture: endDrag,
  }
  const strip = (
    <div className={`glance-strip ghost-strip ${body ? '' : 'dot-only'} ${problem ? 'failing' : ''}`} {...(question === null && drag)}>
      {body ?? <span className="dot ring off" title={`Ghost: ${ghostHints(s.shortcuts, isMac)[0] ?? 'set an Ask shortcut in Settings → Shortcuts'}`} />}
      {text && !engine.isComplete && question === null && <Ring progress={engine.progress} />}
      {browsing && <span className="ghost-index">{at + 1}/{replies.length}</span>}
    </div>
  )

  return (
    <div ref={ref} className={`glance ghost ${s.glance.corner} ${s.isInvisible ? '' : 'on-share'} ${s.overlayHovered ? 'hovered' : ''} ${problem ? 'failing' : ''}`}
      style={{ ...opacityStyle(s.opacity), '--ghost-font': `${s.ghostFontSize}px`, '--ghost-opacity': s.ghostOpacity } as React.CSSProperties}>
      {top ? <>{strip}{card}</> : <>{card}{strip}</>}
    </div>
  )
}

/** Ghost's progress ring: a faint track, and an arc from the top that fills as the answer is typed. */
function Ring({ progress }: { progress: number }) {
  const r = 7
  const length = 2 * Math.PI * r
  return (
    <svg className="ghost-ring" width="17" height="17" viewBox="0 0 17 17" role="img" aria-label={`${Math.floor(progress * 100)}% typed`}>
      <circle cx="8.5" cy="8.5" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <circle cx="8.5" cy="8.5" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={`${length * Math.max(0, Math.min(1, progress))} ${length}`} transform="rotate(-90 8.5 8.5)" />
    </svg>
  )
}

/** The answer around the cursor, typed part dim: in a long answer, the part being typed rather than the start. */
function CardText({ engine }: { engine: TypingEngine }) {
  const { chars, position } = engine
  const from = Math.max(0, position - CARD_BEFORE)
  const to = Math.min(chars.length, position + CARD_AFTER)
  return (
    <p className="ghost-full">
      {from > 0 && '…'}
      <span className="typed">{chars.slice(from, position).join('')}</span>
      {chars.slice(position, to).join('')}
      {to < chars.length && '…'}
    </p>
  )
}

/** A window of the answer around the cursor: typed characters dim, the next one underlined (red while wrong). */
function Strip({ engine }: { engine: TypingEngine }) {
  const { chars, position } = engine
  const start = Math.max(0, Math.min(position - LEAD, chars.length - WINDOW))
  const wrong = engine.pendingMismatches > 0
  return (
    <span className="ghost-text">
      {chars.slice(start, start + WINDOW).map((c, i) => {
        const k = start + i
        const state = k < position ? 'typed' : k === position ? `cursor${wrong ? ' wrong' : ''}` : 'ahead'
        // Return and Tab show as keys to press; a space stays visible as a gap.
        const glyph = c === '\n' ? '⏎' : c === FIELD ? '⇥' : c === ' ' ? ' ' : c
        return <span key={k} className={`${state}${c === '\n' || c === FIELD ? ' key' : ''}`}>{glyph}</span>
      })}
    </span>
  )
}
