import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cliPrompt, composeNote, followUpPrompt, meetingDay, parseFollowUp, GLANCE_PROMPT, isRetry, REFERENCE_PROMPT, RETRY_PROMPT, nameGuessContext, nameGuessQuestion, parseNameGuess, lineKey, MODE_TEMPLATES, notesPrompt, parseClaudeLine, parseNotes, recentHistory, SYSTEM_PROMPT, systemPrompt, unsentLines, userPrompt, wrapText } from './prompt.ts'

test('userPrompt includes transcript and falls back to an implicit ask', () => {
  const p = userPrompt({ text: '', hasSession: true, transcript: [{ role: 'them', text: 'Any questions?' }] })
  assert.match(p, /<transcript>\nThem: Any questions\?\n<\/transcript>/)
  assert.match(p, /conversation right now/)
  assert.equal(userPrompt({ text: 'hi', hasSession: false, transcript: [] }), 'hi')
})

test('cliPrompt inlines history', () => {
  const p = cliPrompt({ id: 'x', text: 'next?', screenshot: null, transcript: [], hasSession: false,
    history: [{ role: 'user', text: 'q1' }, { role: 'assistant', text: '' }] })
  assert.match(p, /User: q1/)
  assert.doesNotMatch(p, /Assistant:/)
  assert.match(p, /next\?$/)
})

test('unsentLines: skips sent and pending lines, keeps late finishers', () => {
  const line = (role: 'me' | 'them', at: string, status: 'ready' | 'pending' = 'ready') => ({ role, at, offsetMs: 0, status, text: at })
  const first = [line('them', 'a', 'pending'), line('me', 'b')]
  const sent = unsentLines(first, []).map(lineKey)
  assert.deepEqual(sent, ['me|b'])
  // "them@a" finished after the ask that sent "me@b": it's still unsent, even though it started earlier.
  assert.deepEqual(unsentLines([line('them', 'a'), line('me', 'b'), line('me', 'c')], sent).map(lineKey), ['them|a', 'me|c'])
})

test('parseClaudeLine', () => {
  const delta = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } }
  assert.deepEqual(parseClaudeLine(JSON.stringify(delta)), { text: 'Hi' })
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: 'result', is_error: true, result: 'expired' })), { error: 'expired', done: true })
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: 'result', is_error: false, result: 'ok' })), { done: true })
  assert.deepEqual(parseClaudeLine('not json'), {})
})

test('systemPrompt appends only a non-empty active mode', () => {
  assert.equal(systemPrompt(null), SYSTEM_PROMPT)
  assert.equal(systemPrompt({ name: 'Blank', prompt: '  ' }), SYSTEM_PROMPT)
  const p = systemPrompt({ name: 'Sales', prompt: 'Handle objections.' })
  assert.ok(p.startsWith(SYSTEM_PROMPT))
  assert.match(p, /"Sales" mode[\s\S]*<mode_instructions>\nHandle objections\.\n<\/mode_instructions>$/)
  assert.equal(new Set(MODE_TEMPLATES.map((t) => t.id)).size, MODE_TEMPLATES.length)
})

test('notes: prompt includes transcript and chat; reply parsing is forgiving but strict on shape', () => {
  const p = notesPrompt('[0:05] Them: Ship Friday?', [{ role: 'user', text: 'summarise' }, { role: 'assistant', text: '' }])
  assert.match(p, /<transcript>\n\[0:05\] Them: Ship Friday\?\n<\/transcript>/)
  assert.match(p, /User asked: summarise/)
  assert.doesNotMatch(p, /Assistant answered/)
  const r = parseNotes('Sure!\nTITLE: **"Q3 launch plan"**\nTAGS: #Launch, planning , \nSUMMARY:\nWe agreed.\n### Key points\n- Friday')
  assert.deepEqual(r, { title: 'Q3 launch plan', tags: ['launch', 'planning'], summary: 'We agreed.\n### Key points\n- Friday', actions: [] })
  assert.equal(parseNotes('Here is a summary without the format.'), null)
})

test('screenshot note: composed from global and mode, never mentioned in the prompt, wrapped to width', () => {
  assert.equal(composeNote('  Be brief. ', ' Go only. '), 'Be brief.\n\nGo only.')
  assert.equal(composeNote('', '  '), '')
  assert.equal(composeNote('x'), 'x')
  assert.equal(userPrompt({ text: 'q', hasSession: false, transcript: [] }), 'q')
  const len = (s: string) => s.length
  assert.deepEqual(wrapText('aaa bbb ccc', 7, len), ['aaa bbb', 'ccc'])
  assert.deepEqual(wrapText('abcdefghij', 4, len), ['abcd', 'efgh', 'ij'])
  assert.deepEqual(wrapText('a\n\nb', 10, len), ['a', '', 'b'])
  assert.deepEqual(wrapText('xx abcdefg yy', 3, len), ['xx', 'abc', 'def', 'g', 'yy'])
})

test('userPrompt uses speaker names when given', () => {
  const p = userPrompt({ text: '', hasSession: true, transcript: [{ role: 'them', text: 'Hi', name: 'Priya' }, { role: 'me', text: 'Hey' }, { role: 'them', text: 'Yo' }] })
  assert.match(p, /Priya: Hi\nMe: Hey\nThem: Yo/)
})

test('Glance format goes at the end of the new turn, never in the system prompt (which must stay cacheable)', () => {
  const mode = { name: 'Interview', prompt: 'Answer in 2-4 sentences.' }
  assert.ok(!systemPrompt(mode).includes(GLANCE_PROMPT))
  const turn = userPrompt({ text: 'q', hasSession: true, transcript: [{ role: 'them', text: 'hi' }], brief: true })
  assert.ok(turn.endsWith(GLANCE_PROMPT))
  assert.ok(!userPrompt({ text: 'q', hasSession: true, transcript: [] }).includes(GLANCE_PROMPT))
})

test('userPrompt puts cacheable context first', () => {
  assert.equal(userPrompt({ text: 'q', hasSession: false, transcript: [], context: '<transcript>x</transcript>' }), '<transcript>x</transcript>\n\nq')
})

test('name guess: prompt names the label, reply parses, UNKNOWN is null', () => {
  assert.equal(nameGuessContext('[0:01] Speaker 2: hi'), '<transcript>\n[0:01] Speaker 2: hi\n</transcript>')
  assert.match(nameGuessQuestion('Speaker 2'), /labelled "Speaker 2"\?$/)
  assert.deepEqual(parseNameGuess('NAME: Dana\nWHY: "Hi, I\'m Dana from finance"'), { name: 'Dana', why: '"Hi, I\'m Dana from finance"' })
  assert.deepEqual(parseNameGuess('NAME: **Dana.**\nWHY: x'), { name: 'Dana', why: 'x' })
  assert.equal(parseNameGuess('NAME: UNKNOWN\nWHY: nobody says it').name, null)
  assert.equal(parseNameGuess('I think it might be Dana').name, null)
})

test('userPrompt: an empty ask is about now, never an earlier question; a failed screenshot is admitted', () => {
  assert.match(userPrompt({ text: '', hasSession: false, transcript: [] }), /Help with what is on my screen right now/)
  assert.match(userPrompt({ text: 'why?', hasSession: false, transcript: [] }), /^why\?$/)
  assert.match(userPrompt({ text: 'q', hasSession: false, transcript: [], screenshotFailed: true }), /screenshot of my screen failed/)
})

test('retries: short "again" asks get the different-version nudge; real questions do not', () => {
  for (const t of ['rewrite', 'Try again', 'another one', 'no, redo it', 'something different', 'nope', 'Try again.', 'redo that, please!']) assert.ok(isRetry(t), t)
  for (const t of ['rewrite this paragraph about why the sky is blue, keeping it under 50 words and friendly please', 'again, what is the capital of France?'.repeat(2), 'explain this', 'differentiate x^2',
    'Another question: what is X?', 'Different topic: how do refunds work?', 'Something else: when is the deadline?', 'Again, what was the deadline?'])
    assert.ok(!isRetry(t), t)
  const base = { transcript: [], hasSession: false }
  assert.ok(userPrompt({ ...base, text: 'try again' }).includes(RETRY_PROMPT))
  assert.ok(!userPrompt({ ...base, text: 'explain this' }).includes(RETRY_PROMPT))
  assert.match(userPrompt({ ...base, text: '' }), /asking again because that answer didn't work/)
})

test('reference files: guidance only when the mode has files, and it never changes with the instructions', () => {
  assert.ok(!systemPrompt({ name: 'M', prompt: '' }).includes(REFERENCE_PROMPT))
  const withFiles = systemPrompt({ name: 'M', prompt: '', files: [{ id: 'f', name: 'a.md', chars: 10 }] })
  assert.ok(withFiles.startsWith(SYSTEM_PROMPT) && withFiles.includes(REFERENCE_PROMPT))
  assert.ok(systemPrompt({ name: 'M', prompt: 'Be brief.', files: [{ id: 'f', name: 'a.md', chars: 10 }] }).includes('Be brief.'))
})

test('notes: action items with owner, date and time; blanks and bad dates dropped; the meeting date is given', () => {
  const r = parseNotes([
    'TITLE: Launch sync', 'TAGS: launch', 'ACTIONS:',
    '- Send the deck | Dana | 2026-10-02 | 15:00',
    '- **Book the room** | Me | blank | ',
    '2. Check pricing | | next week | noon',
    '- Share the budget | Priya | | | 2026-10-01 "before Friday"',
    '- Call legal | Me | 2026-10-05 | 10:00 | 2026-10-05 10:00 “Monday at ten”',
    'SUMMARY:', 'We agreed.',
  ].join('\n'))
  assert.deepEqual(r?.actions, [
    { text: 'Send the deck', owner: 'Dana', due: '2026-10-02', time: '15:00' },
    { text: 'Book the room', owner: 'Me', due: undefined, time: undefined },
    { text: 'Check pricing', owner: undefined, due: undefined, time: undefined },
    { text: 'Share the budget', owner: 'Priya', due: undefined, time: undefined, suggested: { due: '2026-10-01', said: 'before Friday' } },
    { text: 'Call legal', owner: 'Me', due: '2026-10-05', time: '10:00', suggested: { due: '2026-10-05', time: '10:00', said: 'Monday at ten' } },
  ])
  assert.equal(r?.summary, 'We agreed.')
  assert.deepEqual(parseNotes('TITLE: T\nTAGS: x\nACTIONS: none\nSUMMARY:\nS')?.actions, [])
  assert.equal(meetingDay(new Date(2026, 8, 25, 10).getTime()), 'Friday, 2026-09-25')
  assert.match(notesPrompt('[0:05] Me: Done by Friday.', [], 'Friday, 2026-09-25'), /^The meeting was on Friday, 2026-09-25\./)
  // A long meeting loses the start of its transcript, never the date line, the tags or the chat.
  const long = notesPrompt(`[0:00] Me: first\n${'x'.repeat(200_000)}\n[3:00:00] Me: last`, [{ role: 'user', text: 'q' }], 'Friday, 2026-09-25')
  assert.match(long, /^The meeting was on Friday, 2026-09-25\.\n\n<transcript>\n\(earlier part cut for length\)\n/)
  assert.ok(!long.includes('first') && long.includes('[3:00:00] Me: last\n</transcript>'))
  assert.match(long, /<assistant_chat>\nUser asked: q\n<\/assistant_chat>$/)
})

test('follow-up email: prompt carries notes and actions; the reply comes back as plain text', () => {
  const p = followUpPrompt({ title: 'Launch sync', summary: 'We agreed.', actions: [{ id: 'a', text: 'Send the deck', owner: 'Dana', due: '2026-10-02' }], transcript: 'Them: hi', day: 'Friday, 2026-09-25' })
  assert.match(p, /<action_items>\n- Send the deck \(Dana\), by 2026-10-02\n<\/action_items>/)
  assert.deepEqual(parseFollowUp('SUBJECT: **"Next steps"**\nBODY:\nHi Dana,\n\n**Thanks** for today.\n- Deck by Friday\n\nBest,'),
    { subject: 'Next steps', body: 'Hi Dana,\n\nThanks for today.\n• Deck by Friday\n\nBest,' })
  assert.equal(parseFollowUp('no format'), null)
})

test('recentHistory keeps the newest turns that fit, starting on a user turn', () => {
  const h = [
    { role: 'user' as const, text: 'aaaa' },
    { role: 'assistant' as const, text: 'bbbb' },
    { role: 'user' as const, text: 'cc' },
    { role: 'assistant' as const, text: 'dd' },
  ]
  assert.deepEqual(recentHistory(h, 100), h)
  assert.deepEqual(recentHistory(h, 8), h.slice(2)) // 'bbbb' fits too, but a turn can't start on the assistant
  assert.deepEqual(recentHistory(h, 1), [])
})

test('an empty NAME line is no name, not the WHY line', () => {
  assert.deepEqual(parseNameGuess('NAME:\nWHY: nobody names them'), { name: null, why: 'nobody names them' })
})
