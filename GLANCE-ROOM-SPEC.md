# Glance, Room Mode and Speakers: Spec

Status: sections 4 to 6 built in 0.5.0, Glance (section 3), line splitting and merging in 0.6.0, with the changes listed below. `GLINT-SPEC.md` stays the reference for everything not covered here.

**What 0.5.0 built, and how it differs from the plan below**

- **Models, measured on a base M1** (the slowest Apple Silicon Mac) with LibriSpeech test-clean: TitaNet-small via `sherpa-onnx-node` for voices (20 to 50 ms per line; 0% EER on full and 3 s clips, 1.7% on 1.5 s), picked over WeSpeaker ResNet34 (8 to 19% EER) and 3D-Speaker CAM++ (unusable under sherpa). Moonshine base replaced Whisper for English transcription (about 100 ms vs 600 ms for lines up to 5 s, 2.7% vs 2.9% WER).
- **Models, measured again on the base M1 (September 2026)**, with 400 LibriSpeech test-clean lines from 40 speakers, clean and through a 16 kbps Opus codec like call audio:
  - Transcription moved to NVIDIA Parakeet TDT 0.6B (sherpa-onnx, int8): v2 for English, v3 for 24 other European languages, Whisper for the rest. v2 made 2.2% word errors through the codec against Moonshine base's 3.4%, at about 180 ms per short line (2 threads); v3 made 2.6% on English. Live words (Nemotron Speech Streaming 0.6B, 560 ms chunks, in a worker thread) show English word by word at 2.7% word errors and about 14% of real time per side, then give way to Parakeet's text.
  - Voices stay on TitaNet-small: 1.7% EER at 1.5 s and 0.7% at 3 s through the codec, 20 to 46 ms per line. TitaNet-large was a little worse and 4x slower; WeSpeaker ResNet34 and CAM++ gave 12 to 34% EER under sherpa-onnx whether or not the samples were scaled, so the larger WeSpeaker models weren't pursued.
  - Naming: a line is matched on its own voice only with 1.5 s of speech; any line left unnamed goes to the closest voice heard on its side of the call, earlier lines are revisited as voices firm up, and when a session stops, duplicate voices fold together before the notes are written. On 48 simulated two- and three-person calls, lines left as "Them" fell from 20 to 25% to 0.1 to 0.3%, with 1.0 to 1.4% named wrong.
- **People are remembered across sessions** (a change to goal 4 and the non-goals, at the user's request): naming a voice saves its voiceprint and a 5 s sample, encrypted, so it's recognised in later sessions. The match threshold for people was raised to 0.5: at 0.45, 3% of strangers were taken for a saved person; at 0.5, none were, with the same 99% recognition (40 simulated two-meeting trials).
- **Calls get the voice check too.** The mic and system audio are separate pipelines (VAD, queue, transcription). The old echo guard muted the mic whenever the call had speech, which lost the user talking over someone. Now mic speech that overlaps call speech is kept if it sounds like the user and dropped if it doesn't; without a voiceprint, a session voice is learnt from clean mic lines, and unsure lines fall back to comparing words with the call.
- **Splitting (0.6.0):** pyannote segmentation-3.0, int8 (1.5 MB, MIT, shipped in `resources/`), through sherpa's diarization, on call lines and room-mode mic lines with at least 3 s of speech. On joined LibriSpeech clips: 16 of 17 two-speaker lines split where the second speaker starts, no single-speaker line split, about 32 ms per 9 s on a base M1. Turns under 0.5 s stay part of the turn around them.
- **Merging (0.6.0)** is in the transcript's speaker menu, alongside play and name or rename. A saved person always survives a merge; merging two saved people asks first, then deletes one. Merging works on the live session (and just after it ends); saved sessions in History aren't editable yet.
- **Glance (0.6.0)** follows section 3 with these differences: hover comes from main polling the cursor, since macOS sends no hover events to a background app; the dot stays visible next to an answer when something is wrong; the inactivity countdown shows in Glance, since the full panel is hidden; automatic asks don't flush audio (that would cut off whoever is talking). An answer's card renders markdown, the strip shows it as one plain line.
- **Not built yet:** the end-of-session recluster (6.3).

Three features that ship as one plan:

- **Glance**: a tiny strip in a screen corner that shows a one-line cue when someone asks a question. Built to be ignored until it's useful.
- **Room mode**: for meetings in person, where one mic hears everyone. A voiceprint of the user tells "Me" from "Them".
- **Speakers**: "Them" is split into Speaker 1, Speaker 2 and so on, on call audio and in the room. The user can name and merge them.

---

## 1. Goals and non-goals

**Goals**

1. Never answer the user's own question. A missed question is fine; a cue for something the user just said is the failure that matters.
2. Never pull attention. No motion, no pulsing, nothing that changes unless there's something to read.
3. Everything runs on the Mac with small models. No new server, no audio leaves the machine for speaker detection.
4. Other people's voiceprints are written to disk only when the user names them, and can be deleted from Settings > Voice.

**Non-goals (v1)**

- Naming people automatically from their voice or from the conversation.
- Pulling overlapping speech apart into two clean audio tracks (source separation). Overlap is detected and marked, not unmixed.
- Windows and Linux.
- Microphone arrays or beamforming.

---

## 2. Why this is feasible (evidence)

| Claim | Evidence |
|---|---|
| "Is this the enrolled user or someone else?" works on a tiny model | Google's Personal VAD does target speaker / other speaker / no speech per frame with 130K parameters, built for on-device use [1] |
| Speaker embeddings are accurate on full-length speech | ECAPA-TDNN: 0.80% EER on VoxCeleb1-test (cleaned) [2] |
| Short clips are the weak spot | WavLM + ECAPA-TDNN baseline on Vox1-O: 5.242% EER at 2 s, 18.437% at 1 s [3] |
| Telling several speakers apart in meetings is workable but imperfect | pyannote 3.1: 18.8% DER on AMI headset mix, 22.4% on AMI single distant mic [4] |
| Speaker changes and overlap can be found by a small model | pyannote segmentation-3.0: 10 s chunks, up to 3 speakers per chunk, 2 at once, 5.91 MB weights, MIT license [5] |
| Ready-made ONNX models and a Node binding exist | sherpa-onnx: speaker diarization with Node addon bindings [6]; `sherpa-onnx-node` 1.13.8, Apache-2.0. English VoxCeleb embedding models are 25 to 38 MB (e.g. `wespeaker_en_voxceleb_resnet34.onnx` 25 MB, `nemo_en_titanet_small.onnx` 38 MB); pyannote segmentation export 6.6 MB [7] |

EER is equal error rate: the point where false accepts equal false rejects. DER is diarization error rate: the share of time with the wrong speaker, missed speech or false speech.

What the numbers mean for design:

- Decisions on lines of 2 s or more are reliable. Lines under 1 s ("yeah", "right") are close to a coin flip. So short lines get **unsure** labels and never trigger anything.
- Model size isn't the limit. The amount of speech per decision is.
- Every threshold in this spec is a starting value. Final values come from the evaluation in section 10, not from guesses.

---

## 3. Glance

### 3.1 Look

- One window: the existing chat window, resized and moved. The control bar is hidden while Glance is on.
- **Collapsed:** a 28 × 28 pt circle holding a 10 pt status dot. This is the resting state.
- **With a cue:** a strip 28 pt tall, as wide as the text needs up to 360 pt. Same frosted glass, same opacity settings as the full overlay.
- **Position:** a corner of the work area of the display the overlay was last on, inset 12 pt. The work area already excludes the menu bar and Dock. Default corner: bottom right.
- **Text:** 13 px, one line, ellipsis if it overflows. No markdown rendering in the strip.

Status dot (color only, never animated):

| State | Dot |
|---|---|
| Session live, listening | muted gray |
| Working on a cue | accent |
| Cue showing | none (the text is the signal) |
| Session paused | hollow ring |
| No session | hollow ring, 50% opacity |
| Error | danger red; hover shows the message |

### 3.2 Motion rules

- A new cue appears with a 150 ms opacity fade. With reduced motion on, it appears instantly.
- No scrolling text, no marquee, no pulsing, no bouncing. Peripheral vision is most sensitive to movement, so the strip only changes when there's new text.
- After 8 s a cue dims to the **Discreet fade** opacity. After 60 s it collapses back to the dot. Pointing at it restores full opacity.

### 3.3 When it answers on its own

A **Them** line triggers a cue when all of these hold:

1. Glance is on, a session is live and not paused, and "Answer questions automatically" is on.
2. The line is transcribed, and it isn't marked unsure (section 5.4).
3. It reads as a question: it ends with `?`, or (for English) its first word is one of *what, why, how, when, where, who, which, can, could, would, will, should, do, does, did, is, are, was, were, have, has*.
4. At least 20 s have passed since the last cue or manual ask (cooldown, setting).
5. No ask is streaming.

Then Glint waits a 600 ms settle window. If the same speaker keeps talking, it waits for that line too, since the question may continue. Then it asks.

An automatic ask:

- Sends the unsent transcript lines, exactly like a manual ask (`unsentLines`), so the model has the context.
- Never includes a screenshot.
- Adds this to the system prompt: reply with one line of at most 12 words the user can glance at, the answer or what to say, no preamble; reply with nothing if there's nothing useful.
- Is saved in the chat thread like any other ask, marked `auto: true`, so the full panel and History show it.

An empty reply shows nothing and doesn't reset the cooldown.

### 3.4 Interaction

- **Hover:** the strip grows toward the screen's center to show the full reply (up to 5 lines) and, in small muted text above it, the line it answered.
- **Click:** switches to the full layout with the chat view open.
- **⌘↩ (Ask):** works as usual. In Glance, the reply uses the 12-word style and shows in the strip. Screenshots follow the existing "Include a screenshot" setting for manual asks.
- **New shortcut, "Glance on / off":** default `CommandOrControl+Alt+\`. Also a tray checkbox and a Settings > General option.
- **⌘\\** still hides and shows the overlay.
- Glance windows get the same content protection as the rest of the overlay, so invisible mode hides them from screen sharing.

### 3.5 Latency budget

Target: the cue is readable within 4 s of the question ending. Budget: 0.8 s VAD end-of-speech (`redemptionMs`), transcription of the line, then the first tokens of the reply. The first build measures each stage and logs it with the existing `[ask]` line. If the budget is missed, the first lever is a faster model for automatic asks (a setting), not a shorter VAD pause.

---

## 4. Voiceprint enrollment (the user)

### 4.1 Flow

A new Settings page, **Voice**, plus an optional last step in onboarding.

1. Consent text: what a voiceprint is, that it stays on this Mac encrypted, and that it can be deleted at any time.
2. The user reads a short passage aloud with the mic they'll use in meetings. Glint needs 30 s of speech after VAD; a meter shows progress.
3. Glint embeds the speech in 3 s chunks and averages them into one voiceprint.
4. **Quality check:** each chunk is compared with the average. If they don't agree well (a noisy room, two people talking), Glint asks to try again somewhere quieter. The spread of these self-scores is saved with the voiceprint and used to set this user's thresholds (section 5.4).
5. **Try it:** a live "Is this me?" meter. Speak and it should read Me; play a video with someone else talking and it should read Them.

### 4.2 Storage

- `userData/voiceprint.glint`: the averaged embedding, the self-score stats, the model id and the date. Encrypted with `safeStorage` like session files.
- Voiceprint status (`none`, `enrolled` or `unreadable`) is reported like API keys are in 0.3.0. If the keychain key is gone, Settings says the voiceprint needs recording again.
- A voiceprint made with a different embedding model is treated as `none`, and the user is asked to re-enroll.
- **Delete voiceprint** removes the file. Room mode turns off.

---

## 5. Room mode (Me vs Them on one mic)

### 5.1 Turning it on

- Toggle in Settings > Voice, in the tray, and a shortcut (unbound by default). It needs an enrolled voiceprint; without one, the toggle opens enrollment.
- It's a mode, not automatic, because in a call the mic is almost always the user. Room mode changes that assumption on purpose.
- Hybrid meetings work: system audio is still captured and is still Them.

### 5.2 Mic settings in room mode

- `autoGainControl: false`. Gain control flattens loudness, and loudness is a useful clue (the user is usually closest to the mic).
- `noiseSuppression` stays on.
- The first time room mode turns on, a note says that if macOS **Mic Mode** is set to Voice Isolation, other people will be filtered out, and it should be Standard.

### 5.3 Pipeline

Today every mic segment becomes a `me` line. In room mode, `addSegment` in `src/main/audio.ts` does this for mic segments instead:

1. **Split** the VAD segment at speaker changes with the segmentation model (10 s windows, 5 s hop, since segments can be up to `maxSegmentMs` = 20 s). Pieces under 0.5 s merge into a neighbor. Stretches where two people talk at once become their own piece, marked `overlap`.
2. **Embed** each piece.
3. **Decide** Me, Them or unsure for each piece (5.4).
4. **Cluster** Them pieces into speakers (section 6).
5. **Add** one transcript item per piece, with its role already set, then transcribe each piece as today.

The role is decided before the item is added, so `lineKey` (`role|at`) never changes after a line exists. The echo guard in `pump()` stays: while system audio has speech, mic samples are zeroed.

### 5.4 Decision rule

Inputs per piece: `score`, the cosine similarity to the voiceprint; `dur`, the speech duration; `level`, the pre-gain loudness relative to the session's running average for sure-Me pieces.

```
if overlap                         -> best guess, unsure
if dur < 1.0 s                     -> best guess, unsure
if score >= meThreshold            -> Me
if score <= themThreshold          -> Them
otherwise                          -> best guess using level as tie-breaker, unsure
```

- Thresholds start relative to the user's own self-score spread from enrollment and are tuned in section 10. They're also exposed in Settings > Developer, like the VAD settings.
- "Best guess" picks the closer side. An unsure line shows the guess with a "?" in the transcript, is sent to the model as `Unclear`, and never triggers a Glance cue.
- The costly error is a sure-Them label on the user's own speech, so `themThreshold` is set conservatively.

---

## 6. Speakers within Them

### 6.1 Where it applies

- System audio in any session: everyone on the call.
- Room mode: every Them piece from the mic.

Each source clusters separately. People on the call and people in the room are different people, and their audio sounds different (codec vs room), so mixing them would only add mistakes. Labels share one numbering so every speaker in a session has a unique name.

### 6.2 Live clustering

For each Them piece:

1. Compare its embedding with each speaker centroid from the same source.
2. If the best match is at or above `sameThreshold`, assign it and update that centroid (a running mean weighted by duration).
3. Otherwise, if the piece is at least 2 s long and the session has fewer than 8 speakers, start a new speaker.
4. Otherwise leave it unlabeled. It shows as plain "Them".

Pieces under 1 s are only assigned if the match clears `sameThreshold` by a margin; they never start a new speaker.

### 6.3 End-of-session pass

Live clustering makes early mistakes, since it has little speech to go on at the start. When a session ends, before notes are written:

1. Recluster all piece embeddings together (agglomerative, cosine, average linkage, stopping at the tuned threshold).
2. Map the new clusters to the live labels by the most shared speech time, so names the user gave carry over.
3. Relabel the saved transcript. Only `speaker` and `sure` change, never `role`.

Embeddings are then discarded. A resumed session starts new speaker numbers after the highest existing one and can't recognize earlier speakers by voice; the user can merge them.

### 6.4 Naming and merging

- Clicking a speaker label in the transcript renames that speaker for this session. Names show in the transcript, History and notes, and go to the model.
- **Merge** ("Speaker 3 is Speaker 1"): clustering often splits one person in two, so this is one menu action on the label. Merging combines centroids.
- Renaming and merging happen in the chat window and are sent to main, which owns the session.

### 6.5 What the model sees

Transcript lines change from `Me:` / `Them:` to:

```
Me: ...
Priya: ...        (a named speaker)
Speaker 2: ...    (an unnamed speaker)
Them: ...         (Them, no speaker assigned)
Unclear: ...      (room mode: couldn't tell if it was the user)
```

`SYSTEM_PROMPT` and `NOTES_SYSTEM_PROMPT` in `src/shared/prompt.ts` explain these labels. The notes prompt keeps its rule of not guessing names that weren't said. `transcriptText` in `src/shared/history.ts` uses the same labels.

---

## 7. Privacy and consent

- **The user's voiceprint** is collected only after the consent step, stored encrypted on this Mac, and deletable from Settings > Voice.
- **Other people's embeddings** exist only in memory during a session unless the user names that voice; then its voiceprint and a 5 s sample are saved, encrypted, and listed in Settings > Voice for deleting. Saved sessions keep speaker ids and names, never embeddings. Settings > Voice asks the user to save a voice only with that person's OK: Illinois' BIPA, for example, lists voiceprints as biometric identifiers and requires written consent before collecting one [8].
- Recording and transcription laws in some places require everyone's consent, in person as well as on calls. The first time room mode turns on, Glint shows a one-time note saying so.

---

## 8. State, storage and code changes

### 8.1 State (`src/shared/state.ts`)

Persisted, validated in `parsePersisted`:

```ts
layout: 'full' | 'glance'
glance: {
  corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  autoAnswer: boolean
  cooldownS: number            // range [10, 120], default 20
}
roomMode: boolean
speakerLabels: boolean         // split Them into speakers; default true once models are installed
voice: { meThreshold: number; themThreshold: number; sameThreshold: number } // Developer tuning, ranged like vad
shortcuts: { ...existing, toggleGlance: 'CommandOrControl+Alt+\\', toggleRoom: '' }
```

An empty shortcut means unbound; `parsePersisted` currently requires every shortcut to be non-empty, so that check changes for optional ones.

Runtime:

```ts
voiceprint: 'none' | 'enrolled' | 'unreadable'
voiceModels: { status: 'missing' | 'downloading' | 'ready' | 'failed'; progress?: number }
```

On `Session` and `TranscriptItem`:

```ts
Session.speakers: { id: string; source: 'mic' | 'system'; name?: string }[]
TranscriptItem.speaker?: string   // a Session.speakers id; absent = Me or unlabeled Them
TranscriptItem.sure?: false       // only present when unsure
TranscriptItem.overlap?: true
```

`RENDERER_PATCHABLE` in `src/main/index.ts` gains `layout`, `glance`, `roomMode`, `speakerLabels` and `voice`. Speaker renames and merges go through their own IPC handlers (`speakers:rename`, `speakers:merge`), like modes do, so two quick edits can't overwrite each other.

### 8.2 Saved sessions

`SavedSession` gains the optional `speakers` array; transcript items carry the new optional fields. Old files load unchanged, so `version` stays 1 and `parseRecord` accepts the new optional fields.

### 8.3 Models

- Downloaded on first use to `userData/models`, like the Whisper models: one English embedding model and the segmentation model. Each download is pinned by SHA-256.
- The voiceprint records which embedding model made it (section 4.2).

### 8.4 Code layout

| File | What |
|---|---|
| `src/shared/speakers.ts` | Pure logic, unit-tested: decision rule, live clustering, end-of-session reclustering and label mapping, question detection |
| `src/main/voice.ts` | Model download and loading, embedding, splitting, enrollment, voiceprint storage |
| `src/main/audio.ts` | Room mode path in `addSegment`; speaker assignment for system audio segments |
| `src/renderer/src/Glance.tsx` | The strip; the chat window renders it when `layout` is `glance` |
| `src/renderer/src/ChatPanel.tsx` | Automatic asks (the ask flow already lives here), transcript speaker labels with rename and merge |
| `src/main/windows.ts` | Glance placement and sizing; hide the control bar in Glance |
| `src/renderer/src/Settings.tsx` | Voice page; Glance options in General; thresholds in Developer |

### 8.5 Dependency decision

Embeddings need 80-dimension filterbank features computed from the audio. Two options:

- **A: `sherpa-onnx-node`** (Apache-2.0). It computes the features and runs the embedding and segmentation models itself. Adds a native addon.
- **B: our own code on `onnxruntime-node`**, which Glint already uses for Silero VAD. Means writing and testing a filterbank.

Recommendation: start with a one-day spike on A. Adopt it if it loads under Electron on arm64 and x64 and the packaged app size stays reasonable. Otherwise do B. The clustering and decision logic stay ours either way (`src/shared/speakers.ts`), because sherpa's diarization works on whole files, not live.

---

## 9. Rollout

Each phase ships on its own.

1. **Glance.** Works today with call audio, where Me and Them come from separate channels. No voice models needed.
2. **Voice models, enrollment and the evaluation harness.** Numbers before features.
3. **Speakers on call audio.** Lowest risk: it only splits Them and never touches Me.
4. **Room mode.** Turned on only once the section 10 targets are met.

---

## 10. Evaluation

A script, `scripts/eval-speakers.mjs`, runs the real pipeline (split, embed, decide, cluster) over recordings with known speakers and reports:

- **Own-speech false Them rate:** the share of the "me" speaker's speech labeled sure-Them. This is the error that makes Glance answer the user's own question.
- **Them coverage:** the share of other speakers' speech labeled sure-Them.
- **DER** for the speaker labels, before and after the end-of-session pass.
- Results split by piece length: under 1 s, 1 to 2 s, over 2 s.

Data:

- **AMI Meeting Corpus** (CC BY 4.0 [9]), single distant mic and headset mix. One participant plays "me", enrolled from their speech in a different meeting.
- Our own recordings of real rooms, with a laptop on the table, to match how Glint is used.

Proposed targets for turning room mode on (to be confirmed once the first numbers are in): own-speech false Them under 2%, Them coverage over 70% for lines of 2 s or more.

---

## 11. Acceptance checks

1. In Glance with no session, the only thing on screen is the 28 pt circle.
2. A question from the other side of a call shows a cue of at most 12 words within the latency budget, without a screenshot being taken.
3. The user asking a question never triggers a cue, in a call or in room mode.
4. A cue never moves once shown, dims after 8 s and collapses after 60 s.
5. With reduced motion on, nothing in Glance animates.
6. Two questions 5 s apart produce one cue (cooldown).
7. With invisible mode on, a screen share and a QuickTime recording don't show the Glance strip.
8. Enrollment rejects a recording with two people talking and accepts a clean one.
9. Deleting the voiceprint removes the file and turns room mode off.
10. With the keychain key gone, Settings > Voice says the voiceprint needs recording again.
11. In room mode, a line under 1 s is shown with "?" and never triggers a cue.
12. On a two-person call, the transcript shows two speakers, and renaming one updates every line, History and the notes.
13. Merging two speakers relabels every line of both.
14. After a session ends, no speaker embeddings for other people exist on disk.
15. Sessions saved by 0.3.0 still open, and resuming one keeps its lines' labels.

---

## 12. Open questions

1. **Model licenses.** Confirm the license of the chosen embedding weights allows shipping them in the app, in addition to the code licenses above.
2. **Who is being asked.** A question to someone else in the room still triggers a cue. Worth adding "only when my name is said" as an option later?
3. **Glance outside sessions.** Should Glance also give cues from the screen alone when no session is live, or stay a dot?

---

## Sources

1. Ding et al., "Personal VAD: Speaker-Conditioned Voice Activity Detection", Odyssey 2020. https://arxiv.org/abs/1908.04284
2. SpeechBrain ECAPA-TDNN model card. https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb
3. "Beyond Short Segments: Expanding Speaker Embeddings with Vector Archives", Table 1. https://arxiv.org/html/2609.25007
4. pyannote speaker-diarization-3.1 model card. https://huggingface.co/pyannote/speaker-diarization-3.1
5. pyannote segmentation-3.0 model card and files. https://huggingface.co/pyannote/segmentation-3.0
6. sherpa-onnx speaker diarization docs. https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html
7. sherpa-onnx model releases: `speaker-recongition-models` and `speaker-segmentation-models`. https://github.com/k2-fsa/sherpa-onnx/releases
8. Illinois Biometric Information Privacy Act, 740 ILCS 14/10 and 14/15. https://ilga.gov/documents/legislation/ilcs/documents/074000140k10.htm
9. AMI Meeting Corpus license. https://groups.inf.ed.ac.uk/ami/corpus/license.shtml
