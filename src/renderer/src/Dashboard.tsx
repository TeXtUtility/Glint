import { useEffect, useRef, useState } from 'react'
import {
  isChatId, lineLabel, ownerName, renamed, sessionPeople, titleOf, transcriptText, type ActionItem, type SavedSession, type SessionSummary,
} from '../../shared/history'
import { elapsedMs, formatElapsed, type State } from '../../shared/state'
import { CHECKLIST, checklistLeft } from '../../shared/tips'
import { glint, isMac, useTick } from './glint'
import { Icon } from './icons'
import { Markdown } from './Markdown'
import { ConfirmButton, Presence, Segmented, useDismiss, useFlash } from './ui'

// The overlay only takes key focus on request, so text fields ask main for it before the click lands. Other windows
// focus normally.
const wantFocus = () => void (document.documentElement.dataset.route === 'chat' && glint.invoke('window:focus-chat'))

export const minutes = (ms: number) => (ms < 60_000 ? '<1 min' : `${Math.round(ms / 60_000)} min`)
export const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

function relDay(date: Date) {
  const today = new Date()
  const days = Math.round((dayStart(date) - dayStart(today)) / 86_400_000)
  if (Math.abs(days) <= 1) {
    const word = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(days, 'day')
    return word[0].toLocaleUpperCase() + word.slice(1)
  }
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

export const dayLabel = (ms: number) => relDay(new Date(ms))

/** An action item's YYYY-MM-DD as "Today", "Tomorrow" or "Fri 2 Oct". */
export const dueLabel = (due: string) => relDay(fromIso(due)!)

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

/** A History row's Move to Trash (hold), over its right end while the row is pointed at. Not on the live session. */
export function TrashRow({ r, onError }: { r: SessionSummary; onError: (message: string) => void }) {
  const name = titleOf(r)
  return (
    <ConfirmButton icon={<Icon name="trash" size={14} />} label={`Move "${name}" to Trash`} confirmLabel="Move to Trash"
      onConfirm={() => void glint.invoke('sessions:trash', r.id).catch((err: Error) => onError(err.message))} />
  )
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
    }, (err: Error) => setError(`Couldn't load history: ${err.message}`))
  }, [s.historyVersion])

  if (openId) return <SessionDetail key={openId} id={openId} s={s} onBack={() => setOpenId(null)} onContinue={onContinue} />

  // ponytail: everything is local, so no pagination until lists get long enough to feel slow.
  const days = byDay(list ?? [], query)

  return (
    <div className="dash">
      <label className="dash-search">
        <Icon name="search" />
        <input type="search" placeholder="Search titles, summaries and tags" aria-label="Search history"
          value={query} onMouseDown={wantFocus} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      {!query.trim() && <GettingStarted s={s} />}
      {unreadable > 0 && (
        <p className="muted">
          {unreadable === 1 ? '1 saved session' : `${unreadable} saved sessions`} can't be opened: damaged, or encrypted with a
          {isMac ? 'keychain key this Mac no longer has' : "Windows account key that can't unlock them anymore"}. The files are still in Glint's sessions folder.
        </p>
      )}
      {list && !days.length && (
        <p className="empty">
          {query.trim() ? 'Nothing matches.' : s.saveChats ? 'Nothing yet. Your chats appear here, and sessions you record appear with notes.' : 'Nothing yet. Sessions you record appear here with notes.'}
        </p>
      )}
      {days.map(([label, rows]) => (
        <section key={label}>
          <h3 className="day">{label}</h3>
          {rows.map((r) => {
            const live = s.session?.id === r.id
            const status = rowStatus(r, live)
            return (
              <div key={r.id} className="history-item">
                <button className="session-row" onClick={() => setOpenId(r.id)}>
                  <span className="session-main">
                    <span className="session-title">{titleOf(r)}</span>
                    <span className="session-meta">
                      {time(r.startedAt)} · {isChatId(r.id) ? 'Chat' : s.session?.id === r.id ? `${formatElapsed(elapsedMs(s, Date.now()))} so far` : minutes(r.elapsedMs)}
                      {(r.mode === 'Practice call' || !!r.tags?.length) && (
                        <span className="tags">{r.mode === 'Practice call' && <span>Practice</span>}{r.tags?.map((t) => <span key={t}>{t}</span>)}</span>
                      )}
                    </span>
                  </span>
                  {status && <span className={`status ${status.kind}`}>{status.label}</span>}
                </button>
                {!live && <TrashRow r={r} onError={(m) => setError(`Couldn't move it to the Trash: ${m}`)} />}
              </div>
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

  useDismiss(more, moreRef, () => setMore(false))

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
          {!isChat && !live && (
            <div className="section-head summary-head">
              <h3>Summary</h3>
              <span className="inline">
                <button className="chip plain" disabled={r.notesStatus === 'processing'} onClick={() => glint.send('sessions:regenerate', id)}
                  data-tip="Write the notes and the follow-up email again from the call, replacing your edits to the title and summary">
                  <Icon name="refresh" size={12} />Regenerate
                </button>
                <button className="chip plain" onClick={() => glint.send('window:open-settings', 'notes')}
                  data-tip="See and change the instructions the notes and the email are written from">
                  <Icon name="edit" size={12} />Prompt
                </button>
              </span>
            </div>
          )}
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

export function useFollowUp(r: SavedSession, onError: (message: string) => void) {
  // Local copies, so a tick shows at once; a refetch after the save brings the same back.
  const [items, setItems] = useState<ActionItem[]>(r.actions ?? [])
  useEffect(() => setItems(r.actions ?? []), [r.actions])
  const [draft, setDraft] = useState(r.followUp ?? null)
  useEffect(() => setDraft(r.followUp ?? null), [r.followUp])
  const [drafting, setDrafting] = useState(false)
  // While a redraft streams, its words replace the old draft as they arrive.
  const [streaming, setStreaming] = useState(false)
  useEffect(() => {
    if (!drafting) return setStreaming(false)
    return glint.on('sessions:follow-up-partial', (d: { id: string; subject: string; body: string }) => d.id === r.id && (setStreaming(true), setDraft(d)))
  }, [drafting, r.id])
  const [added, flashAdded] = useFlash(2000)
  const email = draft && { subject: renamed(draft.subject, r), body: renamed(draft.body, r) }
  return {
    items, email, drafting, streaming, added,
    change(id: string, fields: Partial<ActionItem>) {
      const next = items.map((a) => (a.id === id ? { ...a, ...fields } : a))
      setItems(next)
      glint.invoke('sessions:actions', r.id, next).catch((err: Error) => onError(err.message))
    },
    write() {
      setDrafting(true)
      glint.invoke<{ subject: string; body: string }>('sessions:follow-up', r.id)
        .then(setDraft, (err: Error) => onError(err.message))
        .finally(() => setDrafting(false))
    },
    addToCalendar: () => void glint.invoke('sessions:calendar', r.id).then(() => flashAdded(), (err: Error) => onError(err.message)),
    openMail: () => email && window.open(`mailto:?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`),
  }
}

/** The meeting's to-dos, then what to do next: put the dated ones in a calendar, or draft the follow-up email. */
function FollowUp({ r, onError }: { r: SavedSession; onError: (message: string) => void }) {
  const { items, email, drafting, streaming, added, change, write, addToCalendar, openMail } = useFollowUp(r, onError)
  const open = items.filter((a) => !a.done).length
  const dated = items.filter((a) => a.due && !a.done).length

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
              <DatePill item={a} onChange={(fields) => change(a.id, fields)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No action items.</p>
      )}

      <div className="email-card">
        <div className="section-head">
          <h3><Icon name="mail" />Follow-up email</h3>
          {email ? (
            <span className="inline">
              <button className="chip plain" disabled={drafting} onClick={write} data-tip="Write the email again from these notes">
                <Icon name="refresh" size={12} />{drafting ? 'Drafting…' : 'Redraft'}
              </button>
              <button className="chip copy" data-tip="Copy the email text" onClick={() => glint.send('app:copy', email.body)}><Icon name="copy" size={12} />Copy</button>
              <button className="chip primary" data-tip="Open a new email with this subject and text in your mail app" onClick={openMail}>
                Open in Mail
              </button>
            </span>
          ) : (
            <button className="chip" disabled={drafting} onClick={write} data-tip="Have your AI write the follow-up email from these notes">
              {drafting ? 'Drafting…' : 'Draft email'}
            </button>
          )}
        </div>
        {email && (
          <div className={`email-body ${drafting && !streaming ? 'redrafting' : ''}`}>
            <p className="email-subject"><span className="muted">Subject</span> {email.subject}</p>
            <div className="follow-up-body">{email.body}</div>
          </div>
        )}
      </div>
    </>
  )
}

/** An item's date as a pill; clicking opens a picker with quick picks, the date the meeting said, a date and a time. */
export function DatePill({ item, onChange }: {
  item: ActionItem; onChange: (fields: Pick<ActionItem, 'due' | 'time'>) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useDismiss(open, ref, () => setOpen(false))
  return (
    <span className="date-pill" ref={ref}>
      <button className={`pill-sm date lead ${item.due ? '' : 'blank'}`} aria-expanded={open} data-tip={open ? undefined : 'When this is due'}
        onClick={() => setOpen(!open)}>
        <Icon name={!item.due ? 'plus' : item.time ? 'clock' : 'calendar'} size={12} />
        {item.due ? `${dueLabel(item.due)}${item.time ? `, ${item.time}` : ''}` : 'Date'}
      </button>
      <Presence open={open}>{(closing) => <DatePicker item={item} closing={closing} onChange={onChange} onClose={() => setOpen(false)} />}</Presence>
    </span>
  )
}

const pad = (n: number) => String(n).padStart(2, '0')
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const fromIso = (s?: string) => (s ? new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))) : null)
const shortDay = (s: string) => fromIso(s)!.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

function DatePicker({ item, closing, onChange, onClose }: {
  item: ActionItem; closing: boolean; onChange: (fields: Pick<ActionItem, 'due' | 'time'>) => void; onClose: () => void
}) {
  const sg = item.suggested
  const [timed, setTimed] = useState(!!item.time)
  const now = new Date()
  const today = isoDay(now)
  const tomorrow = isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))
  const pick = (due: string, time = timed ? item.time : undefined) => onChange({ due, time })

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
        <input type="date" className="time-field" aria-label="Date" value={item.due ?? ''} onMouseDown={wantFocus}
          onChange={(e) => e.target.value && pick(e.target.value)} />
      </div>
      <div className="time-row">
        <span>Time</span>
        <Segmented className="mini" label="Time" value={timed ? 'timed' : 'allDay'}
          onChange={(v) => (v === 'timed' ? setTimed(true) : (setTimed(false), item.time && onChange({ due: item.due, time: undefined })))}
          options={[{ value: 'allDay', label: 'All day' }, { value: 'timed', label: 'At a time' }]} />
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

  useDismiss(open, ref, () => (setOpen(false), setTyped(null)))

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

export function notesLine(r: SavedSession, live: boolean) {
  if (live) return 'Notes are written when the session ends.'
  if (r.notesStatus === 'processing') return 'Writing notes…'
  if (r.notesStatus === 'failed') return `Couldn't write notes: ${r.notesError ?? 'unknown error'}.`
  return 'No notes yet.'
}

/** Setup's checklist, until it's done: what's been tried, and what's next. */
function GettingStarted({ s }: { s: State }) {
  const left = checklistLeft(s.firsts)
  if (!left.length) return null
  return (
    <section className="getting-started" aria-label="Getting started">
      <h3 className="day">
        Getting started · {CHECKLIST.length - left.length} of {CHECKLIST.length}
        <button className="link" data-tip="Hides this list and turns tips off. Settings → General brings them back" onClick={() => glint.send('checklist:hide')}>Hide</button>
      </h3>
      <ul>
        {CHECKLIST.map((c) => (
          <li key={c.id} className={left.includes(c) ? '' : 'done'}>
            {left.includes(c) ? <i /> : <Icon name="checkCircle" size={14} />}{c.label}
          </li>
        ))}
      </ul>
    </section>
  )
}
