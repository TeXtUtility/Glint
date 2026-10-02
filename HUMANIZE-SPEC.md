# Glint: Humanize Answers Spec

As of 29 September 2026 (version 0.14).

## Summary

An optional last step between the AI and the screen. When the user has connected a humanizer service and switched it on, Glint sends each finished answer to that service and shows the rewritten text instead of the model's own. The user brings their own account and key, as with the AI providers.

It is off by default. The switch only appears in **Settings → AI** once a service is connected and a test call has worked. **Ghost is the exception:** once a service is connected, asking about the screen in Ghost always humanizes, whatever the switch says, unless the user opts Ghost out. Everything else follows the switch.

It says what it's doing. Every humanized answer shows a person icon and "Humanizing…" while it waits, and says who rewrote it once it's done. A failure is loud, like a failing AI provider.

Only the answer's prose is sent. Code, commands, maths and links never leave Glint and come back untouched.

## Services

Four presets, from each service's current API documentation, plus a custom one for anything else.

| Service | Request | Auth header | Sends | Rewritten text in | Style | Limits |
| --- | --- | --- | --- | --- | --- | --- |
| [Emulate](https://www.tryemulate.ai/docs/api) | `POST https://www.tryemulate.ai/v1/humanize` | `Authorization: Bearer ak_live_…` | `text` | `text` (also `words.charged`, `elapsed`) | Answers at once; a long piece can take minutes | At least 40 words; per call 300 (Free) to 10,000 words (Enterprise), from `GET /v1/me` |
| [StealthGPT](https://docs.stealthgpt.ai/api-reference/endpoints/stealthify) | `POST https://www.stealthgpt.ai/api/stealthify` | `api-token` | `prompt` (the text), `rephrase: true`, `model`: `lite`, `standard` or `super`, `outputFormat: "markdown"` | `result` (also `wordsSpent`, `remainingCredits`) | Answers at once | Up to 3,000 words |
| [WriteHuman](https://writehuman.ai/api/docs) | `POST https://api.writehuman.ai/v1/humanize` | `Authorization: Bearer …` | `text`, optional `tone`: professional, academic, blog, casual, creative, scientific or technical | `results[0]` (also `input_words`, `words_remaining`) | Answers at once | 30 to 100,000 characters, 40 requests a minute |
| [Undetectable.ai](https://help.undetectable.ai/en/article/humanization-api-v2-p28b2n/) | `POST https://humanize.undetectable.ai/submit`, then `POST …/document` with the `id` | `apikey` | `content`, `readability`, `purpose`, optional `strength`, `model` | `output` of the document, once processed | Queued: poll every 5 s | At least 50 characters |
| Custom | A URL the user enters (POST, JSON) | A header name and key the user enters | A JSON body template with `{{text}}` where the text goes | A path into the JSON reply, like `results.0` or `data.text` | Must answer at once | Whatever the service sets |

- **Emulate** says a long piece can take minutes, so its timeout grows with the length (below).
- **Undetectable.ai queues work,** adding at least 5 to 10 seconds.
- **StealthGPT** asks for the text alone, with no "humanize this" instruction, so Glint sends only the text to every service.

**Long text.** An answer longer than the service's per-call limit is split at paragraph breaks into calls under it. For Emulate that's the plan's `max words per call` from `GET /v1/me`. The calls run one after another, in order, and the pieces are joined back.

## What gets rewritten

"Apply to" choices under the switch, each remembered:

| Output | Default | Why |
| --- | --- | --- |
| Chat answers | On | The main case. Copy and auto-copy use the rewritten text. |
| Ghost | Always, while connected | Follows neither the switch nor the other checkboxes: text typed into other apps is where a natural voice matters most. Its own checkbox, "Always humanize in Ghost", opts out. Ghost's answers are often long paragraphs for a form; those are split as above, never cut. |
| Follow-up emails | On | Sent to other people, in the user's voice. |
| Glance | Off | 12-word lines are under every service's minimum, and waiting for a rewrite defeats a one-line glance. |

Meeting notes are never rewritten: they're the user's own record, not something they send.

**Too short.** An answer (or a paragraph of one) under the service's minimum (40 words for Emulate) is shown as the model wrote it, and the reply head says so: "Too short to humanize (under 40 words)". It isn't a failure.

**Protected spans.** Before sending, Glint takes these out of the text and puts a marker in each place (`⟦1⟧`, `⟦2⟧`, …):

- fenced code blocks and inline code
- maths (`$…$` and `$$…$$`)
- link URLs (the link text is rewritten, the address isn't)
- Ghost's `⇥` field separators, so each form field stays its own answer

After the rewrite, each marker is swapped back for its span. If the service drops, duplicates or reorders a marker, Glint rewrites the answer again one paragraph at a time. If that also fails, it's a failure (below).

## The order of things

Every humanized answer goes through three steps, one after the other, and the reply head names each:

1. **Replying.** The model writes its whole answer. It isn't shown yet.
2. **Humanizing.** The finished answer (its prose, see Protected spans) goes to the service's API.
3. **Shown.** The service returns the rewritten text, and it appears, whole, in one frame. The model's version is never shown first and then swapped out.

## On screen

**The icon.** A person's head and shoulders, drawn like Glint's other icons: outline only, the same stroke, 14 px. It's the humanizer's mark everywhere: the reply head, Ghost's strip, the Settings section and the failure line.

**While it works, it says so.** While the model writes, the reply head reads as usual ("Sonnet 5 · answering") with the icon added, so it's clear a rewrite follows. Once the answer is finished and sent off, the head shows the icon in the accent colour and:

> 👤 Humanizing with Emulate… · Turn off the humanizer for faster answers

"Turn off the humanizer for faster answers" is a link that switches it off on the spot. The answer being rewritten still finishes, and the next ask comes straight from the model.

**Discreet mode** fades the returned text in the same way it fades new sentences.

**When it's done,** the head reads:

> 👤 Humanized by Emulate · 212 words · 6 s · Show original

**Show original** toggles between the two versions, since a rewrite can change a number or a fact.

**Ghost is just as verbose.** Its strip shows the icon and "Replying…", then "Humanizing with Emulate…", then the text to type once the rewrite returns. The strip's hover card has a "Stop humanizing in Ghost for faster answers" link, which clears Ghost's own checkbox; the switch for other views is left as it is.

**Stop** cancels the rewrite too. What the model wrote is shown as the original, marked "Humanizing stopped".

**Failures are loud, like a failing AI provider.** A timeout, bad key, no words left, plan limit, service outage or unreadable reply uses the same failure path as providers:

- The capsule turns red with the failure line and Dismiss: "Emulate failed: out of words (402)".
- The menu bar icon turns red.
- The reply shows the red failure note: "👤 Emulate failed: out of words. Showing the original."
- The model's original answer shows under the note, so the user still has an answer.

The red state stays until a rewrite succeeds or the user dismisses it, as with providers. Emulate's error codes map to plain reasons:

| Code | Shown as |
| --- | --- |
| `unauthorized` | bad API key |
| `plan_required` | the plan doesn't include this |
| `out_of_words` | out of words |
| `over_cap` | too long for the plan (split, and failed anyway) |
| `failed`, `billing_failed`, `unavailable` | Emulate is having problems |

The other services map their 401, 402, 422, 429 and 503 the same way.

Timeouts per call: 30 s plus 50 ms a word (up to 3 minutes) for services that answer at once, 90 s plus 100 ms a word (up to 5 minutes) for Undetectable.ai's queue, and for Emulate 60 s plus 1.5 s a word, up to 15 minutes.

**What the model remembers.** The chat history sent with the next ask keeps the model's original text, so a follow-up ("shorter", "in Spanish") works on what it wrote. The saved chat keeps both versions.

## Settings

A new section at the bottom of **Settings → AI**, "Humanize answers", with the icon.

**Not connected:** one row, "Rewrite answers with a humanizer service before showing them", and a **Connect a service** button. The form it opens in place has:

1. **Service:** Emulate, StealthGPT, WriteHuman, Undetectable.ai or Custom.
2. **API key**, saved like the AI keys: encrypted with the Mac keychain and never shown again.
3. **The service's options:** StealthGPT's model, WriteHuman's tone, Undetectable.ai's readability, purpose and strength. Custom gets URL, header name, body template and result path.
4. **Test connection.**
   - Emulate is checked with `GET /v1/me`, which costs nothing and shows the plan, words left and the per-call limit.
   - The others rewrite a 60-word sample, which costs about that many words (the button says so), and show the result.
5. **Save** is enabled only after a test passes. That's what "connected" means.

**Connected:**

- "Emulate · Pro · 41,200 words left · 3,000 per call", with **Change** and **Disconnect**.
- The switch: **Rewrite answers before showing them**, with the hint "Answers take longer: the model writes, then the service rewrites."
- The **Apply to** checkboxes for Chat answers, Follow-up emails and Glance, which follow the switch.
- **Always humanize in Ghost** (on), separate from the switch: "Asking about your screen in Ghost is always humanized while a service is connected."
- A note: "Rewritten answers are sent to Emulate and billed by it per word. Only the answer is sent: never the transcript, the screenshot or your question."

Disconnecting deletes the key and turns the switch off.

## Data and code

**Persisted** (`src/shared/state.ts`):

```ts
humanizer: {
  service: 'none' | 'emulate' | 'stealthgpt' | 'writehuman' | 'undetectable' | 'custom'
  on: boolean
  apply: { chat: boolean; email: boolean; glance: boolean } // with `on`
  ghost: boolean // Ghost humanizes whenever a service is connected and this is on, whatever `on` says
  options: Record<string, string> // the service's own fields, validated per service
  custom: { url: string; header: string; body: string; result: string } | null
}
```

`humanizer.on`, `apply` and `ghost` join `RENDERER_PATCHABLE`; `service`, `options` and `custom` change only through `humanizer:connect`, after a passing test. Runtime state gains `humanizerAccount` (plan, words left, per-call limit) from the last test or `/me` check.

**Key:** a `humanizer` entry in `keys.json` (safeStorage), main process only. Requests go from main, so the key never reaches a page.

**Files:**

- `src/shared/humanize.ts` (pure, tested under plain Node):
  - `protect(md) → { text, spans }` and `restore(text, spans) → string | null` (null when a marker went missing)
  - `split(text, maxWords)`, for services' per-call limits
- `src/main/humanize.ts`:
  - one adapter per service, `send(text, key, options, signal) → { text, words? }`
  - polling for queued services, timeouts, and the error mapping above
- `src/main/index.ts`:
  - In the `ai:ask` handler, after `askWithFallbacks` finishes, send `ai:humanizing` `{ id, service }` when a service is connected and either the ask is Ghost's (`typeable`) with `ghost` on, or the switch is on and the output type applies.
  - When the rewrite returns, the `ai:ask` result carries `humanized`: `{ text, words, ms }`, `{ short }`, `{ error }` or `{ stopped }`.
  - A failure sets `aiFailure` like a provider's; the next success clears it.
  - The same step runs after `sessions:follow-up` drafts an email.
- `src/renderer/src/ChatPanel.tsx`:
  - hide a humanized reply until its rewrite starts showing (Ghost's pill too)
  - save `original` beside `text`
  - the reply-head status, the "turn off" link and "Show original"
- `src/renderer/src/Ghost.tsx`: the strip's "Replying…" and "Humanizing…" states.
- `src/renderer/src/icons.tsx`: the existing `person` icon.
- `src/renderer/src/Settings.tsx`: the section and the connect sheet.

**Logs:** with developer tools on, each rewrite logs the service, word counts, pieces and time taken, never the text.

## Scope, open questions, acceptance

**Out of scope for this version**

- Custom services that queue. Presets cover the ones people use most.
- Showing the rewrite as it's written. Emulate can stream, but the answer appears only once the whole rewrite is back, so the order above stays the same for every service.
- A local, on-device rewrite with the user's own AI model instead of a service. Worth its own spec: it would be free and private.

**Open questions**

- [ ] Should Meeting options get a quick switch for this call, like Discreet?
- [ ] Show "words used this month" in Settings, or only words left?

**Acceptance criteria**

- [ ] With no service connected, nothing in Glint changes, and no request goes anywhere new.
- [ ] The switch appears only after a passing Test connection. Emulate's test spends no words. Disconnect removes the key.
- [ ] Every humanized answer shows the icon and "Humanizing with …" while it waits, and "Humanized by … · words · time" when done. "Turn off the humanizer for faster answers" switches it off.
- [ ] The order holds for every service: the model finishes, then the service rewrites, then the text appears once. The model's version never flashes first.
- [ ] With a service connected and the switch off, Ghost still humanizes, and Chat, Glance and emails don't. Clearing "Always humanize in Ghost" stops it for Ghost alone.
- [ ] Code blocks, inline code, maths, link URLs and `⇥` come back byte for byte identical, and Run still runs the original commands.
- [ ] Text over the plan's per-call limit is split at paragraphs and rejoined in order; nothing is cut.
- [ ] Answers under the minimum show as written, with "Too short to humanize", and no red state.
- [ ] A dropped marker falls back to paragraph by paragraph. After that, a failed rewrite turns the capsule and menu bar red and puts a red note on the reply, just like a provider failure, while still showing the original.
- [ ] Stop during a rewrite shows the original and bills nothing further.
- [ ] The next ask's history carries the model's original text; Copy and auto-copy carry what's shown.
- [ ] Only the answer text is sent: no transcript, screenshot, question or reference files.
- [ ] Tests cover:
  - protect/restore round trips and marker loss
  - splitting at paragraphs
  - each preset's response parsing from sample replies, including Emulate's error codes
  - the minimum-length skip

Glint's responsible-use note applies here too: rewriting an answer doesn't make AI help allowed where it isn't.
