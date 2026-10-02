# Handoff: Glint overlay redesign (v0.8.0 → next)

## Overview
This redesign of Glint's floating overlay puts all 16 Tier 1 in-call controls (per `GLINT-UI-TOGGLES.md`) directly on the overlay. It also gathers the scattered Tier 2 options into one "Meeting options" sheet, and specifies the Glance corner layout. Three alternative overlay models are included (**1a Island**, **1b Edge column**, **1c Orb**). **Pick one to build first.** Glance (**2a**) applies to whichever you choose.

## About the design files
`Glint Overlay Redesign.dc.html` is a **design reference built in HTML**, not production code. Open it in a browser. `support.js` must sit next to it, and you need an internet connection for the icon font. Recreate the designs in Glint's existing native macOS codebase (SwiftUI/AppKit overlay windows, `NSPanel`s that never take focus), using its established patterns. Don't port the HTML.

Source docs (the product and behaviour spec): `GLINT-OVERVIEW.md` and `GLINT-UI-TOGGLES.md` are included.

## Fidelity
**High fidelity** for colour, type, size, radius and states. Icons are placeholders: Material Symbols Rounded stands in for Glint's existing 16 px line icons, so map each one to the app's own icon set. The mocks are static, so the timings and motion below come from the spec, not from the file.

## Shared rules (all directions)
- **Tier 1 on the surface:** screen context, invisible, room mode, speaker labels, mode picker, pause/resume, start/stop, Ask/Stop reply, and view switching. Each has a visible on/off state.
- **Tier 2 in one sheet: "Meeting options":** Layout (Full/Glance), Discreet, Glance auto-answers (disabled unless Glance), Copy replies (Off/Reply/Code), Spoken language (dropdown, e.g. "English · en"), AI provider (dropdown), Note on screenshots (text), Opacity (slider, 90% default).
- **Invisible-mode indicator (new):** every Glint surface gets a **1 px dashed border `rgba(123,143,255,.6)`** while invisible mode is on, and a **1 px solid border `rgba(255,255,255,.14)`** plus a "Visible on share" chip when it's off. This replaces the "Hidden from screen sharing" footer line, and it stays visible in discreet mode.
- **Failure takes over:** a 1 px `#ff5d5d` border, a 3 px `rgba(255,93,93,.15)` outer ring, background `rgba(64,22,26,.92)`, a red logo dot, and an inline message naming what failed and who answered instead, with a Dismiss button. It never fades in discreet mode.
- **Discreet:** the whole surface at opacity 0.35 until pointed at.
- **Always visible:** recording (a red 7 px dot plus a tabular-nums timer), Me/Them voice activity (6 px dots: green `#4cd98a` with a 6 px glow when speaking, `rgba(255,255,255,.25)` when idle), and whether an answer is streaming.
- Keep press-and-hold (0.9 s) for destructive actions. No new hotkeys were assigned (out of scope).

## Screens / views

### 1a Island (capsule + attached panel)
- **Capsule:** height 44, radius 22, padding `0 6 0 8`, gap 2, horizontally centred and 14 from the top. It contains, left to right:
  1. Logo, a 28×28 hit area holding a 10 px `#7b8fff` dot with a 4 px `rgba(123,143,255,.2)` ring. Drag it to move, click to toggle the panel, double-click to reset.
  2. Rec dot and timer (13 px/600).
  3. Me/Them dots with 11 px labels.
  4. A divider (1×20, `rgba(255,255,255,.1)`, margin 0 6).
  5. The mode chip: height 28, radius 14, bg `rgba(255,255,255,.06)`, 12 px, with a chevron.
  6. A divider.
  7. Four toggles, 32×32 circles. On: bg `rgba(123,143,255,.18)`, icon `#9aa9ff`. Off: icon `rgba(236,236,241,.55)`.
  8. A divider.
  9. Pause and stop (stop icon `#ff8080`).
  10. The Ask pill: height 32, radius 16, bg `#7b8fff`, text `#10121c` 12/600, with a "⌘↩" hint at 10.5 px, 60% opacity.
  11. A tune button (opens Meeting options; bg `rgba(255,255,255,.1)` while open).
- **Capsule states:**
  - Idle: "Ready" label, then Start (mic, "⌘⇧\") and Resume pills.
  - Paused: muted timer, a "Not listening" chip, and pause replaced by a blue "Resume" pill.
  - Streaming: the logo becomes a conic progress ring, an "Answering…" label shows, and Ask becomes "■ Stop" (bg `rgba(255,93,93,.18)`, text `#ff8a8a`).
  - Failure: the toggles are replaced by the message and Dismiss.
  - New voice: a 40 px tray below the capsule reading "Who's Speaker 2?", with a play button, a name field, "Guess: <name>" and "Not now". The labels toggle also gets a 7 px dot badge.
- **Panel:** 640 wide, 6 px under the capsule, radius 18, same glass.
  - Header: Chat/Transcript/History segmented tabs, plus "+" and a gear with an update dot.
  - Body: chat (user bubble bg `rgba(123,143,255,.16)`, radius 14, with a "Used screen" meta line).
  - Input at the **bottom**: 36 px field, radius 18, 14 px placeholder, with a 36 px send/stop button.
- **Meeting options popover:** 276 wide, radius 14, bg `rgba(34,35,44,.96)`, shadow `0 24px 60px rgba(0,0,0,.55)`, padding `12 14`, row gap 11, 12 px text. Switch: 28×16 track, 12 px knob. The segmented control is 11 px text in 2 px padding.

### 1b Edge column
- Docked full height to the left or right edge (12 px inset), 388 wide, radius 18.
- **Header:**
  - Row 1: logo, rec and timer, Me/Them mini level bars (four 2 px bars each), tune.
  - Row 2: mode chip, an "Everything / Answers" filter, History and Settings icons.
- **One timeline instead of tabs:**
  - Transcript lines use a `36px 1fr` grid, with a monospace 10.5 px timestamp, a 600-weight name and 12.5 px text.
  - Answers are inline cards (bg `rgba(123,143,255,.1)`, radius 12) placed at the moment they were asked.
  - The new-voice prompt is an inline card.
  - Unnamed speakers have a dotted underline.
- **Footer:**
  - Input row.
  - Toggle dock: a 6-column grid of icons with 10 px labels (Screen, Hidden, Room, Names, Pause, End). "On" cells get bg `rgba(123,143,255,.14)`.
- **Collapsed rail:** 52×380, radius 26, a vertical stack of logo, stacked timer, voice dots, 4 toggles, pause/stop, and Ask at the bottom (36 px circle). State variants match 1a.

### 1c Orb
- **Orb:** 60 px, bottom-centre.
  - Voice ring: a conic gradient, green for Me and `#ececf1` for Them, on a `rgba(255,255,255,.1)` track.
  - Inner disc: 50 px, `#1f2029`.
  - A 72 px dashed halo indicates invisible mode.
  - Click the orb to ask.
- **Hover:** fans out 7 buttons (36 px) on a 78 px radius over the upper semicircle, in order: room, labels, screen, invisible, pause, stop, options. Each has a tooltip.
- **Under the orb:** a status chip (rec, timer, mode) and a one-line live caption of the latest utterance.
- **Answers:** stack as cards above the orb (480 wide, radius 16). Older cards peek behind at reduced width and opacity. Each card has pin, copy and expand actions; expand opens the full panel (transcript/history).
- **State variants:**
  - Idle: grey ring and a "Start" chip.
  - Paused: pause glyph.
  - Streaming: blue conic plus a stop square.
  - Failure: red ring, error glyph and a red chip.
  - New voice: `person_add` badge.
  - Discreet: 35% opacity.
  - Invisible off: no halo.

### 2a Glance
- **Resting:** a 28×28 pt glass circle, 12 pt from the chosen corner (bottom-right by default), with an 8 px status dot that **never animates**:
  - Grey `rgba(236,236,241,.55)`: live and listening.
  - Blue `#7b8fff`: working on an answer.
  - Hollow ring (1.5 px border, `rgba(236,236,241,.7)`): paused.
  - Faded hollow ring (`.28`): no session.
- **Strip:** height 28, radius 14, max width 360, padding `0 9 0 12`, gap 8, 12 px single line with ellipsis. The dot stays at the corner end.
- **Failure strip:** bg `rgba(72,22,26,.94)`, 1 px `#ff5d5d` border, text `#ffd0d0`, red dot. It doesn't dim or collapse.
- **Inactivity strip:** "No speech for 10 min · ending in 0:32" plus a "Keep going" button (22 px, `#7b8fff`).
- **Hover card:** 360 wide, opens toward the screen centre, 36 px above the strip, radius 14. It shows the question in 11 px grey, then the formatted answer (at most about 5 lines), any error, and a "Speaker 2 is waiting to be named" row.

### 3 · 0.9–0.10 additions (see `GLINT-UI-ADDENDUM-0.10.md`)
- **3a Smart mode bulb:**
  - 1a: a labelled "Smart" pill next to Ask.
  - Input row: text box, Send/Stop, bulb (36 px). On: bg `rgba(123,143,255,.18)`, icon `#9aa9ff`, filled. Off: 1 px inset ring `rgba(255,255,255,.12)`.
  - 1b: a 7th dock cell. 1c: the top of an 8-button fan; the orb centre shows the bulb while smart mode is on.
  - Glance: no new dot colour; the card names the model.
  - While thinking, the answer header reads "Thinking it through · N s".
- **Code blocks:** bg `#121319`, 1 px `rgba(255,255,255,.07)`, radius 10, 12 px monospace. A header row shows the language (11 px monospace) and a Copy button that becomes "✓ Copied" (green tint `rgba(76,217,138,.14)`, text `#7ee3a9`) for 1.5 s.
- **3b Session follow-up in the panel:**
  - The History → session page opens on a new Follow-up tab (Follow-up / Chat / Transcript), with Resume and ⋯ (Rewrite notes, Move to Trash by hold).
  - Content: title 19/600, meta and tags, editable summary, then Action items.
  - Each action-item row is a `28px 1fr auto auto` grid: checkbox (16 px, radius 5), text, owner pill, date pill. Pills are 22 px, radius 11.
  - An ✦ on the owner pill marks the AI's guess and disappears once confirmed.
  - The owner menu (230 px) lists You, the participants, unknown speakers, Nobody, a "Type a name…" field, and "Rename '<name>'…" (applies everywhere in the session, without rewriting the notes).
  - "Add N to Calendar" counts dated, open items and is disabled at 0.
  - Follow-up email card: Redraft, Copy, and Open in Mail (primary).
- **3c Follow-up window:** title-bar-less, 920×640. It has a 220 px session sidebar, a header with the tabs, action items grouped By owner / By date (drag between owner groups to reassign), and a 300 px right column with a Calendar card and the email.

### 4 · Remaining surfaces
- **Settings shell:** 920×670, no title bar, traffic lights in the sidebar corner (the sidebar content starts 34 px down). Sidebar 190 px, `#16171d`. Content column max 680 px. Rows are label plus 11.5 px grey hint on the left, control on the right, 12 px vertical padding, hairline `rgba(255,255,255,.06)`. Section labels are 11/600, uppercase, 0.04em.
- **Controls:**
  - Switch: 32×18 track (on: `#7b8fff`) with a 14 px knob.
  - Segmented: 2 px padding on `rgba(255,255,255,.06)`, pill `rgba(255,255,255,.12)`.
  - Hold-to-confirm: red-tint pill with a fill that grows left to right over 0.9 s.
- **4a General:**
  - An update banner at the top.
  - Overlay: Layout, Glance corner (a 2×2 corner picker), auto-answer switch, gap slider (20 s), keep focus, note position.
  - Opacity: three sliders plus Restore defaults.
  - Mac: theme, open at login, mic test with a live meter.
  - Footer: Redo onboarding, Restart, Quit, and Hold to reset all settings.
- **4b AI:**
  - The provider list is also the fallback chain: drag to reorder. Top row: radio "answers first". Others: checkbox "fallback N". Each shows key or sign-in status.
  - Below it, a note on the 15 s timeout.
  - Models grid: provider × Fast/Smart (6 fields).
  - Switches: Smart mode, Think before fast answers.
  - Transcription: engine segmented control, Whisper model with determinate download progress, default spoken language.
- **4c Modes:**
  - A 210 px mode list (active tag; a paperclip for modes with files, plus "New mode" and "From a template").
  - Editor: instructions, per-mode screenshot note, and reference files (icon, name, size or word count, hold-to-remove, text-recognition progress for scans, total word count hint), plus Hold to delete mode.
- **4d Voice:** your-voice card (waveform, Play, Re-record, Hold to delete); speaker labels switch; the people list (play, inline rename, hold to delete); Hold to forget everyone.
- **4e Shortcuts, Developer, About:**
  - Shortcuts: keycap fields; a field turns accent with "Press keys…" while recording. Pause and Invisible have empty "Record…" fields with no defaults.
  - Developer: grouped sliders with monospace values.
  - About: version, commit, Copy system info, What's new.
- **4f Menu bar:**
  - The item shows a ring icon plus the timer while a session is live, and a solid red dot on failure.
  - The menu opens with a status header, then: session actions / overlay toggles / history, update, settings / restart, quit.
- **4g / 5a / 5b Onboarding:**
  - Window: 1100×720, no title bar. A 300 px step rail on the left: done = check in an accent tint, current = filled number, upcoming = ring.
  - Welcome: headline 34/600, three feature cards, the consent and assessment notice, and Get started.
  - Permissions: one card per permission (Allowed state, or Open System Settings as the primary action), plus speech-model download progress in the footer.
  - Try it: the real overlay is live above the window, and the control being taught gets a 6 px accent halo. A checklist of 4 practice steps, and a sample-call panel with progress and a live cue.
- **4h Panel views:**
  - Transcript: inactivity notice with Keep going; speaker menu (Play a clip, Name…, Guess, Merge with…); "↓ Latest" pill.
  - History list: search, day groups, rows with tags and a status pill ("3 to do", "Live", "All done", "Continue chat"), and "Open window" to open 3c.
- **5c Template sheet:** 680 px. The 11 templates in two groups, with search; the selected card gets an accent ring. The footer shows a tip and Add mode.
- **5d Date picker:** 290 px popover. Quick chips (Today, Tomorrow, and the date spoken in the meeting, marked ✦), a month grid with the meeting day ringed, All day / At a time, Clear, Done.

### Motion (4i)
All motion is specified in section **4i** of the canvas:
- Standard spring: response 0.35 s, damping 0.86.
- Snappy spring: response 0.22 s, damping 0.9.
- Fades: 0.12–0.15 s.
- No bounce, shake, pulse or loop anywhere in the call's line of sight.

Each row there gives the trigger, motion, timing and Reduce Motion fallback.

## Interactions & behaviour
- **Glance timing:**
  - A new answer fades in over 0.15 s.
  - After 8 s it dims to the discreet level (35%).
  - After 60 s it collapses to the dot.
  - It changes only when new text arrives: no scrolling, pulsing or bouncing.
- **Glance auto-answer:** only during a live, unpaused session.
  - A line counts as a question if it ends in "?" or (in English) starts with what/how/can/should etc.
  - Glint waits 0.6 s, then sends the recent transcript with no screenshot.
  - The answer is about 12 words.
  - Automatic answers are at least 20 s apart (adjustable) and never auto-copied.
  - If the AI has nothing useful, nothing is shown.
  - Every automatic answer is saved to the chat.
- **Glance input:** click returns to the Full layout with the chat open. ⌘↩ asks, with the answer constrained to one line. ⌃⌘\ toggles Glance and ⌘\ hides/shows.
- **Motion elsewhere:** keep the existing short springs for menus, messages, notices and segmented pills, and the 0.12 s tooltip fade. Remove all motion under Reduce Motion.
- **Focus:** the overlay never takes keyboard focus, and every in-call control is reachable by pointer or hotkey.

## State
`session: idle | live | paused` · `answering: bool` · `failure: {what, fallbackProvider}?` · `pendingVoice: {speakerId, guess?}?` · `invisible: bool` · `discreet: bool` · `layout: full | glance` · `glance.strip: {text, shownAt, kind: asked|auto}?` · `inactivityCountdown: seconds?` · `panelView: chat | transcript | history` (1a/1c) · `mode`, `screenContext`, `roomMode`, `speakerLabels`, `copyReplies`, `language`, `provider`, `opacity`, `screenshotNote`.

## Design tokens (dark)
- **Text:** `#ececf1`. Muted text: `rgba(236,236,241,.55–.65)`. Faint: `.35–.45`.
- **Glass:** `rgba(28,29,36,.9)` with `backdrop-filter: blur(24px)`. Popover: `rgba(34,35,44,.96)`.
- **Fills:** hairline `rgba(255,255,255,.07)`, divider `rgba(255,255,255,.1)`, chip `rgba(255,255,255,.06)`.
- **Accent:** `#7b8fff`. Accent text on dark: `#9aa9ff`. Accent tint: `rgba(123,143,255,.18)`.
- **Danger:** `#ff5d5d` / `#ff8080` / `#ff8a8a`. Danger tint: `rgba(255,93,93,.18)`.
- **Speaking:** `#4cd98a`.
- **Type:** system font. 13 base, 12 chips/controls, 11 meta, 14 input, 10.5 monospace timestamps. Tabular nums for timers.
- **Radii:** 22 (capsule), 18 (panel), 16 (cards, pills), 14 (popover, strip, chips), 12 (inline cards), 7–9 (segmented).
- **Hit targets:** 32 (icon buttons), 36 (send/orb buttons), 28 (chips, Glance).

## Assets
None beyond icons. The Material Symbols Rounded names used are: screenshot_monitor, visibility_off / visibility, groups, sell, pause, play_arrow, stop_circle, tune, mic, history, settings, add, auto_awesome, error, person_add, translate, bolt, push_pin, content_copy, open_in_full. Map each to Glint's own icons.

## Files
- `Glint Overlay Redesign.dc.html` is the design canvas, newest section first:
  - Section 5: onboarding Welcome and Try it, the template sheet, the date picker.
  - Section 4: Settings, menu bar, Permissions, panel views, and the motion map.
  - Section 3: smart mode, code copy, session follow-up.
  - Section 2: Glance.
  - Section 1: the overlay directions (1a/1b/1c) with their state rows.
- `screenshots/` holds 2× renders of each option with its state rows: `1a-island.png`, `1b-edge-column.png`, `1c-orb.png`, `2a-glance.png`.
- `support.js` is the runtime the canvas file needs to open.
- `GLINT-UI-ADDENDUM-0.10.md` covers the 0.9–0.10 changes.
- `GLINT-OVERVIEW.md` and `GLINT-UI-TOGGLES.md` are the product and control inventory the design is based on.
