# Glint: Functional Spec

A behavioral spec for Glint, a desktop AI overlay assistant for meetings. This file is the single source of truth for implementation.

## 0. Clean-room rules

- This document describes **observable behavior and public platform APIs only**. It contains no third-party source code, internal identifiers, UI copy, or branding.
- Implementers work from this document alone. Do not open any reference app bundle, its `app.asar`, its network traffic, or earlier analysis notes derived from them.
- Every name here (channels, fields, endpoints, scheme) is Glint's own. Rename freely.
- All server logic (LLM prompts, transcription, summaries) is designed from scratch.
- All user-facing text is written fresh. Where this spec needs a message, it describes its meaning, not its wording.

---

## 1. Product in one paragraph

A small, always-on-top, translucent control bar sits at the top of the screen, with a chat panel beneath it. During a **session**, Glint listens to the user's microphone and to the computer's audio output (the other participants) and keeps a live two-speaker transcript. When the user presses a hotkey, it takes a screenshot and sends it to an LLM together with the transcript since the last ask and any typed question. The answer streams into the chat panel. An optional **invisible mode** hides every Glint window from screen sharing and recording and removes the Dock icon. After a session ends, the server produces a title, summary, and tags, and the session appears in a history view.

---

## 2. Stack (recommended, not required)

| Concern | Choice |
|---|---|
| Shell | Electron (main + preload + renderer), TypeScript |
| UI | React, hash-based router. Bundle the renderer locally; never load it from a remote URL |
| Data fetching | Any query/cache library |
| Mic capture | `getUserMedia` in the renderer, **or** a native helper such as `sox` |
| System audio (macOS) | Core Audio process tap (macOS 14.2+) through a small helper binary. The MIT-licensed `audiotee` works |
| System audio (Windows) | `setDisplayMediaRequestHandler` with `audio: "loopback"` |
| VAD | Silero VAD via `@ricky0123/vad-web` (onnxruntime-web). Ship its model and WASM files locally |
| Chat transport | WebSocket (with resume) or SSE to Glint's backend |
| Markdown | Streaming-safe renderer with code highlighting, KaTeX math, and optionally Mermaid |
| Auth | Any provider that issues short-lived JWTs |
| Auto-update | `electron-updater` with Glint's own feed |

---

## 3. App phases

The app is in exactly one phase at a time. It is computed from state, never set directly.

| Phase | Condition |
|---|---|
| `splash` | Auth status is still loading |
| `onboarding` | Signed out, OR onboarding not finished, OR (macOS only) any required permission is not granted |
| `app` | Otherwise |

On non-macOS platforms, permissions count as granted.

Leaving the `app` phase resets every window, chat, and session field in state.

---

## 4. Shared state

The main process owns one state object. It is the single source of truth.

- Windows read it with `invoke("state:get")`, subscribe to `state:changed`, and request changes with `invoke("state:patch", partial)`.
- On every patch, main normalizes the result (rules below), compares it with the previous value by deep equality, and only on a real change notifies its own subsystems and broadcasts to every window.
- A persisted subset is written to `userData/state.json`:
  - validated against a schema on load; on parse or validation failure, reset to defaults and log it
  - written atomically (temp file, then rename)
  - writes coalesced so bursts of patches cause one write

**Persisted (user preferences):**

| Field | Type / default |
|---|---|
| `onboardingDone` | bool, `false` |
| `permissions` | `{mic, screen, accessibility}`, each `unknown \| granted \| denied` |
| `isInvisible` | bool, `true` |
| `lockFocusWhenInvisible` | bool, `false`: when on, the overlay windows never become focusable while invisible |
| `screenContext` | `off \| on`, default `on`: whether Ask includes a screenshot |
| `notifications` | `{upcomingMeetings: bool}` |
| `shortcuts` | map of action → accelerator (see §8) |
| `theme` | `system \| light \| dark` |
| `openAtLoginInitialized` | bool, used to turn on open-at-login once |

**Runtime only:**

| Field | Notes |
|---|---|
| `appVersion`, `systemInfo` | read at startup |
| `update` | `{status: idle \| available \| downloaded, version?}` |
| `openAtLogin` | mirrors the OS login-item setting |
| `authStatus` | `loading \| signed-in \| signed-out` |
| `entitlements` | list of plan features, resolved after sign-in |
| `windowsLoaded` | per-window "renderer ready" flags |
| `isRecordingShortcut` | true while the rebinding UI is capturing keys |
| `chat` | `{visible, expanded, view: chat \| dashboard, isStreaming, menuOpen}` |
| `session` | `Session \| null` (see §9) |
| `voiceActivity` | `{me: bool, them: bool}` |
| `pause` | `{paused, pausedAt?, pausedTotalMs}` |
| `lastSessionId` | for "resume last session" |
| `inactivityPrompt` | bool |
| `meetingNotice` | `{meeting, shownAt} \| null` |
| `dismissedMeetingIds` | set |
| `isCapturingScreenshot` | bool |
| `authRefreshCounter` | incremented to make every window reload the user profile |

**Normalization rules** (applied on every patch):
- Phase is not `app` → clear chat, session, and window fields.
- `session` is set → clear `meetingNotice`.
- `session` is null → clear `pause`, `voiceActivity`, and `inactivityPrompt`.
- Not paused → clear `pausedAt`.
- Chat not visible → close any open menu.
- Chat not expanded → view is `chat`.

---

## 5. Windows

Windows are created, updated, and destroyed declaratively: each window module exposes `update(state)` and reconciles itself.

Every **overlay** window is frameless, transparent, shadowless, not resizable by the OS, not minimizable, not fullscreenable, `skipTaskbar`, `hiddenInMissionControl`, `type: "panel"` on macOS, and always on top at level `"modal-panel"`.

| Window | Size | Exists when | Notes |
|---|---|---|---|
| **Auth** | hidden | always | Hosts the auth SDK. Main asks it for fresh tokens |
| **Splash** | 320 × 400, frameless, on top | `splash` phase, or `app` phase until control bar and chat panel have loaded | Closing it quits |
| **Onboarding** | ~1100 × 720, normal window | `onboarding` phase | Closing it quits |
| **Control bar** | 163 × 50, overlay | `app` phase | See §12 |
| **Chat panel** | 690 wide, overlay | `app` phase, chat visible, and both overlay windows loaded | See §11 |
| **Settings** | ~920 × 670, min width 760, normal window | on demand | Cmd/Ctrl+W closes it |
| **Meeting notice** | 360 × ~300, overlay | `app` phase and `meetingNotice` set | Top-right of primary work area, 15 px inset |

**Chat panel height:**
- Collapsed: 104 px (120 px in invisible mode, to fit an extra indicator). 500 px while a menu is open.
- Expanded, chat view: user-resizable, minimum 350, default 500.
- Expanded, dashboard view: default 760, clamped between collapsed height and 760.

**Positioning:**
- The control bar starts horizontally centered on the primary display, 25 px below the top of the work area.
- The chat panel is centered under the control bar with a 6 px gap and moves with it.
- Dragging either window moves both. After a drag, clamp the pair inside the current display's work area. If the chat panel's bottom comes within 150 px of the work area's bottom, move the pair up.
- Re-normalize positions when displays are added, removed, or changed, debounced about 50 ms.
- On Windows, show new windows at opacity 0 and set opacity 1 about 30 ms later to avoid a white flash.

**Other rules:**
- If the chat panel is hidden and no other Glint window is visible, call `app.hide()` on macOS so focus returns to the previous app.

---

## 6. Invisible mode

While `isInvisible` is on:
1. Call `setContentProtection(true)` on **every** Glint window. On macOS this sets `NSWindowSharingNone`; on Windows it sets `WDA_EXCLUDEFROMCAPTURE`. Screen capture, recording, and sharing show what is behind the window.
2. Hide the Dock icon (`app.dock.hide()`). Debounce Dock show/hide by about 1 s so it doesn't flicker.
3. **Keep the tray icon.** It is the guaranteed way back into the app.

During **every screenshot Glint takes of its own**, protection is also on, even when invisible mode is off, so the overlay never appears in the image. In short: protection = `isInvisible || isCapturingScreenshot`.

### 6a. Focus behavior

Overlay windows are created **non-focusable** and only become focusable while the user is typing into the chat panel. When shown, the panel is raised (`moveTop()`) but not given key focus. With `type: "panel"` and `skipTaskbar`, the app the user was in keeps key focus.

This is an ergonomics choice: keystrokes keep going to the underlying app and the overlay is never the frontmost application.

### 6b. What invisible mode does NOT do

Tell users plainly. Content protection only removes windows from OS **capture** APIs. It does nothing about:

- **Processes:** the app and its helper binaries are visible in the process list.
- **Permissions:** screen-recording, microphone, and accessibility grants can be enumerated by other software.
- **Audio tap:** system-audio capture requires a visible permission and an observable tap.
- **Focus events:** tools watching OS app-activation notifications still see real focus changes.
- **The physical screen:** anyone or any camera looking at the display sees the overlay.

It makes the overlay unobtrusive in a shared video call. It is not a defense against integrity or monitoring software.

---

## 7. IPC and security

**Preload** exposes only:
- `ipc.on(channel, cb)` → unsubscribe function
- `ipc.send(channel, payload)`
- `ipc.invoke(channel, ...args)`
- `platform`

`contextIsolation` on, `nodeIntegration` off, `sandbox` on.

**Origin checks:**
- Serve the renderer from a custom privileged scheme (for example `app://glint`) backed by the local build folder.
- Main rejects any IPC whose sender frame is not that origin.
- Block every in-window navigation or redirect to another origin.
- `window.open` for `https:` and `mailto:` URLs goes to `shell.openExternal`; everything else is denied.

**Channels** are Glint's own, namespaced by area (`state:*`, `app:*`, `window:*`, `chat:*`, `session:*`, `permissions:*`, `screenshot:*`, `update:*`). Main → renderer events cover: state changes, chat commands from hotkeys (focus, blur, submit, scroll, new chat), session start/stop from tray or hotkey, audio chunks, display changes, and forwarded main-process error logs.

---

## 8. Global hotkeys

Registered with `globalShortcut`. Every one can be rebound in Settings; changes apply immediately and persist.

| Action | Default | Registered when |
|---|---|---|
| Toggle overlay visibility | Cmd/Ctrl + `\` | `app` phase |
| Start/stop session | Cmd/Ctrl + Shift + `\` | `app` phase |
| Move overlay | Cmd/Ctrl + arrows (80 px step, clamped) | `app` phase |
| Ask | Cmd/Ctrl + Enter | chat visible |
| New chat | Cmd/Ctrl + R | chat visible, no session |
| Open settings | Cmd/Ctrl + , | chat visible |
| Scroll chat | Cmd/Ctrl + Shift + Up/Down (240 px) | chat visible |

Rules:
- Unregister everything while `isRecordingShortcut` is true, so the recorder can capture any combination.
- A binding must include a modifier. Warn when it clashes with common editing shortcuts.
- Never register a bare key (such as Tab) globally; it would steal that key from every app. In-panel keys are handled by the renderer only.
- Recorder UI: click to record, double-click to restore the default.

---

## 9. Sessions and audio

### 9a. Session object

Local: `{id, chatId, language, transcript[], startedAt, isResumed, priorElapsedMs}`

Transcript item: `{role: "me" | "them", at: ISO time, offsetMs, status: "pending" | "ready", text?}`

Server record: `{id, title, state: live | processing | done, createdAt, endedAt, lastHeartbeatAt, tags[], summary (markdown), transcript, attendees[]}`

### 9b. Lifecycle

- **Start:** ask the server to create a session (optionally linked to a calendar meeting). It returns `{id, chatId, language}`. If the user is out of free sessions, show the upgrade prompt instead. On success: new chat, show the panel collapsed in chat view, clear pause, record `lastSessionId`.
- **Resume:** fetch the session and its transcript. Mark all items ready. `priorElapsedMs` = the largest `offsetMs`. Load the chat history.
- **While live:**
  - every 10 s, sync the ready transcript to the server, skipped when unchanged or while a sync is in flight
  - every 60 s, send a heartbeat
- **End:** send the final ready transcript, set `session = null`, expand the panel to the dashboard view.
- **Server side:** a `live` session with no heartbeat for over 180 s is treated as ended. After a session ends, a background job sets it to `processing`, generates title, summary, tags, and attendees, then sets it to `done`. Clients waiting on a `processing` session poll or long-poll, then refresh.
- **Pause:** stops capture and transcription (helpers stopped, VAD reset) and freezes the timer. Resuming restarts capture and adds the paused span to `pausedTotalMs`.
- **Timer:** `now − startedAt − pausedTotalMs + priorElapsedMs`, shown as `m:ss` or `h:mm:ss`.
- **Inactivity:** a timer resets whenever the session id, transcript length, or chat message count changes. After **10 minutes** of no change, show the panel with an inactivity prompt that states the same 10 minutes and counts down 40 s before ending the session. Any interaction cancels it.

### 9c. Capture

Audio is captured **only** while a session is live and not paused. No helper process runs otherwise. The tray icon shows its active variant during a session.

- **Mic (`me`):** 48 kHz mono. If using a native recorder that emits WAV, **strip the header** before treating bytes as samples.
- **System audio (`them`):**
  - macOS: the tap helper at 48 kHz, 50 ms chunks, raw s16le PCM on stdout, logs on stderr.
  - Windows: `getDisplayMedia` with loopback audio (main auto-selects the first screen) → AudioContext at 48 kHz → AudioWorklet posting Float32 frames. Restart the capture (debounced about 500 ms) when displays change.
- If a helper crashes: log it, stop the session, and show a "restart required" state. Don't retry in a loop.

### 9d. Pipeline (renderer, per role)

```
chunk ─► s16→f32 ─► echo guard ─► bounded queue ─► resample 48k→16k ─► VAD ─► segment ─► STT ─► transcript
```

1. Convert int16 to float32.
2. **Echo guard:** while `them` has voice activity, replace `me` frames with silence so speaker bleed isn't logged as the user.
3. Bounded queue of 16 chunks per role. On overflow, drop the oldest and count/log the drops.
4. Resample 48 kHz → 16 kHz **with a low-pass filter** (a proper polyphase or windowed-sinc resampler, not a plain average), producing 1536-sample (96 ms) frames.
5. Silero VAD in segment mode. Both roles share one serial processing chain.

| VAD setting | Starting value | Notes |
|---|---|---|
| positive threshold | 0.3 | |
| negative threshold | 0.25 | |
| pre-speech pad | 500 ms | tune 300–800 |
| redemption | 800 ms | tune 300–1400: lower splits more, higher merges pauses |
| min speech | 400 ms | |
| max segment | 20 s | force-end longer segments |

Expose these as dev settings; they need tuning on real meetings.

**VAD events:**
- Speech start → `voiceActivity[role] = true`.
- Speech end or misfire → `voiceActivity[role] = false`.
- Segment ready:
  1. Insert a `pending` item with `at` = speech start and `offsetMs` = speech start − `startedAt`. Keep the list sorted by `at`.
  2. Encode the segment as 16 kHz mono PCM16 WAV.
  3. Send to STT with the session language. Allow at most 4 requests in flight; **queue** the rest (bounded, log if the queue overflows).
  4. On text: set the item `ready`. On empty text or error: remove it.
  5. Discard the result if the session id changed meanwhile.
- **Flush(role):** force-end the open segment and return its audio. Used by Ask (§10) so speech up to the moment of asking is included.

---

## 10. Screenshot

1. Pick the display containing the chat panel (fall back to primary).
2. Set `isCapturingScreenshot = true` so protection engages (§6).
3. `desktopCapturer.getSources({types: ["screen"], thumbnailSize})`, scaled so the longest side is at most 1920 px. Use the source whose `display_id` matches.
4. Encode as PNG. If the thumbnail is empty, retry up to 3 times, 500 ms apart.
5. Reset `isCapturingScreenshot` in a `finally`.
6. One capture at a time: concurrent callers share the in-flight result.

The screenshot is shown as a thumbnail on the message it belongs to.

---

## 11. Ask flow and chat

### 11a. Connection

- **With a session:** the chat is tied to the session's `chatId`.
- **Without one:** a standalone chat. "New chat" starts a fresh one.
- Transport reconnects forever with exponential backoff: initial 1–5 s (jittered), ×1.3, capped at 10 s. After 10 s disconnected, show a "can't connect" banner with Retry.
- Resuming a session loads its chat history.
- The server pushes chat state to the client, including whether the free message limit is reached.

### 11b. Sending

The outgoing message has a context block followed by the user's text:
- the screen-context preference
- transcript lines (`Me:` / `Them:`) for ready items newer than the transcript cutoff of the previous user message; omitted if none
- the user's typed text

Message metadata: `{displayText, screenContext, hasAudio, transcriptCutoff}`. `displayText` is what the bubble shows; the context block is never shown.

**Order of operations on Ask:**
1. Create a message ID.
2. Expand the chat panel.
3. Check the paywall (§11d). Stop if blocked.
4. If `screenContext = on`: capture (§10) and upload `{messageId, pngBase64}` without blocking the send.
5. If a session is live: flush the VAD for both roles and upload the unfinished audio `{messageId, language, entries: [{role, wavBase64}]}`; the server transcribes it and attaches it to the message.
6. Send. If a reply is still streaming, stop it and send the new message after it.

**Empty Ask:** the bubble shows a short label (for example "Assist"). The hidden prompt asks for help based on the screen (no session) or on the live conversation (session). Write Glint's own wording.

### 11c. Rendering

- Markdown streamed with an appearance animation, code highlighting, and KaTeX math.
- A "used screen" indicator with the screenshot as a hover preview.
- A "used files" indicator when the reply searched mode files.
- Copy button.
- When the reply is empty, show a short "nothing to add" placeholder.

### 11d. Paywall

Blocked when the free message limit is reached and the user has no paid plan. Show an upgrade card whose button opens Settings → Billing and hides the chat panel. Which features are paid is a business decision; keep the check in one function.

### 11e. Chat panel UI

- **Top:** single-line input that grows up to 56 px, with a context-dependent placeholder. Shows Stop while streaming.
- **Body:** chat thread, live transcript, or dashboard (§13).
- **Toolbar:** Settings (with an update badge), screen-context toggle, invisible-mode toggle, modes menu (General + active user modes, "Manage" link), session Start/Pause/Stop with timer, and view switcher (Transcript / Chat / New chat / History).
- **Local keys** (renderer only, never global):

| Key | Action |
|---|---|
| Tab | expand and focus input |
| ↓ (in input) | open dashboard |
| Esc | back, then blur, then hide |
| Backspace (empty input) | back |
| Cmd/Ctrl + T | transcript view |
| Cmd/Ctrl + R | new chat (no session) |

- **Banners:** stream error (Retry / Dismiss), disconnected, out of free sessions (Upgrade).

---

## 12. Control bar

- Logo area is the drag handle. A click without movement toggles the chat panel. Double-click resets the position.
- Ask / Hide button, with a subtle animation while a reply is streaming.
- Mic button starts a session; while live it becomes a stop button.

---

## 13. Dashboard (later)

Shown in the expanded chat panel at 760 px.

- **Search:** filters locally and, debounced 300 ms, searches people on the server. Without a query, show recent people. An "Ask about …" row opens the global chat. Selecting a person filters sessions and meetings.
- **Upcoming meetings:** from the connected calendar, next 30 days, refreshed every 2 minutes, first 3 shown with "Show more". Relative times; "Live" when the current session belongs to it; "Join" within 10 minutes of start. If no calendar is connected, offer to connect Google (OAuth in the browser, back through a deep link).
- **Sessions:** paginated (12 per page, infinite scroll), grouped by day, optionally filtered by attendee, refreshed every 30 s. Context menu: copy share link, move to trash.
- **Global chat:** a streaming chat across all past sessions, not persisted. The server may embed session references in its answer using Glint's own token format; render them as session cards.
- **Meeting detail:** server-generated overview and attendee briefs. "Join with Glint" starts a session linked to the meeting, then opens the meeting link.
- **Session detail:** editable title and summary (rich markdown editor, saved on blur), action items (tick, date, owner pill to reassign or rename; Add to calendar writes an .ics of the dated open ones; Draft follow-up email), transcript as `[m:ss] Name: text` with Copy, and "Resume session". Notes record the label each person had when written (`notesLabels`), so names given later show everywhere without rewriting.

---

## 14. Modes

A mode is a saved preset: `{id, name, prompt, templateId?, isActive}`. At most one is active; "General" means none.

- The Settings → Modes page lists the built-in General entry, the user's modes, and a set of starter templates (for example interviews, sales calls, lectures, coding help). Write Glint's own templates.
- Edits autosave with a ~600 ms debounce.
- **Files** attached to a mode are sent in full, not searched: nothing is left out of what the model sees.
  1. Text is taken out once when a file is added: PDF with PDFKit (pages marked with their printed labels; pages with little or no text layer read with Vision text recognition), EPUB chapters in spine order and Word/RTF/HTML with textutil, images with Vision, anything else as UTF-8 (or Latin-1) text. Binary files are refused with a reason.
  2. The text is stored encrypted (safeStorage) under userData/mode-files; settings hold only `{id, name, chars}`. Files no mode uses are deleted at launch and when a mode or file is removed.
  3. Every ask sends the files as a first system block (`<reference_files>`), ahead of the instructions, each cached for an hour, so editing the instructions keeps the files cached. The CLIs get the same text.
  4. A mode holds up to 1,500,000 characters of files (about 375k tokens, leaving room in a 1M-token context). A provider that can't fit them fails with a message saying so, and the fallbacks take over.
  5. While Glint is in use, the files are written into the Claude API's cache ahead of the first ask (`max_tokens: 0`, same model, effort and thinking as the next ask).

---

## 15. Onboarding

Steps, in order:
1. Sign in.
2. Permissions (macOS): Accessibility, then Microphone, then Screen Recording, one at a time. If screen access still reads as denied after granting (macOS requires a relaunch), offer "Quit and reopen".
3. Short interactive demos of the core gestures: ask, hide/show, move, start a session, invisible mode. These are local mocks; they call no backend.
4. Optional plan selection, skippable.

Finishing sets `onboardingDone = true`.

---

## 16. Settings

| Page | Contents |
|---|---|
| General | Update status and "restart to update", invisible mode, lock focus when invisible, open at login, free-session meter, audio language and display language, mic level test, reset onboarding, sign out, quit |
| Shortcuts | §8 |
| Modes | §14 |
| Calendar | Connect or disconnect Google Calendar |
| Notifications | Upcoming-meeting notice on/off |
| Account | Profile and security from the auth provider |
| Billing | Current plan and manage-subscription link, or a plan picker |
| About | Version, release notes, help and support links |

- Focusing the Settings window after a web checkout increments `authRefreshCounter` so entitlements refresh.
- Sidebar order and the last open page may be kept in `localStorage`.

---

## 17. App plumbing

- **Single instance.** A second launch focuses the running one and forwards any deep link.
- **macOS:** offer to move the app to /Applications on first launch.
- **Tray:** template icons (idle, active). Menu: Start/Stop session, Show/Hide, Enable/Disable invisible mode, Session history (opens the dashboard), Settings, Quit.
- **App menu:** Cmd+H and Cmd+Q hide the overlay instead of quitting while the overlay is loaded; Quit is in the tray. Dev builds add a DevTools menu.
- **Login item:** turned on the first time the app runs, then kept in sync with the setting.
- **Permissions:** check at launch and whenever an app window gains focus.
  - Mic: `systemPreferences.askForMediaAccess("microphone")`.
  - Screen: probe with a throwaway `desktopCapturer.getSources`.
  - Accessibility: `systemPreferences.isTrustedAccessibilityClient(prompt)`.
  - Deep-link to the relevant System Settings privacy pane when denied.
- **Deep links** (`glint://`):
  - `glint://auth/callback?token=…`: hand the one-time token to the Auth window to finish sign-in. Main returns the token once, then clears it.
  - `glint://auth/refresh`: increment `authRefreshCounter`; every window reloads the user.
  - `glint://settings/<page>`: open that Settings page (for example after the calendar is connected).
  - Every deep link shows the chat panel.
- **Auto-update:** check at launch and hourly; show "restart to update" when downloaded.
- **Errors:** a startup failure shows a Quit / Restart dialog. Main-process errors are forwarded to renderers for logging.
- **Menu actions:** quit, relaunch, reset all state (clears persisted state and renderer storage, then relaunches).
- **Meeting notice:** main polls upcoming meetings (about every minute) and sets `meetingNotice` about 1 minute before a meeting starts, unless it was dismissed, the setting is off, or a session is live. The notice shows the title, time until start, platform (derived from the meeting link: Meet, Zoom, Teams, …), and attendee briefs. "Take notes" starts a session linked to the meeting and opens the link. Close sets `meetingNotice = null` and records the id as dismissed.

---

## 18. Backend (design your own)

A typed RPC or REST API with bearer-token auth; on 401, refresh the token once and retry. Errors carry `{code, status, message, data}`.

Capabilities needed:

| Area | Needs |
|---|---|
| Transcription | Transcribe a WAV segment in a given language |
| Sessions | create, get, list (cursor, attendee filter), update (title, summary, transcript), end, delete, resume, wait for processing, heartbeat, remaining free sessions, create standalone chat |
| Chat | Streaming chat per chat id, attach screenshot and audio to a message by id, history, free-limit state, retrieval over mode files |
| Modes | CRUD, set active, clear active; files: upload URL, register, delete, indexing status |
| User config | audio language, display language |
| Calendar | list meetings and connections, meeting overview with attendee briefs, begin Google OAuth, disconnect |
| Dashboard | people search, recent people, streaming global chat |
| Billing | subscription status, prices, checkout, customer portal |
| Web | a sign-in page that finishes by redirecting to `glint://auth/callback?token=…` |

The LLM must be vision-capable. Pick a fast model for chat latency (for example `claude-sonnet-5`) and write Glint's own system prompts.

---

## 19. Analytics (optional)

If added: app launch, onboarding steps, session start/end (with duration), chat engagement (rate-limited), paywall shown, checkout started, conversion, calendar connect. Use Glint's own event names and your own feature-flag names.

---

## 20. MVP vs. later

**MVP:** control bar, chat panel, invisible mode, hotkeys, screenshot + ask, streaming answer, mic + system audio with VAD and STT, sessions with timer and pause, one mode, tray, onboarding permissions.

**Later:** dashboard and history, post-session summaries, meeting notice and calendar, multiple modes and files, billing, auto-update, Windows support, analytics.

---

## 21. Acceptance checks

1. With invisible mode on, a Zoom/Meet screen share and a QuickTime recording show the desktop behind the overlay, not the overlay.
2. With invisible mode off, the overlay does not appear in the screenshot sent to the LLM.
3. Pressing Ask while the cursor is in another app's text field leaves focus in that field.
4. Speech played through the speakers is logged as `them` only, never duplicated as `me`.
5. No audio is captured and no helper process runs when no session is live or while paused.
6. Dragging the overlay onto a second display keeps it and the chat panel together and inside that display's work area.
7. Rebinding a hotkey takes effect immediately and survives a restart.
8. Pressing Tab in another app while the chat panel is expanded still types a Tab in that app.
9. The first 50 ms of mic audio in a session is silence or speech, never a click from misread header bytes.
10. With the Dock icon hidden, the tray icon is always present.
11. A corrupted `state.json` resets to defaults on launch without crashing.
12. The inactivity prompt's stated duration matches the actual timer.
