import { useEffect, useRef, useState } from 'react'
import {
  isChatId, lineLabel, ownerName, renamed, sessionPeople, transcriptText, type ActionItem, type SavedSession, type SessionSummary,
} from '../../shared/history'
import { elapsedMs, formatElapsed, type State } from '../../shared/state'
import { glint, useTick } from './glint'
import { Icon } from './icons'
import { Markdown } from './Markdown'
import { ConfirmButton, Presence, Segmented } from './ui'

// The overlay only takes key focus on request, so text fields ask main for it before the click lands. Other windows
// focus normally.
const wantFocus = () => void (document.documentElement.dataset.route === 'chat' && glint.invoke('window:focus-chat'))

export const minutes = (ms: number) => (ms < 60_000 ? '<1 min' : `${Math.round(ms / 60_000)} min`)
export const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

export function dayLabel(ms: number) {
  const d = new Date(ms)
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
}

/** An action item's YYYY-MM-DD as "Today", "Tomorrow" or "Fri 2 Oct". */
export function dueLabel(due: string) {
  const [y, m, d] = due.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const today = new Date()
  const days = Math.round((date.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

/** Sessions whose title, summary or a tag matches the search, grouped by day in the order listed. History and the Follow-up window. */
export function byDay(list: SessionSummary[], query: string) {
  const q = query.trim().toLowerCase()
  const days: [string, SessionSummary[]][] = []
  for (const r of list) {
    if (q && ![r.title, r.summary, ...(r.tags ?? [])].some((t) => t?.toLowerCase().includes(q))) continue
    const label = dayLabel(r.startedAt)
    if (days.at(-1)?.[0] === label) days.at(-1)![1].push(r)
    else days.push([label, [r]])
  }
  return days
}

/** What a history row says on its right: live, a chat to continue, notes in progress, or the to-dos left. */
function rowStatus(r: SessionSummary, live: boolean): { label: string; kind: string } | null {
  if (live) return { label: 'Live', kind: 'live' }
  if (isChatId(r.id)) return { label: 'Continue chat', kind: 'plain' }
  if (r.notesStatus === 'processing') return { label: 'Writing notes…', kind: 'plain' }
  if (r.notesStatus === 'failed') return { label: 'Notes failed', kind: 'error' }
  if (!r.actions?.length) return null
  const open = r.actions.filter((a) => !a.done).length
  return open ? { label: `${open} to do`, kind: 'todo' } : { label: 'All done', kind: 'done' }
}

export function Dashboard({ s, openId, setOpenId, onContinue }: {
  s: State; openId: string | null; setOpenId: (id: string | null) => void; onContinue: (r: SavedSession) => void
}) {
  const [list, setList] = useState<SessionSummary[] | null>(null)
  const [unreadable, setUnreadable] = useState(0)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  useTick(!!s.session && !openId) // the live row's time

  useEffect(() => {
    glint.invoke<{ sessions: SessionSummary[]; unreadable: number }>('sessions:list').then((r) => {
      setList(r.sessions)
      setUnreadable(r.unreadable)
    }, (err: Error) => setError(err.message))
  }, [s.historyVersion])

  if (openId) return <SessionDetail key={openId} id={openId} s={s} onBack={() => setOpenId(null)} onContinue={onContinue} />

  // ponytail: everything is local, so no pagination (spec §13 wants 12 per page) until lists get long enough to feel slow.
  const days = byDay(list ?? [], query)

  return (
    <div className="dash">
      <label className="dash-search">
        <Icon name="search" />
        <input type="search" placeholder="Search titles, summaries and tags" aria-label="Search history"
          value={query} onMouseDown={wantFocus} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {error && <p className="error">Couldn't load history: {error}</p>}
      {unreadable > 0 && (
        <p className="muted">
          {unreadable === 1 ? '1 saved session' : `${unreadable} saved sessions`} can't be opened: damaged, or encrypted with a
          keychain key this Mac no longer has. The files are still in Glint's sessions folder.
        </p>
      )}
      {list && !days.length && (
        <p className="empty">{query.trim() ? 'Nothing matches.' : 'Nothing yet. Your chats appear here, and sessions you record appear with notes.'}</p>
      )}
      {days.map(([label, rows]) => (
        <section key={label}>
          <h3 className="day">{label}</h3>
          {rows.map((r) => {
            const status = rowStatus(r, s.session?.id === r.id)
            return (
              <button key={r.id} className="session-row" onClick={() => setOpenId(r.id)}>
                <span className="session-main">
                  <span className="session-title">{r.title || (isChatId(r.id) ? 'Untitled chat' : 'Untitled session')}</span>
                  <span className="session-meta">
                    {time(r.startedAt)} · {isChatId(r.id) ? 'Chat' : s.session?.id === r.id ? `${formatElapsed(elapsedMs(s, Date.now()))} so far` : minutes(r.elapsedMs)}
                    {!!r.tags?.length && <span className="tags">{r.tags.map((t) => <span key={t}>{t}</span>)}</span>}
                  </span>
                </span>
                {status && <span className={`status ${status.kind}`}>{status.label}</span>}
              </button>
            )
          })}
        </section>
      ))}
    </div>
  )
}

type Tab = 'followup' | 'chat' | 'transcript'

/** A saved session or chat. Sessions open on Follow-up: the notes, the to-dos and the email to send. */
function SessionDetail({ id, s, onBack, onContinue }: { id: string; s: State; onBack: () => void; onContinue: (r: SavedSession) => void }) {
  const [r, setR] = useState<SavedSession | null>(null)
  const [error, setError] = useState('')
  const isChat = isChatId(id)
  const [tab, setTab] = useState<Tab>(isChat ? 'chat' : 'followup')
  const [more, setMore] = useState(false)
  // Drafts exist only while editing, so a refetch (notes arriving) never clobbers what's being typed.
  const [title, setTitle] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const moreRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    glint.invoke<SavedSession | null>('session:load', id).then((v) => (v ? setR(v) : onBack()), (err: Error) => setError(err.message))
  }, [id, s.historyVersion])

  // The panel never has key focus, so Esc can't close the ⋯ menu; any click outside does.
  useEffect(() => {
    if (!more) return
    const onDown = (e: PointerEvent) => !moreRef.current?.contains(e.target as Node) && setMore(false)
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [more])

  const save = (fields: { title?: string; summary?: string }) =>
    glint.invoke('sessions:update', id, fields).catch((err: Error) => setError(err.message))

  // Esc or switching views unmounts this without a blur; save whatever is mid-edit.
  const drafts = useRef({ title, summary, r })
  drafts.current = { title, summary, r }
  useEffect(() => () => {
    const d = drafts.current
    const fields: { title?: string; summary?: string } = {}
    if (d.title !== null && d.title.trim() !== (d.r?.title ?? '')) fields.title = d.title
    if (d.summary !== null && d.r && d.summary !== renamed(d.r.summary ?? '', d.r)) fields.summary = d.summary
    if (Object.keys(fields).length) void glint.invoke('sessions:update', id, fields)
  }, [id])

  const back = <button className="back" onClick={onBack}><Icon name="back" size={18} />History</button>
  if (!r) return <div className="dash detail"><div className="detail-bar">{back}</div>{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>
  const live = s.session?.id === id
  const tabs: { value: Tab; label: string }[] = isChat ? [{ value: 'chat', label: 'Chat' }]
    : [{ value: 'followup', label: 'Follow-up' }, { value: 'chat', label: 'Chat' }, { value: 'transcript', label: 'Transcript' }]

  return (
    <div className="dash detail">
      <div className="detail-bar">
        {back}
        {tabs.length > 1 ? <Segmented tabs label="Session view" value={tab} onChange={setTab} options={tabs} /> : <span />}
        <span className="detail-right">
          {!isChat && !live && (
            <button className="open-window" data-tip="Notes, action items and the email for every session, in a window"
              onClick={() => glint.send('window:open-followup', id)}>
              <Icon name="external" />Open window
            </button>
          )}
          <button className="chip resume" disabled={!!s.session}
            data-tip={s.session ? 'Stop the current session first' : isChat ? 'Reopen this chat in the panel and keep asking' : 'Keep recording this session; the timer picks up where it stopped'}
            onClick={() => (isChat ? onContinue(r) : glint.send('session:resume', id))}>
            <Icon name="play" size={11} />{isChat ? 'Continue chat' : 'Resume'}
          </button>
          {!live && (
            <span className="who-wrap" ref={moreRef}>
              <button className="icon-btn" aria-label="More" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore(!more)}><Icon name="more" /></button>
              <Presence open={more}>{(closing) => (
                <div className={`menu more-menu ${closing ? 'closing' : ''}`} role="menu">
                  {r.notesStatus !== 'processing' && (
                    <button role="menuitem" data-tip="Have your AI write the notes again; your ticks, dates, owners and edits are kept"
                      onClick={() => (setMore(false), glint.send('sessions:notes', id))}>
                      <Icon name="refresh" size={13} /> {r.summary ? 'Rewrite notes' : 'Write notes'}
                    </button>
                  )}
                  <ConfirmButton label="Move to Trash" confirmLabel="Move to Trash"
                    onConfirm={() => void glint.invoke('sessions:trash', id).then(onBack, (err: Error) => setError(err.message))} />
                </div>
              )}</Presence>
            </span>
          )}
        </span>
      </div>

      <input className="detail-title" aria-label="Title" placeholder={isChat ? 'Untitled chat' : 'Untitled session'} maxLength={120}
        value={title ?? r.title ?? ''} onMouseDown={wantFocus}
        onFocus={() => setTitle(r.title ?? '')} onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          if (title !== null && title.trim() !== (r.title ?? '')) void save({ title })
          setTitle(null)
        }}
        onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.currentTarget.blur()} />
      <p className="session-meta">
        {dayLabel(r.startedAt)}, {time(r.startedAt)} · {isChat ? 'Chat' : minutes(r.elapsedMs)}{r.mode && ` · ${r.mode}`}
        {!!r.tags?.length && <span className="tags">{r.tags.map((t) => <span key={t}>{t}</span>)}</span>}
      </p>
      {error && <p className="error">{error}</p>}

      {(tab === 'followup' || (isChat && r.summary)) && (
        <>
          {summary !== null ? (
            <>
              <textarea className="detail-summary" autoFocus value={summary} onChange={(e) => setSummary(e.target.value)}
                placeholder="Markdown: **bold**, - bullets, ### headings"
                onBlur={() => {
                  if (summary !== renamed(r.summary ?? '', r)) void save({ summary })
                  setSummary(null)
                }} />
              {summary.trim() && <div className="detail-preview" aria-label="Preview"><Markdown text={summary} /></div>}
            </>
          ) : r.summary ? (
            <div className="summary" role="button" tabIndex={0} data-tip="Click to edit the summary"
              onMouseDown={wantFocus} onClick={() => setSummary(renamed(r.summary ?? '', r))}>
              <Markdown text={renamed(r.summary, r)} />
            </div>
          ) : (
            <p className="muted">{notesLine(r, live)}</p>
          )}

          {!isChat && !live && (r.notesStatus === 'done' || r.actions) && <FollowUp r={r} onError={setError} />}
        </>
      )}

      {tab === 'chat' && <SavedChat r={r} />}
      {tab === 'transcript' && <SavedTranscript r={r} />}
    </div>
  )
}

/** A saved session's questions and answers. Also the Follow-up window's Chat tab. */
export function SavedChat({ r }: { r: SavedSession }) {
  if (!r.messages.length) return <p className="muted">No questions were asked in this session.</p>
  return r.messages.map((m) => (
    <div key={m.id} className={`msg ${m.role}`}>
      {m.role === 'user' ? <div className="bubble">{m.text}</div> : <div className="text"><Markdown text={m.text} /></div>}
    </div>
  ))
}

/** A saved session's transcript, to read or copy whole. Also the Follow-up window's Transcript tab. */
export function SavedTranscript({ r }: { r: SavedSession }) {
  const text = transcriptText(r.transcript, r.speakers)
  if (!text) return <p className="muted">No transcript.</p>
  return (
    <>
      <div className="detail-actions">
        <button className="chip" data-tip="Copy the whole transcript, with times and speakers" onClick={() => glint.send('app:copy', text)}>
          <Icon name="copy" size={12} />Copy transcript
        </button>
      </div>
      {r.transcript.filter((t) => t.text).map((t) => (
        <div key={`${t.role}|${t.at}`} className={`line ${t.role}`}>
          <span className="ts">{formatElapsed(t.offsetMs)}</span>
          <p><b className="who">{lineLabel(t, r.speakers)}</b> {t.text}</p>
        </div>
      ))}
    </>
  )
}

/** While a redraft streams, its words replace the old draft as they arrive. */
export function useDraftStream(id: string, drafting: boolean, show: (d: { subject: string; body: string }) => void) {
  const [streaming, setStreaming] = useState(false)
  useEffect(() => {
    if (!drafting) return setStreaming(false)
    return glint.on('sessions:follow-up-partial', (d: { id: string; subject: string; body: string }) => d.id === id && (setStreaming(true), show(d)))
  }, [drafting, id])
  return streaming
}

/** The meeting's to-dos, then what to do next: put the dated ones in a calendar, or draft the follow-up email. */
function FollowUp({ r, onError }: { r: SavedSession; onError: (message: string) => void }) {
  // Local copies, so a tick shows at once; a refetch after the save brings the same back.
  const [items, setItems] = useState<ActionItem[]>(r.actions ?? [])
  useEffect(() => setItems(r.actions ?? []), [r.actions])
  const [draft, setDraft] = useState(r.followUp ?? null)
  useEffect(() => setDraft(r.followUp ?? null), [r.followUp])
  const [drafting, setDrafting] = useState(false)
  const streaming = useDraftStream(r.id, drafting, setDraft)
  const [added, setAdded] = useState(false)

  const change = (id: string, fields: Partial<ActionItem>) => {
    const next = items.map((a) => (a.id === id ? { ...a, ...fields } : a))
    setItems(next)
    glint.invoke('sessions:actions', r.id, next).catch((err: Error) => onError(err.message))
  }
  const open = items.filter((a) => !a.done).length
  const dated = items.filter((a) => a.due && !a.done).length
  const addToCalendar = () =>
    glint.invoke<number>('sessions:calendar', r.id).then(
      () => (setAdded(true), setTimeout(() => setAdded(false), 2000)),
      (err: Error) => onError(err.message),
    )
  const draftEmail = () => {
    setDrafting(true)
    glint.invoke<{ subject: string; body: string }>('sessions:follow-up', r.id)
      .then(setDraft, (err: Error) => onError(err.message))
      .finally(() => setDrafting(false))
  }

  return (
    <>
      <div className="section-head">
        <h3>Action items{items.length ? <span className="count">· {open} open</span> : ''}</h3>
        <button className="chip cal" disabled={!dated} onClick={addToCalendar}
          data-tip={dated ? 'Open the dated, unticked items in Calendar, which asks which calendar to add them to' : 'Give an unticked item a date first'}>
          <Icon name={added ? 'check' : 'calendar'} size={14} />{added ? 'Added' : dated ? <>Add <span key={dated} className="tick">{dated}</span> to Calendar</> : 'Add to Calendar'}
        </button>
      </div>
      {items.length ? (
        <ul className="action-items">
          {items.map((a) => (
            <li key={a.id} className={a.done ? 'done' : ''}>
              <input type="checkbox" checked={!!a.done} aria-label={`Done: ${a.text}`} onChange={(e) => change(a.id, { done: e.target.checked || undefined })} />
              <span className="action-text"><span className="strike">{a.text}</span></span>
              <OwnerPill item={a} r={r} onChange={(fields) => change(a.id, fields)} onError={onError} />
              <DatePill item={a} meetingAt={r.startedAt} onChange={(fields) => change(a.id, fields)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No action items.</p>
      )}

      <div className="email-card">
        <div className="section-head">
          <h3><Icon name="mail" />Follow-up email</h3>
          {draft ? (
            <span className="inline">
              <button className="chip plain" disabled={drafting} onClick={draftEmail} data-tip="Write the email again from these notes">
                <Icon name="refresh" size={12} />{drafting ? 'Drafting…' : 'Redraft'}
              </button>
              <button className="chip copy" data-tip="Copy the email text" onClick={() => glint.send('app:copy', renamed(draft.body, r))}><Icon name="copy" size={12} />Copy</button>
              <button className="chip primary" data-tip="Open a new email with this subject and text in your mail app"
                onClick={() => window.open(`mailto:?subject=${encodeURIComponent(renamed(draft.subject, r))}&body=${encodeURIComponent(renamed(draft.body, r))}`)}>
                Open in Mail
              </button>
            </span>
          ) : (
            <button className="chip" disabled={drafting} onClick={draftEmail} data-tip="Have your AI write the follow-up email from these notes">
              {drafting ? 'Drafting…' : 'Draft email'}
            </button>
          )}
        </div>
        {draft && (
          <div className={`email-body ${drafting && !streaming ? 'redrafting' : ''}`}>
            <p className="email-subject"><span className="muted">Subject</span> {renamed(draft.subject, r)}</p>
            <div className="follow-up-body">{renamed(draft.body, r)}</div>
          </div>
        )}
      </div>
    </>
  )
}

/** An item's date as a pill; clicking opens a picker with quick picks, the date the meeting said, a month and a time. */
export function DatePill({ item, meetingAt, onChange }: {
  item: ActionItem; meetingAt: number; onChange: (fields: Pick<ActionItem, 'due' | 'time'>) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  // The panel never has key focus, so Esc can't close this; any click outside does.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])
  return (
    <span className="date-pill" ref={ref}>
      <button className={`pill-sm date lead ${item.due ? '' : 'blank'}`} aria-expanded={open} data-tip={open ? undefined : 'When this is due'}
        onClick={() => setOpen(!open)}>
        <Icon name={!item.due ? 'plus' : item.time ? 'clock' : 'calendar'} size={12} />
        {item.due ? `${dueLabel(item.due)}${item.time ? `, ${item.time}` : ''}` : 'Date'}
      </button>
      <Presence open={open}>{(closing) => <DatePicker item={item} meetingAt={meetingAt} closing={closing} onChange={onChange} onClose={() => setOpen(false)} />}</Presence>
    </span>
  )
}

const pad = (n: number) => String(n).padStart(2, '0')
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const fromIso = (s?: string) => (s ? new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))) : null)
const shortDay = (s: string) => fromIso(s)!.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

function DatePicker({ item, meetingAt, closing, onChange, onClose }: {
  item: ActionItem; meetingAt: number; closing: boolean; onChange: (fields: Pick<ActionItem, 'due' | 'time'>) => void; onClose: () => void
}) {
  const sg = item.suggested
  const opensOn = fromIso(item.due) ?? fromIso(sg?.due) ?? new Date(meetingAt)
  const [month, setMonth] = useState(new Date(opensOn.getFullYear(), opensOn.getMonth(), 1))
  const [timed, setTimed] = useState(!!item.time)
  const now = new Date()
  const today = isoDay(now)
  const tomorrow = isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))
  const meetingDay = isoDay(new Date(meetingAt))
  const pick = (due: string, time = timed ? item.time : undefined) => onChange({ due, time })

  // Monday first, whole weeks.
  const lead = (month.getDay() + 6) % 7
  const inMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells = Array.from({ length: Math.ceil((lead + inMonth) / 7) * 7 }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i - lead + 1))
  const step = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1))

  return (
    <div className={`date-pop ${closing ? 'closing' : ''}`} role="dialog" aria-label={`Date for: ${item.text}`}>
      <div className="date-chips">
        <button className={item.due === today ? 'on' : ''} onClick={() => pick(today)}>Today</button>
        <button className={item.due === tomorrow ? 'on' : ''} onClick={() => pick(tomorrow)}>Tomorrow</button>
        {sg && (
          <button className="said" data-tip="When it was put in the meeting" onClick={() => (sg.time && setTimed(true), pick(sg.due, sg.time))}>
            <Icon name="logo" size={13} />{shortDay(sg.due)}{sg.time && ` ${sg.time}`}, "{sg.said}"
          </button>
        )}
      </div>
      <div className="month-head">
        <b>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</b>
        <span className="grow" />
        <button className="icon-btn" aria-label="Previous month" onClick={() => step(-1)}><span className="flip"><Icon name="chevron" size={18} /></span></button>
        <button className="icon-btn" aria-label="Next month" onClick={() => step(1)}><span className="turn"><Icon name="chevron" size={18} /></span></button>
      </div>
      <div className="month-grid" role="grid">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="wd">{d}</span>)}
        {cells.map((d) => {
          const iso = isoDay(d)
          return (
            <button key={iso} className={`${d.getMonth() !== month.getMonth() ? 'other' : ''} ${iso === item.due ? 'on' : ''} ${iso === meetingDay ? 'meeting' : ''}`}
              data-tip={iso === meetingDay ? 'The day of the meeting' : undefined} onClick={() => pick(iso)}>
              {d.getDate()}
            </button>
          )
        })}
      </div>
      <div className="time-row">
        <span>Time</span>
        <div className="segmented mini" role="radiogroup" aria-label="Time">
          <button role="radio" aria-checked={!timed} className={timed ? '' : 'on'} onClick={() => (setTimed(false), item.time && onChange({ due: item.due, time: undefined }))}>All day</button>
          <button role="radio" aria-checked={timed} className={timed ? 'on' : ''} onClick={() => setTimed(true)}>At a time</button>
        </div>
      </div>
      {timed && (
        <input type="time" className="time-field" aria-label="Time" value={item.time ?? ''} onMouseDown={wantFocus}
          onChange={(e) => onChange({ due: item.due ?? sg?.due ?? today, time: e.target.value || undefined })} />
      )}
      <div className="date-foot">
        <button className="clear" disabled={!item.due && !item.time} onClick={() => (setTimed(false), onChange({ due: undefined, time: undefined }))}>Clear date</button>
        <button className="done" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}

/**
 * Who does an item, as a pill: the AI's best guess (marked ✦ until someone confirms or changes it), reassignable to
 * anyone in the meeting, nobody, or a name typed in. A speaker can be renamed from here too, and the notes follow.
 */
export function OwnerPill({ item, r, onChange, onError }: {
  item: ActionItem; r: SavedSession; onChange: (fields: Partial<ActionItem>) => void; onError: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState<{ rename: boolean; name: string } | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  const name = ownerName(item, r)
  const shown = item.ownerId === 'me' ? 'You' : name
  const guessed = !!name && !item.ownerByUser
  const renamable = !!item.ownerId && item.ownerId !== 'me' && !!r.speakers?.[item.ownerId]

  // The panel never has key focus, so Esc can't close this; any click outside does.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && (setOpen(false), setTyped(null))
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  const assign = (fields: Partial<ActionItem>) => {
    onChange({ owner: undefined, ownerId: undefined, ...fields, ownerByUser: true })
    setOpen(false)
    setTyped(null)
  }
  const submit = () => {
    const n = typed?.name.trim()
    if (!n) return
    if (typed!.rename) {
      glint.invoke('sessions:rename-speaker', r.id, item.ownerId, n).catch((err: Error) => onError(err.message))
      setOpen(false)
      setTyped(null)
    } else {
      const person = sessionPeople(r).find((p) => p.name.toLowerCase() === n.toLowerCase())
      assign(person ? { ownerId: person.id, owner: person.name } : { owner: n })
    }
  }

  return (
    <span className="who-wrap" ref={ref}>
      <button className={`pill-sm owner ${name ? '' : 'blank'} ${guessed ? 'lead' : ''}`} aria-expanded={open}
        data-tip={guessed ? "The AI's guess. Click to confirm or reassign" : 'Who does this. Click to reassign'} onClick={() => setOpen(!open)}>
        {guessed && <Icon name="logo" size={13} />}{shown || 'Nobody'}
      </button>
      <Presence open={open}>{(closing) => (
        <div className={`menu owner-menu ${closing ? 'closing' : ''}`} role="menu">
          <span className="menu-label">Assign to</span>
          {/* Named people first; voices nobody has named yet after them. */}
          {sessionPeople(r).sort((a, b) => Number(a.id.startsWith('voice-')) - Number(b.id.startsWith('voice-'))).map((p) => (
            <button key={p.id} role="menuitem" className={`${p.id === item.ownerId ? 'on' : ''} ${p.id.startsWith('voice-') ? 'unknown' : ''}`}
              onClick={() => assign({ ownerId: p.id, owner: p.name })}>
              {p.id === 'me' ? 'You' : p.name}{p.id === item.ownerId && <Icon name="check" />}
            </button>
          ))}
          <button role="menuitem" className={`unknown ${name ? '' : 'on'}`} onClick={() => assign({})}>Nobody{!name && <Icon name="check" />}</button>
          <form className="type-name" onSubmit={(e) => (e.preventDefault(), submit())}>
            <input type="text" maxLength={40} value={typed?.name ?? ''} autoFocus={!!typed?.rename}
              placeholder={typed?.rename ? `New name for ${name}` : 'Type a name…'} aria-label={typed?.rename ? 'Their name' : 'Someone else'}
              onMouseDown={wantFocus} onChange={(e) => setTyped({ rename: !!typed?.rename, name: e.target.value })} />
          </form>
          {renamable && !typed?.rename && (
            <>
              <hr />
              <button role="menuitem" className="two-line" onMouseDown={wantFocus} onClick={() => setTyped({ rename: true, name: name ?? '' })}>
                Rename "{name}"…<small>Everywhere in this session, without rewriting the notes</small>
              </button>
            </>
          )}
        </div>
      )}</Presence>
    </span>
  )
}

function notesLine(r: SavedSession, live: boolean) {
  if (live) return 'Notes are written when the session ends.'
  if (r.notesStatus === 'processing') return 'Writing notes…'
  if (r.notesStatus === 'failed') return `Couldn't write notes: ${r.notesError ?? 'unknown error'}.`
  return 'No notes yet.'
}
