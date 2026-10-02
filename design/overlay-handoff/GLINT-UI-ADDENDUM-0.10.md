# Glint UI Redesign: Addendum for 0.9.0 to 0.10.0

On 26 September 2026, three releases (0.9.0, 0.9.1 and 0.10.0, 36 files and roughly 2,100 lines) landed after `GLINT-UI-TOGGLES.md` and `GLINT-OVERVIEW.md` were written against version 0.8.0. This addendum lists what those releases added or changed that the two earlier documents do not cover, checked against the code on `origin/main` (commit `e2814d7`), and it uses the same tiers as `GLINT-UI-TOGGLES.md`: Tier 1 for controls needed mid-call, Tier 2 for per-meeting options and session detail, and Tier 3 for set-once settings.

---

## New controls

### Tier 1: on the overlay, during a call

| Control | What it does | Where it is |
|---|---|---|
| Smart mode | Off (default): fast answers from Claude Sonnet 5 without thinking, with the first words in about a second. On: Claude Opus 5, which thinks the question through and answers more thoroughly, but starts more slowly. | Bulb icon in the chat panel's input row, right of Send/Stop; also a switch in Settings → AI. No hotkey. |
| Copy code | Each code block in an answer shows its language and has its own Copy button, which copies exactly the code: indentation and tabs kept, no fences or labels, and no trailing newline that would run a pasted command. | On every code block in the chat |

Smart mode is a Tier 1 toggle in its own right, since a user decides per question whether they want speed or depth, and it therefore needs a visible on/off state on the overlay, which it has (the bulb turns blue).

### Tier 2: session detail (History → a session)

The notes Glint writes when a session ends now include a full action-item workflow, which makes the session detail page the second-busiest surface in the app after the chat panel.

| Control | What it does |
|---|---|
| Action items | A new section of the notes listing each task from the meeting, with a done checkbox and a date picker. Dates said in the meeting ("by Friday") are worked out from the meeting's date. Rewriting the notes keeps ticks, dates and reassignments. |
| Owner pill | Each task's owner shows as a pill holding the AI's best guess. Clicking it reassigns the task to you, anyone in the meeting, nobody, or a typed name; "Rename" there changes that person's name everywhere in the session (transcript, summary, owners and email) without rewriting the notes. |
| Add to calendar | Opens the dated, unticked items in Calendar, which asks which calendar to use: all-day on their date, or 30 minutes at their time. Adding them again updates the same events. Disabled until an item has a date. |
| Draft follow-up email | Has the AI write the email you would send after the meeting (thanks, decisions, who does what by when, next step), kept with the session. **Open in Mail** starts a new email with it; **Copy** copies the text. |

### Tier 3: Settings

| Where | Control | What it does |
|---|---|---|
| Settings → AI | Fast model / Smart model | Replaces the single Model field: each provider now has one model for fast answers and one for smart mode, six fields in total. |
| Settings → AI | Think before fast answers | Lets the fast model think first: more careful on hard questions, slower to start. Smart mode always thinks. |
| Settings → AI | Smart mode | The same switch as the bulb on the overlay. |
| Settings → Modes → a mode | Reference files | **Add files…** attaches PDF, Word, Markdown, text, EPUB or image files; each has a hold-to-confirm **Remove**. Their full text goes with every ask while the mode is active, whichever provider answers, and scanned pages and images are read with macOS text recognition. |

---

## Changes to the current layout

- **No title bars.** The Settings and welcome windows no longer have a title bar or a title; the red, yellow and green window buttons sit in the top corner of the page itself, so a redesign of either window has to leave that corner clear.
- **The input row has a third element.** The chat panel's input row is now text box, then Send (Stop while streaming), then the smart-mode bulb.
- **Move shortcuts only work while Glint is on screen.** ⌘ + arrows no longer take over those keys in every other app, and ⌘↩ now works in Glance.

---

## New behaviour with no control

These change what the user experiences without adding anything to place in the interface, but a redesign should not contradict them:

- **Answering:**
  - An empty ask repeats the last instruction for whatever is on screen now, so "explain this" carries on slide after slide.
  - "Rewrite", "try again" or "another one" gets a genuinely different answer rather than the last one reworded.
  - Questions from other people in the call are answered for the user; only attempts to change how Glint works are ignored and pointed out.
- **Speed and reliability:**
  - A provider that hasn't started answering within 15 s (longer for smart mode, Codex and large reference files) counts as failed, and the next fallback answers.
  - Claude Code stays running in the background while Glint is on screen, so its answers start in about 1 s instead of about 4 s.
- **Copying:** copied text is clean, with no markdown symbols, bullets shown as •, tables as tab-separated rows, and maths in normal notation (x², √2, ≤).
- **Robustness:**
  - The microphone reopens by itself if it disconnects mid-session, and a Mac going to sleep pauses the session.
  - A crashed chat panel reloads by itself.
  - One bad value in the settings file resets only that setting.
- **Privacy:** Claude Code and Codex run without the user's personal coding setup (instructions, hooks, plugins, tools), so nothing said in a meeting can reach those tools.

---

## Corrections to the earlier documents

**`GLINT-UI-TOGGLES.md`:**
- The AI Settings row lists one model per provider; there are now separate fast and smart models, plus the "Think before fast answers" switch.
- The chat panel description lacks the smart-mode bulb in the input row and the Copy button on code blocks.
- The History description lacks the Action items section, owner pills, Add to calendar and Draft follow-up email.
- The Settings layout description should note that the window has no title bar.

**`GLINT-OVERVIEW.md`:**
- The "Current state and limits" section says there is no way to attach reference files to a mode, which is no longer true.
- It also says there is no calendar integration. Action items can now be added to Calendar, although Glint still does not notice when a meeting is about to start.

---

Overall, the three releases add one new Tier 1 control (smart mode), turn the session detail page into a place where the user acts on a meeting rather than just reads about it, and double the model settings, so the redesign should plan for a second primary surface, session follow-up, alongside the in-call overlay.
