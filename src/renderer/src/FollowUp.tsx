import { useEffect, useState } from 'react'
import { isChatId, ownerName, renamed, sessionPeople, type ActionItem, type SavedSession, type SessionSummary } from '../../shared/history'
import { type State } from '../../shared/state'
import { byDay, DatePill, dayLabel, dueLabel, minutes, OwnerPill, SavedChat, SavedTranscript, time, TrashRow, useDraftStream } from './Dashboard'
import { glint, useAppState } from './glint'
import { Icon } from './icons'
import { Markdown } from './Markdown'
import { Segmented } from './ui'

type Tab = 'followup' | 'chat' | 'transcript'
type GroupBy = 'owner' | 'date'

/** 3c: a session's follow-up in its own window, with every session in a sidebar. */
export function FollowUpWindow() {
  const s = useAppState()
  const [list, setList] = useState<SessionSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [id, setId] = useState(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('id'))
  useEffect(() => glint.on('followup:open', (sid: string) => setId(sid)), [])
  useEffect(() => {
    glint.invoke<{ sessions: SessionSummary[] }>('sessions:list').then((r) => setList(r.sessions), () => setList([]))
  }, [s?.historyVersion])
  if (!s) return null

  const days = byDay(list ?? [], query)
  // A session moved to Trash leaves the list: show another, not a dead one.
  const kept = id && (!list || list.some((r) => r.id === id)) ? id : null
  const current = kept ?? list?.find((r) => !isChatId(r.id))?.id ?? list?.[0]?.id ?? null

  return (
    <div className="fw">
      <aside className="fw-side">
        <label className="fw-search">
          <Icon name="search" size={15} />
          <input type="search" placeholder="Search sessions" aria-label="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {list && !days.length && <p className="fw-empty">{query.trim() ? 'Nothing matches.' : 'Nothing yet.'}</p>}
        {error && <p className="fw-error">{error}</p>}
        {days.map(([label, rows]) => (
          <section key={label}>
            <h3 className="fw-day">{label}</h3>
            {rows.map((r) => (
              <div key={r.id} className="history-item">
                <button className={`fw-row ${r.id === current ? 'on' : ''}`} onClick={() => setId(r.id)}>
                  <span className="fw-row-title">{r.title || (isChatId(r.id) ? 'Untitled chat' : 'Untitled session')}</span>
                  <span className="fw-row-meta">{rowMeta(r, s.session?.id === r.id)}</span>
                </button>
                {s.session?.id !== r.id && <TrashRow r={r} onError={(m) => setError(`Couldn't move it to the Trash: ${m}`)} />}
              </div>
            ))}
          </section>
        ))}
      </aside>
      <main className="fw-main">
        {current ? <Session key={current} id={current} s={s} /> : <p className="fw-empty">Sessions you record appear here with their notes.</p>}
      </main>
    </div>
  )
}

function rowMeta(r: SessionSummary, live: boolean) {
  if (isChatId(r.id)) return `${time(r.startedAt)} · Chat`
  const open = r.actions?.filter((a) => !a.done).length ?? 0
  const todo = !r.actions?.length ? '' : open ? ` · ${open} open` : ' · all done'
  return `${time(r.startedAt)} · ${live ? 'live' : minutes(r.elapsedMs)}${todo}`
}

function Session({ id, s }: { id: string; s: State }) {
  const [r, setR] = useState<SavedSession | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('followup')
  useEffect(() => {
    glint.invoke<SavedSession | null>('session:load', id).then((v) => (v ? setR(v) : setError('This session was never saved: nothing was said in it.')), (err: Error) => setError(err.message))
  }, [id, s.historyVersion])
  if (!r) return <p className="fw-empty">{error || 'Loading…'}</p>

  const isChat = isChatId(r.id)
  const live = s.session?.id === id
  const people = sessionPeople(r).filter((p) => p.id !== 'me' && !p.id.startsWith('voice-')).map((p) => p.name)
  const meta = [
    `${dayLabel(r.startedAt)}, ${time(r.startedAt)}`, isChat ? 'Chat' : minutes(r.elapsedMs), r.mode,
    !isChat && [...people, 'You'].join(', '),
  ].filter(Boolean).join(' · ')

  return (
    <>
      <header className="fw-head">
        <div className="fw-head-text">
          <h1>{r.title || (isChat ? 'Untitled chat' : 'Untitled session')}</h1>
          <p>{meta}</p>
        </div>
        {!isChat && (
          <Segmented tabs label="Session view" value={tab} onChange={setTab}
            options={[{ value: 'followup', label: 'Follow-up' }, { value: 'chat', label: 'Chat' }, { value: 'transcript', label: 'Transcript' }]} />
        )}
        {!isChat && (
          <button className="fw-resume" disabled={!!s.session} onClick={() => glint.send('session:resume', id)}
            data-tip={s.session ? 'Stop the current session first' : 'Keep recording this session; the timer picks up where it stopped'}>
            <Icon name="play" size={11} />Resume
          </button>
        )}
      </header>
      {error && <p className="fw-error">{error}</p>}
      {tab === 'followup' && !isChat ? <FollowUpBody r={r} live={live} onError={setError} />
        : <div className="fw-pane">{tab === 'transcript' ? <SavedTranscript r={r} /> : <SavedChat r={r} />}</div>}
    </>
  )
}

function FollowUpBody({ r, live, onError }: { r: SavedSession; live: boolean; onError: (m: string) => void }) {
  const [items, setItems] = useState<ActionItem[]>(r.actions ?? [])
  useEffect(() => setItems(r.actions ?? []), [r.actions])
  const [groupBy, setGroupBy] = useState<GroupBy>('owner')
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)

  // A ticked task stays where it is for a moment, struck through, before it moves to Done.
  const [settling, setSettling] = useState<Set<string>>(new Set())
  const change = (itemId: string, fields: Partial<ActionItem>) => {
    const next = items.map((a) => (a.id === itemId ? { ...a, ...fields } : a))
    setItems(next)
    glint.invoke('sessions:actions', r.id, next).catch((err: Error) => onError(err.message))
    const settle = (on: boolean) => setSettling((s) => (on ? s.add(itemId) : s.delete(itemId), new Set(s)))
    if ('done' in fields) settle(!!fields.done)
    if (fields.done) setTimeout(() => settle(false), 800)
  }
  const view = items.map((a) => (a.done && settling.has(a.id) ? { ...a, done: undefined } : a))
  const groups = groupBy === 'owner' ? byOwner(view, r) : byDate(view)
  const ticked = (a: ActionItem) => !!a.done || settling.has(a.id)
  const drop = (g: Group) => {
    if (dragging) change(dragging, g.fields)
    setDragging(null)
    setOver(null)
  }
  const rename = () => {
    const n = renaming?.name.trim()
    if (n) glint.invoke('sessions:rename-speaker', r.id, renaming!.id, n).catch((err: Error) => onError(err.message))
    setRenaming(null)
  }

  return (
    <div className="fw-body">
      <div className="fw-left">
        {r.summary ? <div className="fw-summary"><Markdown text={renamed(r.summary, r)} /></div>
          : <p className="fw-muted">{live ? 'Notes are written when the session ends.' : r.notesStatus === 'processing' ? 'Writing notes…' : 'No notes yet.'}</p>}
        <div className="fw-actions-head">
          <h3>Action items</h3>
          <div className="segmented fw-seg" role="radiogroup" aria-label="Group action items">
            {(['owner', 'date'] as const).map((g) => (
              <button key={g} role="radio" aria-checked={groupBy === g} className={groupBy === g ? 'on' : ''} onClick={() => setGroupBy(g)}>
                {g === 'owner' ? 'By owner' : 'By date'}
              </button>
            ))}
          </div>
        </div>
        {!items.length && <p className="fw-muted">No action items.</p>}
        {groups.map((g) => (
          <section key={g.key} className={`fw-group ${g.kind} ${over === g.key ? 'over' : ''}`}
            onDragOver={(e) => dragging && (e.preventDefault(), setOver(g.key))} onDragLeave={() => setOver((k) => (k === g.key ? null : k))}
            onDrop={(e) => (e.preventDefault(), drop(g))}>
            <h4>
              {renaming && renaming.id === g.ownerId ? (
                <form onSubmit={(e) => (e.preventDefault(), rename())}>
                  <input autoFocus value={renaming!.name} maxLength={40} aria-label="Their name" onBlur={rename} onChange={(e) => setRenaming({ ...renaming!, name: e.target.value })} />
                </form>
              ) : g.renamable ? (
                <button className="fw-group-name" data-tip="Rename this person everywhere in this session" onClick={() => setRenaming({ id: g.ownerId!, name: g.label })}>{g.label}</button>
              ) : <span>{g.label}</span>}
              <span className="n">· {g.items.length}</span>
              {g.guessed && <span className="guessed"><Icon name="logo" size={12} /> guessed</span>}
            </h4>
            <ul>
              {g.items.map((a) => (
                <li key={a.id} className={`${ticked(a) ? 'done' : ''} ${dragging === a.id ? 'dragging' : ''}`} draggable
                  onDragStart={(e) => (e.dataTransfer.setData('text/plain', a.id), (e.dataTransfer.effectAllowed = 'move'), setDragging(a.id))}
                  onDragEnd={() => (setDragging(null), setOver(null))}>
                  <input type="checkbox" checked={ticked(a)} aria-label={`Done: ${a.text}`} onChange={(e) => change(a.id, { done: e.target.checked || undefined })} />
                  <span className="fw-text"><span className="strike">{a.text}</span>{a.done && ownerName(a, r) && <span className="suffix"> · {a.ownerId === 'me' ? 'You' : ownerName(a, r)}</span>}</span>
                  {a.done ? <span className="fw-plain-date">{a.due ? dueLabel(a.due) : ''}</span>
                    : groupBy === 'owner' ? <DatePill item={a} meetingAt={r.startedAt} onChange={(f) => change(a.id, f)} />
                    : <OwnerPill item={a} r={r} onChange={(f) => change(a.id, f)} onError={onError} />}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {!!items.length && (
          <p className="fw-hint">
            {groupBy === 'owner' ? 'Drag a task onto a group to reassign it, or click the group name to rename that person.' : 'Drag a task onto a day to move it.'}
          </p>
        )}
      </div>
      <div className="fw-right">
        <CalendarCard r={r} items={items} onError={onError} />
        <EmailCard r={r} onError={onError} />
      </div>
    </div>
  )
}

interface Group {
  key: string
  label: string
  kind: 'me' | 'person' | 'nobody' | 'done' | 'day'
  items: ActionItem[]
  /** What dropping a task here sets on it. */
  fields: Partial<ActionItem>
  ownerId?: string
  renamable?: boolean
  guessed?: boolean
}

function byOwner(items: ActionItem[], r: SavedSession): Group[] {
  const order = sessionPeople(r).map((p) => p.id)
  const groups = new Map<string, Group>()
  for (const a of items.filter((x) => !x.done)) {
    const name = ownerName(a, r)
    const key = a.ownerId ?? (name ? `name:${name.toLowerCase()}` : 'nobody')
    let g = groups.get(key)
    if (!g) {
      const kind = key === 'me' ? 'me' : key === 'nobody' ? 'nobody' : 'person'
      g = {
        key, kind, items: [], guessed: kind !== 'nobody', ownerId: a.ownerId,
        label: kind === 'me' ? 'You' : kind === 'nobody' ? 'Nobody yet' : name!,
        fields: { ownerId: a.ownerId, owner: kind === 'nobody' ? undefined : name, ownerByUser: true, done: undefined },
        renamable: !!a.ownerId && a.ownerId !== 'me' && !!r.speakers?.[a.ownerId],
      }
      groups.set(key, g)
    }
    g.items.push(a)
    if (a.ownerByUser) g.guessed = false
  }
  const rank = (g: Group) => (g.kind === 'nobody' ? 1e6 : g.ownerId ? order.indexOf(g.ownerId) : 1e5)
  const list = [...groups.values()].sort((a, b) => rank(a) - rank(b))
  const done = items.filter((x) => x.done)
  if (done.length) list.push({ key: 'done', label: 'Done', kind: 'done', items: done, fields: { done: true } })
  return list
}

function byDate(items: ActionItem[]): Group[] {
  const open = items.filter((x) => !x.done)
  const dates = [...new Set(open.map((a) => a.due).filter((d): d is string => !!d))].sort()
  const list: Group[] = dates.map((d) => ({ key: d, label: dueLabel(d), kind: 'day', items: open.filter((a) => a.due === d), fields: { due: d, done: undefined } }))
  const none = open.filter((a) => !a.due)
  if (none.length) list.push({ key: 'none', label: 'No date', kind: 'nobody', items: none, fields: { due: undefined, time: undefined, done: undefined } })
  const done = items.filter((x) => x.done)
  if (done.length) list.push({ key: 'done', label: 'Done', kind: 'done', items: done, fields: { done: true } })
  return list
}

function CalendarCard({ r, items, onError }: { r: SavedSession; items: ActionItem[]; onError: (m: string) => void }) {
  const [added, setAdded] = useState(false)
  const dated = items.filter((a) => a.due && !a.done)
  const weekday = (d: string) => new Date(`${d}T12:00`).toLocaleDateString(undefined, { weekday: 'short' })
  const explain = dated.length
    ? `${dated.slice(0, 3).map((a) => (a.time ? `${weekday(a.due!)} is 30 min at ${a.time}` : `${weekday(a.due!)} is all-day`)).join('; ')}. Adding again updates the same events.`
    : 'Give a task a date to put it in your calendar.'
  const add = () =>
    glint.invoke('sessions:calendar', r.id).then(() => (setAdded(true), setTimeout(() => setAdded(false), 2000)), (err: Error) => onError(err.message))
  return (
    <div className="fw-card cal">
      <b><Icon name="calendar" /><span key={dated.length} className="tick">{dated.length}</span>{dated.length === 1 ? ' item has a date' : ' items have dates'}</b>
      <p>{explain}</p>
      <button className="fw-cal-btn" disabled={!dated.length} onClick={add}>{added ? 'Added' : 'Add to Calendar'}</button>
    </div>
  )
}

function EmailCard({ r, onError }: { r: SavedSession; onError: (m: string) => void }) {
  const [draft, setDraft] = useState(r.followUp ?? null)
  useEffect(() => setDraft(r.followUp ?? null), [r.followUp])
  const [drafting, setDrafting] = useState(false)
  const streaming = useDraftStream(r.id, drafting, setDraft)
  const [copied, setCopied] = useState(false)
  const write = () => {
    setDrafting(true)
    glint.invoke<{ subject: string; body: string }>('sessions:follow-up', r.id).then(setDraft, (err: Error) => onError(err.message)).finally(() => setDrafting(false))
  }
  const subject = draft && renamed(draft.subject, r)
  const body = draft && renamed(draft.body, r)
  return (
    <div className="fw-card email">
      <b>
        Follow-up email
        {draft && <button className="fw-redraft" aria-label="Redraft" data-tip="Write the email again from these notes" disabled={drafting} onClick={write}><Icon name="refresh" /></button>}
      </b>
      {draft ? (
        <>
          <div className={`fw-email-body ${drafting && !streaming ? 'redrafting' : ''}`}><p className="subject">{subject}</p>{body}</div>
          <div className="fw-email-buttons">
            <button onClick={() => (glint.send('app:copy', body), setCopied(true), setTimeout(() => setCopied(false), 1500))}>{copied ? 'Copied' : 'Copy'}</button>
            <button className="mail" onClick={() => window.open(`mailto:?subject=${encodeURIComponent(subject!)}&body=${encodeURIComponent(body!)}`)}>Open in Mail</button>
          </div>
        </>
      ) : (
        <>
          <p className="fw-muted">A short email with what was decided and who does what by when.</p>
          <div className="fw-email-buttons"><button className="mail" disabled={drafting} onClick={write}>{drafting ? 'Drafting…' : 'Draft email'}</button></div>
        </>
      )}
    </div>
  )
}
