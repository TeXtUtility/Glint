## Unreleased

- **Glint is public, and installs with curl.** `curl -fsSL https://raw.githubusercontent.com/TeXtUtility/Glint/main/install.sh | bash`, with no GitHub CLI or sign-in. Update checks talk to GitHub over plain HTTPS. Its app ID is now io.github.textutility.glint. Copies installed before this don't see updates: install once with the line above.
- **CI.** Every push and pull request runs the type check, the tests and a build on GitHub's Macs.

## 0.15.0 (2026-10-02)

- **Take notes when a call starts.** When a call app starts using the mic (Zoom, Teams, Webex, FaceTime, Slack, Discord, or a browser in a Meet, Teams or Zoom call), a prompt under the capsule or on Glance's strip offers Take notes, Not now or Turn off. Glint only reads which apps use the mic, never the audio; Settings → General turns it off.
- **Guess reads the calendar invite.** Naming a speaker uses the invite for the meeting in progress for full names and spellings, and with one other invitee and one other speaker it names them. The first Guess asks for calendar access.
- **Humanize answers.** Settings → AI connects Emulate, StealthGPT, WriteHuman, Undetectable.ai or your own endpoint to rewrite finished answers in Chat, follow-up emails, Glance and Ghost. Code, maths and links never leave Glint, and its switch sits in Meeting options or on the capsule.
- **Ghost, like the Ghost app.** The strip has the Ghost app's look and keys (fade, text size, hide, back to its corner), drags anywhere, even over the menu bar, and ⌃⌥⌘↩ asks about the screen. It shows the answer only once it's whole, and Settings → General can stop it skipping ahead when you go off script.
- **Run commands.** Shell blocks get a Run button that types them into an open, idle terminal behind a y/N prompt with a red warning, and only y runs them, in your own shell. Settings → General picks the terminal.
- **Discreet mode for in-person meetings.** The controls fade to grey and ignore the pointer while the answer stays sharp, a sentence at a time. The Mac's blur fades with them.
- **Arrange the capsule.** Settings → Overlay drags controls between the capsule and Meeting options. Compact mode keeps the dot, the chat box, Ask and Meeting options, with the rest at the top of the chat panel.
- **An empty Ask helps with what's on screen now,** with the chat as context, instead of sending the last question again. Quoted text in a reply (a rewritten email, a line to say) gets its own Copy button.
- **Lighter.** The speech and speaker models run in workers that end with the session, so Glint drops from about 930 MB during a call to 116 MB after. The app is 361 MB instead of 493 MB, voice detection takes 6% of a core instead of two cores, and Settings → Transcription shows and removes models nothing uses.
- **Cheaper asks.** Searched reference files send only the best matches, screenshots are capped at 1568 px, and new installs fall back only to Claude Code and Codex, so paid APIs are opt-in.
- **Developer tools** (Settings → About) add a Developer page with a verbose live log and a bug report to download. Errors go to ~/Library/Logs/Glint/main.log, Open at login is a checkbox in onboarding, and the icon is a white ring with a glint.
- **Current Claude models.** New installs answer with Claude Sonnet 5.5 and think with Opus 5.5 in smart mode; a model you picked stays. An answer that hits the length limit says it was cut off instead of being saved as whole.
- **Updates install what they listed.** The Update button builds exactly the commit it showed you, and checks it (types and tests) before it replaces Glint. Installing needs Node.js 22.18 or later.
- **Safer links and Run.** Links in answers show where they go, and a command block with hidden control characters isn't run.
- **Only you can install Glint.** Its signing key moved to a keychain of its own that stays locked: installing asks you to choose a password, and every update asks for it. Glint now runs with macOS's hardened runtime and keeps its code in a checked archive, so no other app can inject code into Glint, change it, or sign as it to use its microphone, screen and keychain access. After the first install with it, macOS asks for Glint's permissions again, and once for its keychain item: click Always Allow.
- **Call offers only read browser windows.** The take-notes offer no longer mistakes a Teams, Discord or Webex app window for a browser call, and Webex and Discord calls in a browser are offered again.
- **Fixes:** read-backs and repeated numbers are no longer dropped as echo; reference search finds "prices" for "price", and a retry searches the original question; a resumed session quit while live gets its notes at the next launch; an ask stopped while Claude Code starts is dropped; a late update check can't undo a queued install, and a GitHub login that can't see the repo says so; a speaker menu keeps what you typed; changing provider in Meeting options clears the CLI model; calendar events escape semicolons and use current names; a fixed slip in Ghost doesn't count toward the next; `$` in ~~~ blocks has no stray backslash; New chat and deleting a session can't overwrite or bring back a saved chat; the panel shows at once; discreet mode keeps the Whole overlay opacity; after asking in Ghost, typing goes back to your app; ⌘, opens Glint Settings only while its panel is up; a full disk can't leave the speech model downloading forever; Whisper languages no longer stall the overlay, and their model is freed after the session; a damaged settings file no longer deletes modes' reference files; renaming a live session sticks; notes for long meetings keep the meeting's date; "Another question: …" isn't taken as a retry; code in lists and tables isn't sent to the humanizer; shortcuts macOS refuses are flagged in Settings; a call with no sound at all for a minute says macOS may be blocking it; scrolling up while an answer streams stays put.

## 0.14.0 (2026-09-27)

- **Big reference files.** A mode can hold up to 15M characters of files, ten times more. Files that fit in one ask (1.5M characters) are still sent whole. Past that, Glint searches them for each question and sends the passages that match, with their page numbers. Under your question, "Searched your files: 14 passages, pages 212 to 240" shows what was used; click it to see the passages. Settings > Modes says when a mode is searched.
- **Better transcription.** English runs on NVIDIA's Parakeet (2.1% word errors against Moonshine's 3.4% on LibriSpeech), 24 other European languages on Parakeet v3, and the rest on Whisper.
- **Live words.** English speech appears word by word as it's spoken, then settles on the final text when the speaker stops. On by default for on-device English; switch it off in Settings > AI > Transcription.
- **Calls on speakers.** The other side's voice coming out of your speakers and into your mic no longer shows up a second time as "Me": every mic line's words are checked against the call's. Headphones still give the cleanest transcript.
- **Steadier speaker names.** Short lines take the closest voice heard on their side of the call, lines named only from context show as "Name?", and when a session ends, voices that turn out to be the same person fold together before the notes are written.
- **Follow-up window.** Every session's notes in one window: action items by owner or by date, drag to reassign, a date picker that suggests the date the meeting said, calendar events and a follow-up email that drafts as you watch. A "Notes ready" notice opens it when a session's notes are done.
- **The overlay, redesigned.** Frosted glass behind the capsule, panel and Meeting options; the panel opens out of the capsule, controls morph, and replies fade in word by word. Replies and Glance name the model that answered, and the bulb fills in smart mode.
- **Onboarding, redesigned.** A step rail, new Welcome and Permissions pages, the speech model downloading while you read, and a practice run on a spoken sample call with the real overlay.
- **Settings polish.** A template picker for modes, page counts and text-recognition progress for reference files, a waveform and playback for your voice, and how many sessions each person was heard in.
- **Beta updates.** Settings > General > Update channel: Beta builds from the newest work before it's released, listing what each update adds. Back on Stable, Glint offers the release again.
- **Updates during a call.** "Install update after this session" queues it: it builds and restarts once the session ends, so it never slows the call.
- **Fixes:** code blocks no longer flash while a reply streams; the capsule's blur no longer thins out when the mode menu or a tooltip opens; the panel doesn't fade under the pointer; dragging an unused AI provider into the list ticks it; resuming a session whose file was deleted no longer breaks saving its chat; a speech model that fails to download in Settings says so there.

## 0.13.0 (2026-09-26)

- **Settings, redesigned.** A sidebar with icons, sections with small labels, and each row's explanation on the left with its control on the right. It follows your Light or Dark theme.
  - **General:** an update banner when one is waiting; Overlay (layout, a corner picker, Glance's automatic answers, Ghost's typing permission, invisible, keep focus, discreet); Asking (screenshot, note, copying); Opacity; Mac (theme, open at login, a microphone test that names the device, updates); then Redo onboarding, Restart, Quit and Hold to reset.
  - **AI:** one provider list that is also the fallback order. Drag it (or use the arrow keys): the top one answers first, and the ticked ones below take over in order. Each row shows its key or sign-in status. Then fast and smart models side by side, Smart mode, Think before fast answers, and transcription.
  - **Modes:** a list (the active one tagged, a paperclip for ones with files) beside the editor: name, Make active, instructions, note, reference files with word counts.
  - **Voice:** your voice, Room mode and Speaker labels, and the people Glint knows, with play, rename and delete.
  - **Shortcuts** as keycaps in groups, including the chat panel's own keys. **About** shows the version and the exact build, with Copy system info.
  - Saved API keys are still never shown, not even partly.
- **Pause and Invisible shortcuts.** Set them in Settings → Shortcuts (they start blank). Pause only takes its keys while a session runs.
- **The menu bar shows the session.** A ring, with the session timer beside it while one runs (frozen while paused), so you can tell it's recording with the overlay hidden. It turns into a red dot while something is failing. The menu opens with what's failing and "Session live · 12:48" and your mode, then the session, overlay, history and settings items grouped, with their shortcuts.
- **The capsule:** a chat-box button opens the panel with the cursor in the input. Start and Resume are icons, Pause becomes a play button, and Smart and "Visible on share" moved off it (the bulb is by Send). Tooltips now work on the overlay, which macOS doesn't normally send hover to. Meeting options no longer makes the capsule jump, and it ends with All settings… .
- **Invisible mode's edge is easier to see:** a brighter dashed edge with a soft glow on the capsule, panel, tray and Glance, and a plain thin edge when you're visible on a share.
- **Fixes:** when "Keep focus in other apps while invisible" stops the chat box taking keys, it now says so, and a click opens that setting. The empty space around the capsule no longer swallows clicks meant for the chat box. Clicking into the input always takes the keyboard. Tooltips on the collapsed chat box aren't cut off. Settings and onboarding don't flash white while loading. Shortcuts are written in Mac order (⌃⌥⇧⌘).

## 0.12.3 (2026-09-26)

- **Your screenshot note works as part of the screen.** It used to get flagged as a prompt injection, because the prompt told the AI to ignore anything on screen that asked it to act differently. Now what the screen says about the task (a note on how to answer, a worksheet's "show your work", a form's word limit) shapes the answer, and only real hijack attempts are ignored: "ignore your instructions", "reveal your prompt", or anything working against you. The note is drawn as a plain light bar, like any toolbar on screen, and nothing marks it as added.

## 0.12.2 (2026-09-26)

- **The note on screenshots is only the note.** The AI is no longer told about it ("The white band at the top of the screenshot is a note I added for you…"): the text on the screenshot is all there is, so every ask with a note is a little shorter.

## 0.12.1 (2026-09-26)

- **The note on screenshots is just your note.** The gray "Note from the user. Added by Glint, not part of the screen." line above it is gone. The prompt already tells the AI where the note is, which is what it relies on, so the band is shorter and carries only what you wrote.

## 0.12.0 (2026-09-26)

- **A new overlay: the capsule.** The control bar is now one capsule with every in-call control on it: screen context, invisible mode, room mode, speaker labels, the mode, pause and stop, Smart, and Ask (Stop while an answer comes in). It shows the timer, who's talking, and whether Glint is answering. Drag its dot to move it, click the dot to show or hide the panel.
  - **Meeting options** (the sliders button) gathers what changes per meeting: layout (Full, Glance or Ghost), discreet mode, Glance's automatic answers, copying replies, the spoken language (it applies to the call you're in), the AI provider, the note on screenshots, and opacity.
  - **"Who's Speaker 2?"** now hangs under the capsule, with play, a name field, Guess and Not now.
  - ⌘↩ works whenever Glint is on screen, not only while the panel is open.
- **The panel** has Chat, Transcript and History on top and the input at the bottom, next to the Smart bulb. Each answer says who is answering and in which mode, and "Thinking it through · 4 s" while smart mode thinks. Code blocks have a Copy button that says Copied.
- **Follow-up in History.** A session opens on its follow-up: title, summary (click it to edit), action items with owner and date pills (✦ marks the AI's guess until you confirm it), Add to Calendar, and the follow-up email. Rows in History say how many to-dos are left, or All done, Live or Continue chat.
- **You can see whether you're hidden.** Every Glint surface has a dashed blue edge while invisible mode hides it from screen sharing, and a plain edge with "Visible on share" when it doesn't.
- The overlay is always dark, and nothing on it pulses or loops any more.
- **Fixes:** very long chats no longer overflow the model's context; the spoken language setting only takes language codes like `en`; the longest line is capped at 28 s so none of it is lost; Reset all settings can't bring the old settings back; a code-only answer still shows in Glance.

## 0.11.0 (2026-09-26)

- **Ghost.** A third layout, next to Full and Glance (Settings → General → Layout, the menu bar, or ⌃⌘G): the corner strip becomes a typing teleprompter, the same as the Ghost app. It shows the answer a few letters at a time with Ghost's progress ring, and moves along as you type it into any app. A wrong key turns red and waits for backspace; a skipped, swapped or added word catches up by itself; quotes and dashes match what your keyboard types. It keeps up just as well with a long, several-paragraph answer. Pointing at it shows the text around where you are.
  - ⌘↩ looks at your screen and answers what's there (a question, a form) with only the text to type: no "Here's a better version", no quotes or markdown, thought through. In a chat it redoes the last thing you asked for.
  - ⌘⇧↩ opens a small box to type a question.
  - ⌃⌥⌘[ and ] step through earlier answers, like Ghost's snippets, and each keeps your place.
  - ⌃⌥⌘← and → skip back or forward a word.
  - Forms: answers for separate fields are split by ⇥. Press Tab, or just click into the next field and start typing.
  - ⌘\ hides Ghost like the rest of Glint, and it stops watching keys while hidden. It needs macOS's Input Monitoring permission (Glint asks). Keys only move the strip: they're never saved or sent anywhere, and password fields aren't seen at all.
- **The corner setting** now applies to Glance and Ghost.
- **If you're on a version before 0.9.0**, Settings' update button can't install new versions (a bug fixed in 0.9.0), and recording a shortcut there could switch every shortcut off. Run the install line from the README once to get current.

## 0.10.0 (2026-09-26)

- **Action items after every meeting.** The notes Glint writes when a session ends now include a to-do list: each task, who does it, and a date (and time) when one was said, with "by Friday" worked out from the meeting's date. Tick items off and change dates in place; rewriting the notes keeps your ticks, dates and reassignments.
- **Names are pills.** Each action item's owner is a pill: the AI's best guess, reassignable to you, anyone in the meeting, nobody, or a name you type. Rename someone from a pill (or name them in the transcript) and the summary, owners, transcript and email all show the new name, without rewriting the notes.
- **Add to calendar.** Opens the dated, unticked items in Calendar, which asks which calendar to add them to: all-day on their date, or 30 minutes at their time. Adding them again updates the same events.
- **Draft follow-up email.** Writes the email you'd send after the meeting, in your voice: thanks, decisions, who will do what by when, next step, with natural dates ("by Wednesday, Sep 30"). Open in Mail starts a new email with it; Copy copies the text. It's kept with the session.
- **Code you can paste.** Every code block shows its language and has its own Copy button that copies exactly the code: indentation and tabs kept, no fences or labels, and no trailing newline that would run a pasted command. Answers are asked for code you'd ship: correct, idiomatic, complete, in blocks tagged with their language, and commands without a `$` prompt. Auto-copy's "first code block" also drops the indentation of a block inside a list.

## 0.9.1 (2026-09-26)

- **Other people's questions are answered for you.** The prompt's guard against instructions planted in a call or on screen could read as "don't act on what others ask". It now says plainly that a question or task from someone else is exactly what to help with (answer it, or give you the words to say), and only an attempt to change how Glint itself works is ignored and pointed out.

## 0.9.0 (2026-09-26)

- **Answers start in about a second.** Fast answers, the default, use Claude Sonnet 5 without thinking. Smart mode (the bulb next to Send) uses Claude Opus 5 and thinks it through. Settings → AI sets both models for each provider, and whether fast answers may think first.
- **Claude Code stays warm.** While Glint is on screen or a session runs, a `claude` process is already started and waiting, so an ask skips its 1 to 4 s startup. Each chat keeps its process: a follow-up sends only the new question and is answered from the cached conversation. Through Claude Code, the first words of an answer now arrive in about 1 s instead of about 4 s.
- **A stalled AI hands over.** A provider that hasn't started answering within 15 s (longer for smart mode, Codex and big reference files) counts as failed, and the next fallback answers.
- **Reference files for modes.** Add PDF, Markdown, text, Word, EPUB and image files to a mode in Settings → Modes. The AI gets all of their text, word for word, with every ask while the mode is active, whichever provider answers. PDF pages keep their printed page numbers so answers can cite them, and scanned pages and images are read with macOS text recognition. The text is stored encrypted on this Mac. The Claude API caches the files for an hour, and Glint puts them in the cache before your first ask, so later asks read them at a tenth of the price.
- **Chats carry on.** Asking with nothing typed repeats your last instruction for what's on screen now, so "explain this" keeps going slide after slide. "Rewrite", "try again", "another one", or asking about the same thing again gets a genuinely different answer, not the last one reworded.
- **Better answers.** A rewritten system prompt: the answer first, right or honest about what's unsure, words you can say out loud, in your language, and other people's words on screen or in the call are never taken as instructions.
- **Clean copies.** Copy and auto-copy give plain text: no `**`, `#` or backticks, bullets as •, tables as tab-separated rows, and maths in normal notation (x², √2, (a+b)/(2c), ≤, π). Stray markers some models leak into replies ("filecite…turn0file3") are removed from what's shown, copied and saved.
- **No title bar.** The Settings and welcome windows have no title bar or title; the window buttons sit in the corner of the page.
- **Tooltips.** Hovering a button for a moment says what it does, and a disabled one says why. The send button turns into Stop while a reply streams, view tabs and short Settings choices are segmented controls, destructive actions are hold-to-confirm, and toasts can be swiped away.
- **Updating from Settings works.** Glint never quit for the new version, so Settings stayed on "Updating…". Now the new build is copied in beside the old one and swapped, Glint restarts as soon as no session is live and the last session's notes are written, and a failed swap puts the old version back.
- **Claude Code and Codex run clean.** Claude Code runs without your CLAUDE.md, hooks, plugins, skills and MCP servers, and Codex with only its login, so your coding setup stays out of meeting answers and nothing said in a meeting can reach your tools. Each Claude Code ask now carries under 1,000 tokens of setup instead of several thousand.
- Fixes:
  - Stopping a session waits (up to 10 s) for its last words to be transcribed instead of dropping them.
  - English transcription no longer cuts long lines short or repeats phrases.
  - If transcription falls behind, Glint says so instead of quietly dropping speech.
  - The microphone reopens by itself if it disconnects mid-session (AirPods, a USB mic), and says so if it can't.
  - A Mac going to sleep pauses the session.
  - The move shortcuts only work while Glint is on screen, instead of taking ⌘ arrow keys from every app, and ⌘↩ works in Glance.
  - Recording a new shortcut no longer loops; switching between Claude Code and Codex clears a model name the other doesn't know.
  - A stopped reply says so, Retry asks the same thing again, and a screenshot that failed is shown on the ask (the AI is told too).
  - Session history shows speakers' names. Naming and merging work for speakers from before a resume.
  - Deleted sessions stay deleted, and "Resume last session" picks the right one.
  - Saved voices are never overwritten while they can't be read, and the voice model download can't hang forever.
  - Reset saves a live session first; a background update check can't hide an update that's installing; a failed installer always says so.
  - Temp files left by an ask cut off by a crash (which hold its screenshot) are removed at the next launch.
  - One bad value in the settings file resets only that setting, not all of them, and the file is kept as `state.json.bad`.
  - A crashed chat panel reloads by itself, with a warning if a session was running.
  - Chat after a session ends still saves to that session.
  - The CLIs are found from login shells such as fish, and with profile scripts that print a greeting.

## 0.8.0 (2026-09-25)

- **Automatic fallback AIs.** When the chosen AI fails before answering, Glint switches to the next one on its own, in the order ticked under Settings → AI → If it fails: Claude Code, Claude API, OpenAI API, Codex. API providers without a key are skipped. It never mixes two models into one answer, and a model that declines to answer isn't routed around. Asks, Glance, session notes and name guesses all use it.
- **Failures are loud.** Any AI failure turns Glint red: a red bar saying what failed (with AI settings and Dismiss), a red note on the reply naming each provider that failed and who answered instead, a red border on the panel and control bar, a red Glance strip that says what went wrong, and a red menu bar icon. Discreet mode never fades a failure. It stays red until the chosen AI answers again or you dismiss it. A reply nothing could answer says so in red instead of "Nothing to add".

## 0.7.1 (2026-09-25)

- **Recording your voice works properly.** Settings → Voice shows the passage first and waits for Start. While recording there's a timer, a level meter, Done (once there's enough speech) and Cancel. Cancel works at any point, including while the microphone is still opening, and always releases the mic.
- **See whether the `claude` or `codex` CLI is signed in** (Settings → AI). The CLI signs in separately from the Claude or ChatGPT app, so the app being signed in doesn't mean the CLI is. Glint now shows what the CLI itself reports, with a Check again button, and its sign-in errors say to run `claude auth login`.

## 0.7.0 (2026-09-25)

- **Guess a speaker's name.** The "New voice" bar and the speaker menu in the transcript have a Guess button. It asks your AI provider which name the conversation gives that person, from someone introducing themselves or being spoken to by name, and fills it in with the line it's based on. Nothing is saved until you press Save, and if nobody has said their name, it says so instead of making one up.

## 0.6.0 (2026-09-25)

- **Glance.** Settings → General → Layout, the menu bar menu, or ⌃⌘\ shrinks Glint to a dot in a corner of your screen. When someone else asks a question in a session, a one-line answer appears there on its own, without a screenshot and never copied. Point at it for the whole answer and the question; click it for the full panel. Nothing moves or pulses: an answer dims after 8 s and goes back to a dot after 60 s. ⌘↩ still asks, with a one-line answer.
- **One speaker per line.** When two people talk with no pause between them, the line is split where the speaker changes, so each line gets the right name. The model that finds the change (pyannote segmentation, 1.5 MB) ships with Glint.
- **Fix speaker labels from the transcript.** Click a speaker's name to play their voice, name or rename them, or mark them as the same person as another speaker. Merging two saved people keeps one and deletes the other, after asking.
- **Chats without a session are saved to History**, and can be picked up again with Continue chat. A session's detail view shows its chat too.
- **More mode templates:** behavioural, coding, system design and case interviews, a recruiter screen, interviewing a candidate, and team meetings.

## 0.5.0 (2026-09-25)

- **Faster transcription.** English now uses Moonshine instead of Whisper. On a base M1 a short line takes about 100 ms instead of 600 ms, with slightly fewer mistakes. Other languages still use Whisper.
- **Glint knows who's talking.** Unknown voices show as "Speaker 1", "Speaker 2" and so on. Once Glint has heard someone for a few lines, it asks who they are, with a clip you can play. People you name are saved, encrypted on this Mac, and recognised in later sessions. Settings → Voice lists them, with play, rename and delete.
- **Your voice, and room mode.** Record 20 s of your voice in Settings → Voice. Room mode, for meetings in person, then tells you apart from everyone else on one mic. Room mode and speaker labels can be switched from the chat panel's toolbar.
- **Talking over each other.** Your mic and the call now go through separate pipelines, and your mic is no longer muted while the call is talking. You can talk over someone and still be transcribed; the call echoing through your speakers is recognised by voice and dropped.
- **Copy replies automatically** (Settings → General): the whole reply, or just its first code block.
- **Discreet mode works reliably.** It fades until you point at it, even while you're in another app (it relied on hover events, which macOS doesn't send to a background app). ⌥⌘\ turns it on and off.
- Every slider has a reset button, and Opacity has "Restore opacity defaults".

## 0.4.1 (2026-09-25)

- **Updates from inside Glint.** Settings → General checks GitHub for a newer version (also every hour in the background) and has an "Update to …" button that downloads, builds and reinstalls Glint, then restarts it. The settings gear and the menu bar menu show when one is available. Needs the GitHub CLI, signed in, while the repo is private.
- **Menu bar only.** Glint no longer shows a Dock icon, invisible mode or not; the menu bar icon opens settings, history and quit.

## 0.4.0 (2026-09-25)

- **Note on screenshots** (Settings → General): text you write is drawn on a white band added above or below every screenshot sent to the AI, after it's taken, so it never shows on your screen. Each mode can add its own note under it (Settings → Modes). The chat's "Used screen" preview shows the screenshot as sent.

## 0.3.0 (2026-09-25)

- **Transcript and chat follow along.** They stay on the newest line while you're at the bottom. Scroll up to read and they hold still until you scroll back down. Opening either view, or asking, jumps to the newest line.
- **Opacity sliders** in Settings → General: the whole overlay, its background, and how far discreet mode fades it.
- **Unreadable saved data is reported instead of hidden.** If the keychain key protecting Glint's data is gone (keychain reset, access denied, or a move to another Mac), Settings → AI says the saved API key needs pasting again, asks say the same instead of "no API key", and History says how many sessions it can't open.
- Any keychain prompt for Glint's data now appears when Glint launches, not in the middle of a call.
- **Discreet overlay** (Settings → General, or the tray): the control bar and chat panel fade until you point at them, with no pulsing and no "hidden" note.
- **Microphone test** in Settings → General.
- **Restart Glint** in Settings → General and the tray. It saves your settings and any live session first.
- **About** lists your version and system (with a copy button for bug reports), the chat panel's keys, and these notes.
- Replies fade in as they stream.
- Editing a session summary shows a live preview of the formatted text.
- `install.sh` signs with a stable self-signed certificate, so Microphone and Screen Recording permissions survive rebuilds.
