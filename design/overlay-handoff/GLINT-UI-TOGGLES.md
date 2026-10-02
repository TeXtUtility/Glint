# Glint UI Redesign: Toggles and Current Layout

As of 26 September 2026 (version 0.8.0, commit `3ee20ec`), Glint's controls are spread across five places: the control bar, the chat panel's toolbar, twelve global hotkeys, the menu bar menu, and a seven-page Settings window. This document lists every setting and control, sorts them by how quickly a user needs to reach them, and records how the interface is laid out today, so that the redesign can move things without losing any of them.

---

## Part 1: What needs to be easy to toggle

The sorting rule is simple: anything a user changes in the middle of a call, while someone is talking to them, has to be one click or one hotkey away on the overlay itself, whereas anything changed once per meeting can live one level deeper, and anything set once can stay in Settings. The overlay never takes keyboard focus from the app the user is in, so in-call controls must work by pointer or hotkey, never by tabbing through a menu.

### Tier 1: during a call, one click or one hotkey

These must be visible on the overlay (or bound to a hotkey) at all times, and each needs a visible on/off state.

| Control | What it does | Where it is today |
|---|---|---|
| Show / hide overlay | Hides both overlay windows | Hotkey ⌘\\, menu bar |
| Ask | Screenshot + new transcript + typed text to the AI | Hotkey ⌘↩, send button in the chat panel (the control bar's "Ask" pill only opens the panel) |
| Stop reply | Cancels a streaming answer | Send button turns into Stop while streaming |
| Start / stop session | Begins or ends transcription of the call | Hotkey ⌘⇧\\, round mic/stop button on the control bar, Start pill and stop icon in the chat toolbar, menu bar |
| Pause / resume session | Stops listening without ending the session; the timer stops too | Chat toolbar only (no hotkey) |
| Resume last session | Continues the most recent session | Chat toolbar (when idle), menu bar |
| Invisible mode | Hides every Glint window from screen sharing and recordings | Chat toolbar (eye icon), menu bar, Settings → General |
| Screen context | Whether asks include a screenshot | Chat toolbar (screen icon), Settings → General |
| Mode | Which saved prompt steers answers (General, Job interview, Sales call…) | Chat toolbar dropdown, Settings → Modes |
| Room mode | One mic hears everyone in the room (needs the user's recorded voice) | Chat toolbar (people icon), Settings → Voice |
| Speaker labels | Split "Them" into named people | Chat toolbar (tag icon), Settings → Voice |
| View: Transcript / Chat / History | What the chat panel shows | Chat toolbar tabs, ⌘T for Transcript |
| New chat | Clears the thread (not during a session) | Chat toolbar (+), ⌘R |
| Copy reply | Copies an answer | Copy icon on each reply |
| Name a new voice | "Who's this?" prompt: play, type a name, Guess, Not now | Notice bar in the chat panel when it appears |
| Dismiss an error | Clears a red failure notice | Dismiss button, or swipe the notice |

### Tier 2: per meeting or per task, within two clicks

These change between meetings rather than within one, so they can sit behind a single menu or popover on the overlay, but they should not require opening Settings.

| Control | What it does | Where it is today |
|---|---|---|
| Layout: Full / Glance | Shrinks Glint to a dot in a corner with one-line answers | Hotkey ⌃⌘\\, menu bar, Settings → General |
| Discreet mode | Fades the overlay until pointed at | Hotkey ⌥⌘\\, menu bar, Settings → General |
| Glance: answer questions automatically | One-line answers without being asked | Settings → General (only when Glance is on) |
| Copy replies automatically | Off / whole reply / first code block | Settings → General |
| Note on screenshots | Text drawn on every screenshot sent to the AI | Settings → General (global) and Settings → Modes (per mode) |
| Transcription language | Spoken language of the meeting, as a code such as `en` or `es` | Settings → AI (buried; users in multilingual jobs switch this per meeting) |
| AI provider | Claude API, OpenAI API, Claude Code, Codex | Settings → AI |
| Overlay opacity | Whole overlay, background glass, discreet fade | Settings → General (three sliders) |
| Move overlay | Reposition, or reset to default | Hotkeys ⌘ + arrows, drag the logo, double-click the logo to reset |

### Tier 3: set once, Settings is fine

| Area | Controls |
|---|---|
| General | Updates (check / install), keep focus in other apps while invisible, note position (above / below), open at login, theme (System / Light / Dark), Glance corner and time between automatic answers, restore opacity defaults, microphone test, redo onboarding, restart, quit |
| AI | API keys (save / remove), model name per provider, CLI sign-in status, fallback providers ("If it fails"), transcription engine (on this Mac / OpenAI), Whisper model size, OpenAI transcription model |
| Voice | Record / re-record / delete your voice, list of saved people (play, rename, delete), forget everyone |
| Modes | Add from 11 templates, create, edit (name, prompt, screenshot note), delete, set active |
| Shortcuts | Rebind all twelve hotkeys |
| Developer | Six speech-detection sliders, five voice-matching sliders, restore defaults |
| About | Version and system info (copy button), chat panel keys, release notes |

### Things that must stay visible, not toggled

A redesign should keep these readable at a glance, because the user needs them to trust what Glint is doing:

- **Recording:** whether a session is live, paused, and for how long.
- **Voice activity:** whether Glint is currently hearing "Me" and "Them".
- **Visibility:** whether invisible mode is on (today, a "Hidden from screen sharing" line under the panel, dropped in discreet mode).
- **Failures:** whether the AI or audio is failing (today, everything turns red and discreet mode never fades it).
- **Model downloads:** whether a speech model is still downloading, and how far along it is.
- **Updates:** whether an update is available (a dot on the Settings gear and a menu bar item).
- **Answering:** whether an answer is streaming.

### Things that must stay hard to trigger

Reset all settings, deleting a mode, deleting your voiceprint, deleting a person, forgetting everyone, and moving a session to the Trash currently use press-and-hold buttons (0.9 s), and they should stay deliberate in any redesign. Quit is a plain button in Settings and the menu bar and ends any live session.

### Gaps worth fixing in the redesign

- **Pause has no hotkey.** It is the most time-sensitive control without one (someone asks to speak off the record).
- **Transcription language lives three levels deep.** It sits in Settings → AI → Transcription, although a user in a multilingual job changes it per meeting.
- **Invisible mode has no hotkey.** It has a toolbar icon and a menu bar item, but no shortcut, although it is the control a user is most likely to need the moment a screen share starts.
- **Tier 2 controls are split across three places.** Discreet mode and Glance sit in the menu bar and hotkeys; automatic copy and Glance auto-answer only in Settings. A single "meeting options" popover on the overlay would gather them.

---

## Part 2: How the UI is formatted today

### Windows

| Window | Size | When it shows | Purpose |
|---|---|---|---|
| Control bar | 163 × 50, pill-shaped (25 px radius) | Always, while the overlay is shown in Full layout | Logo (drag handle; click toggles the chat panel, double-click resets position), Ask/Hide pill, round mic/stop button |
| Chat panel | 690 wide, 6 px under the control bar, centred on it | When opened | Input, notices, body (chat, transcript or history), toolbar |
| Glance | Up to 420 wide, sized to content, 12 px from a screen corner | Glance layout only; replaces both overlay windows | 28 px dot or one-line strip; 360 px card with the full answer on hover |
| Settings | 920 × 670 (min 760 × 480), normal window | From the gear, ⌘, or the menu bar | Seven pages in a left sidebar |
| Onboarding | 1100 × 720 (min 760 × 560), normal window | First launch, or Redo onboarding | Welcome → Permissions → Try it (practice steps) |

Chat panel heights: 104 px collapsed (120 px when the "Hidden from screen sharing" line shows), 500 px when a menu is open over the collapsed panel, a user-resizable 500 px default (350 minimum) when expanded on Chat or Transcript, and 760 px on History, clamped to the screen. Dragging either overlay window moves both, and the pair is kept inside the current display.

### Chat panel, top to bottom

1. **Input row.** A one-line text box that grows to three lines ("Ask about your screen…" or, in a session, "Ask about the conversation…"), and a round send button that becomes a red stop square while an answer streams.
2. **Notices.** A stack of full-width bars under the input: AI failures and audio errors (solid red, swipeable), the inactivity countdown (after 10 minutes idle, 40 s before the session ends), and the "New voice" naming prompt.
3. **Body** (only when expanded), with a hairline divider above it. It shows one of three views:
   - **Chat:** user messages as right-aligned tinted bubbles, each with a "Used screen" chip whose screenshot previews on hover; AI answers as full-width markdown (code, tables, maths) with a copy icon; a "↓ Latest" pill when scrolled up.
   - **Transcript:** timestamped lines, `[m:ss] Name: text`, where a speaker's name opens a menu to play, name, merge or guess them.
   - **History:** a search box, then sessions and chats grouped by day (Today, Yesterday, dates), each row showing its title, time, duration or "Chat", a live or notes status, and tags. A detail page shows the title (editable), actions (Resume session or Continue chat, Move to Trash), the summary (editable, with preview), the chat and the transcript.
4. **Toolbar**, in one row, from left to right:
   - Settings gear, with an update dot.
   - Icons for screen context, invisible mode, room mode and speaker labels.
   - The mode dropdown pill, then a divider.
   - When idle: the Start and Resume pills. During a session: pause, stop, the timer, and Me/Them voice dots.
   - At the right edge: the Transcript / Chat / History tabs and the + (new chat) button.
5. **Footer.** "Hidden from screen sharing" when invisible mode is on and discreet mode is off, and a resize grip along the bottom edge when expanded.

### Settings layout

A 190 px sidebar lists the pages (General, AI, Voice, Modes, Shortcuts, Developer, About) and the chosen page is remembered. Content sits in a column up to 680 px wide, built from full-width rows, each with a label and a grey hint on the left and the control on the right, separated by hairlines. The controls in use are switches, segmented controls (Theme, Layout, Note position, Copy replies), dropdowns (Glance corner, Whisper model), radio lists with descriptions (AI provider, transcription engine, active mode), sliders with a reset button, text fields that save on Enter or blur, and hold-to-confirm buttons for anything destructive.

### Visual language

- **Colours:** light and dark themes follow the system (or a manual choice), with a blue accent (`#4f6bff` light, `#7b8fff` dark), red for danger and failures, and green for "speaking".
- **Overlay surfaces:** translucent glass (90% opaque by default, adjustable), a 1 px border, a 14 px radius on the panel and a 25 px radius on the control bar.
- **Type:** the system font at 13 px (14 px in the input box, 11–12 px for metadata and hints).
- **Icons:** 16 px line icons, grey by default and blue when a toggle is on.
- **Motion:** short spring animations on menus, messages, notices, the segmented control's sliding pill and the tab pill. Tooltips (every overlay and Settings button has a one-line description after 0.5 s) use a plain 0.12 s fade. All motion is removed under Reduce Motion, and discreet mode stops the pulsing.
- **States that recolour the whole UI:** failing (red border on the panel and control bar, red Glance strip, red menu bar icon) and discreet (faded to 35% until pointed at, adjustable).

### Menu bar menu

Start or stop session, session history, resume last session, show or hide overlay, enable or disable invisible mode, discreet overlay (checkbox), Glance (checkbox), an "Update to …" item when one is available, Settings, Restart Glint, and Quit Glint. Glint has no Dock icon, so this menu and the overlay are the only ways in.

### Hotkeys (all rebindable)

| Action | Default |
|---|---|
| Show or hide overlay | ⌘\\ |
| Start or end session | ⌘⇧\\ |
| Ask | ⌘↩ |
| Settings | ⌘, |
| Move overlay | ⌘ + arrows |
| Scroll chat | ⌘⇧↑ / ⌘⇧↓ |
| Discreet mode | ⌥⌘\\ |
| Glance | ⌃⌘\\ |

Inside the chat panel, and only when it has focus: Tab to type, ⌘T for the transcript, ⌘R for a new chat, ↓ on an empty input for History, and Esc to step back (history detail → list → chat → collapse → hide).

---

Overall, the redesign's main job is to put the sixteen Tier 1 controls within one reach of a user who is mid-conversation and cannot take their eyes off the call, while gathering the scattered Tier 2 options into one place and leaving the long tail of set-once settings where it is.
