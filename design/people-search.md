# People search and memory

A spec for matching Cluely's "People Search & Memory" feature one to one, then going past it with what Glint already
has: voices it recognises, a full local record of every call, and whichever AI the user already pays for.

Sources for everything said about Cluely: the launch post ([cluely.com/blog/people-search-live](https://cluely.com/blog/people-search-live))
with its three images, and the docs page ([docs.cluely.com/feature/precall](https://docs.cluely.com/feature/precall)).

## What Cluely shipped

**The pipeline** (their "how it works" diagram, in order):

1. Pull calendar events.
2. Check which participants are external.
3. Search each one by full name and email through LinkedIn, Apollo and web search.
4. Check conversation history with them.
5. An LLM summarises, putting recent things and deliverables first.
6. Read the meeting title and details, and have an LLM write a short meeting overview.

**The brief** (their screenshot): the meeting title ("Cluely // The Incorporation Company of America Pilot"), the time
("Tuesday at 10:00 AM") and a Join meeting button. Under "Meeting overview" come two sentences: who the call is with,
and where things stood last time. Then one card per attendee:

- initials avatar, name, role and company, email, city
- email and X icons
- "Last talked about": links to past calls ("Intro Call", "Qualification Call")
- "About": a short paragraph on the person and their company

**Memory**: a "What you last talked about" section with the status of deals or projects, promises made last time, and
key topics. All of it is fed into the live assistant, so answers use it. Their example answer: "He's objecting to the
price. Last time, he mentioned he was interested in a competitor who charges 20% more…"

**Limits, from their docs:**

- It needs a calendar connection, and only Google Calendar is supported.
- Research runs on their servers and needs an internet connection.
- Briefs are made automatically for upcoming meetings and refresh when the meeting changes.
- Neither page says anything about where the research is kept, which sources a fact came from, or how to remove it.

## Part 1: the one-to-one clone

Everything Cluely does, built the Glint way.

### 1.1 Meetings from the calendar

- Read upcoming events from **macOS Calendar through EventKit**, run the same way Glint already runs PDFKit and Vision
  (JavaScript for Automation). That covers every account the Mac has: Google, iCloud, Exchange and Outlook. No OAuth,
  and no Glint server.
- It needs the Calendar permission. The packaged app declares `NSCalendarsFullAccessUsageDescription`, and the
  permission is asked for the first time the user turns briefs on, not during onboarding.
- Look ahead 24 hours, and refresh every 5 minutes and whenever the Mac wakes. Only events with at least one other
  attendee, or a video link, count as meetings.
- A meeting is `{ id, title, start, end, attendees: { name, email }[], url, notes }`, where `url` is the first
  Zoom, Meet or Teams link found in the event.

### 1.2 Who to research

- External attendees only by default: anyone whose email domain isn't the user's own. The user's addresses come from
  the calendar account's owner.
- For each one: full name plus email, the same inputs as Cluely.

### 1.3 Research

- Research runs through the user's own provider and its web search. Nothing goes to Glint, and Apollo isn't needed:
  - Claude API: the `web_search` server tool
  - OpenAI API: its web search tool
  - Claude Code: the `WebSearch` and `WebFetch` tools, allowed for this call only (asks keep `--tools ''`)
  - Codex: its web search flag (to verify)
- The prompt asks for a fixed shape: role, company, city, links, a short About paragraph, and a list of sources.
  Every fact has to come from a source that is returned with it.
- A profile is `{ name, emails, role, company, city, links, about, sources: { title, url }[], researchedAt }`. It is
  kept encrypted on disk like sessions, reused for 30 days, and can be refreshed by hand.

### 1.4 History with them

- Past Glint sessions with this person: any session whose `speakers` has their person id, or whose calendar
  attendees had their email.
- These show as "Last talked about" links, which open that session in the Follow-up window.

### 1.5 Summary

One fast-model call per meeting. It gets the meeting title and notes, the profiles, and the recent history (titles,
summaries, open action items), and returns:

- "Meeting overview": two sentences
- per person, a "What you last talked about" block: status of deals or projects, promises, key topics

### 1.6 The brief

- The Follow-up window gets an **Upcoming** group at the top of its sidebar. A meeting's page shows the title, the
  time, Join meeting, the overview, and one card per attendee with Cluely's fields.
- A notice five minutes before the start: "Brief ready: <title>", with Open and Join. It uses the same notice as
  "Notes ready".

### 1.7 Live use

- When a session starts within 10 minutes of a calendar meeting, it is linked to that meeting. The brief then goes
  into the system prompt as one cached block, next to the mode and its reference files, so it costs a cache read per
  ask, not a new write.
- The notes prompt gets the attendees' names, so action items name the right people.

## Part 2: where Glint goes further

Cluely's version is a calendar feature: it knows who was invited. Glint can know who is actually talking, keeps a
real record of every call, and works without a calendar at all.

### 2.1 It knows who is talking, not just who was invited

Glint already recognises saved voices across sessions. So context can follow the voice:

- Calls with no invite (phone calls, a Slack huddle, a meeting someone else scheduled), and in-person meetings in room
  mode.
- **Per-speaker context during the call.** When Dana starts talking, answers use Dana's history, not a blend of
  everyone who was invited.
- Wrong or missing invitees don't matter. The person who actually joined is the one who counts.

### 2.2 Live people search, during the call

Cluely researches before the call. Glint can also do it while the call is going:

- When a new voice is named (the "Who's Speaker 2?" tray, Guess, or the speaker menu), research starts for that name,
  and a short card lands in the panel a few seconds later.
- Names from the screen: at session start, the participant names on the Zoom, Meet or Teams tiles are read from the
  screenshot, the way Glint already reads screens.
- Introductions in the transcript ("Hi, I'm Priya from Northwind") work too. The name-guess prompt already finds them.
- On demand from anywhere: "who is this?" about a name on screen or in the chat.

### 2.3 Memory from real records

Cluely's memory is an LLM summary of past conversations. Glint has structured records, so it can be exact:

- **Promises, both ways**, from action items with owners, dates and ticks:
  - "You owe Dana: the SSO guide, due Fri 2 Oct, open."
  - "Dana owes you: the seat count, 3 days late."
  - Done items drop off, and the list is always current.
- **Quotes with the moment they were said**, linking to the transcript line ("0:41 Dana: I need the seat count before
  Friday").
- **Decisions** from each session's notes, and the follow-up email that was actually sent.
- A **People page** in the Follow-up window: one timeline per person, with every session, open items both ways, the
  profile and its sources, plus Rename, Forget research and Forget voice.

### 2.4 Any calendar, or none

- EventKit covers every calendar the Mac has, where Cluely supports only Google.
- With no calendar, voice recognition, names on screen and introductions still identify people. Briefs then show up
  during the call instead of before it.

### 2.5 Your own AI and search, no middleman

- Research and summaries run on the user's own Claude, OpenAI, Claude Code or Codex. There's no Glint server, no
  Apollo contract and no extra subscription. The provider fallback chain applies, as for every ask.
- Every fact in a profile shows its source, and a fact without a source is left out.

### 2.6 Every kind of meeting, not just sales

The active mode decides what research is worth doing. This is a new optional mode field, "Research focus", with
defaults per template:

| Template | Research focus |
|---|---|
| Job interview (all six) | The interviewer's role and team, the company's recent news, the job listing |
| Interviewing someone | The candidate's public work history against the job description |
| Sales call | Role, company size and news, past deals from history |
| Team meeting | No web research: open items and decisions from history only |
| Lecture | The lecturer's research area and course page |

### 2.7 Private by default

- Profiles and memory stay on this Mac, encrypted with the keychain like sessions. Only the searches themselves go to
  the provider.
- **Work facts only.** The research prompt allows role, employer, work history, public work output and company news. It
  excludes home address, family, health, religion, politics, finances, personal social accounts and photos.
- Forget research per person or all at once, and profiles expire after 30 days unless refreshed.
- The consent reminder already in onboarding covers transcribing. Settings adds a line that research only uses
  public, work-related information.

### 2.8 On every surface

- **Glance:** when a known person starts talking, the strip shows one line, e.g. "Dana Ruiz · CEO, Acme · you owe:
  SSO guide".
- **Transcript:** pointing at a speaker's name shows their card.
- **Ghost:** unchanged. The brief simply makes its answers better.

## Data

- `SavedPerson` gains `emails?: string[]` and `profileId?: string`. Naming a voice that matches a researched attendee
  joins the two.
- A new encrypted store `profiles.json`: `{ id, name, emails, role, company, city, links, about, sources, researchedAt }`.
- `SavedSession` gains `meetingId?`, `meeting?: { title, start, attendees }`.
- Memory isn't stored. It is worked out when needed from sessions, action items and notes, so it's never out of date.

## Build order

1. **Memory from what Glint already has.** No new permissions and no web research. This adds the People page,
   promises both ways, quotes, and per-speaker context during calls. It's the biggest gain, and costs no extra AI calls.
2. **Research on demand and live.** Name a voice, or ask "who is this?", and get a profile card with its sources,
   through the provider's own search.
3. **Calendar and pre-call briefs.** This covers EventKit, Upcoming, the meeting overview, the "Brief ready" notice,
   and linking sessions to meetings. At this step Glint matches Cluely one to one.
4. **Everywhere.** Names read from call tiles, introductions in the transcript, the Glance line, cards on transcript
   names, and the Research focus field on modes.

## Decisions needed

1. **Calendar source.** macOS Calendar only (suggested: every account, no OAuth), or also a direct Google connection?
2. **Automatic research.** Research every external attendee before every meeting (as Cluely does), or only on demand
   and when a voice is named? Automatic costs a web search per person per meeting.
3. **Codex.** If its CLI can't search in a way Glint can drive, research falls to the next provider in the chain, or is
   switched off for Codex.
4. **How long research is kept.** 30 days is suggested.
5. **Who counts as external.** Other email domains (as Cluely does), or everyone except the user.
