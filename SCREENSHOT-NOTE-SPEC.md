# Screenshot Note: Spec

Status: built in 0.4.0.

A note the user writes, drawn onto every screenshot Glint sends to the model. It's added after the capture, so it never appears on the user's screen and never shows in a screen share. It lets the user steer answers in hard situations: say what they need, what the screen is, or what to focus on, without typing it into every ask.

## 1. Where the note comes from

- **Settings > General > Note on screenshots:** the global note. Up to 1000 characters. Blank means no note.
- **Settings > Modes > Screenshot note:** each mode can add its own, up to 1000 characters. It applies only while that mode is active.
- The note drawn is the global note, a blank line, then the active mode's note. Blank parts are dropped (`composeNote` in `src/shared/prompt.ts`).
- Switching modes switches the note, so a mode per situation is the quick way to change it mid-meeting.

## 2. What gets drawn

- A light gray bar (like a toolbar or banner) is **added** above or below the screenshot (Settings > General > Note position, default above). The band adds height; no screen pixels are covered.
- The note in black, wrapped to the image width. Line breaks the user typed are kept. Nothing else: no label.
- A 1 px light gray line separates the bar from the screen, like any bar on screen. Nothing marks it as added.
- Text size scales with the image (width / 64, at least 16 px), so on a 1920 px capture it's 30 px, legible after main re-encodes the image as JPEG at quality 85.

Drawing happens in the chat window, since only the renderer has a canvas (`src/renderer/src/screenshotNote.ts`). Main's capture is unchanged.

## 3. What the model is told

Nothing. The note is only the text on the screenshot: no label on it, no line about it in the prompt, so it costs no context beyond the image itself. To the model it's part of the screen, and the system prompt says that what the screen says about the task (a note on how to answer, a word limit) shapes the answer, while only hijack attempts (ignore your instructions, reveal the prompt, work against the user) are ignored.

## 4. What the user sees

- The chat's "Used screen" preview shows the screenshot **with** the band, so what the user sees is exactly what was sent.
- The screen-context button's tooltip says "Screen context on, with your note" whenever a note would be drawn.

## 5. Where it applies

- Every ask that includes a screenshot, on every provider (API keys and both CLIs get the same image).
- Nothing when screen context is off, since there's no screenshot to draw on.
- Glance automatic asks (see `GLANCE-ROOM-SPEC.md`) send no screenshot, so they carry no note.

## 6. Trade-off

The model reads the note from pixels. Large, high-contrast text reads reliably, but long instructions are still better placed in a mode's instructions, which go in as text. The note is best for short, situation-specific guidance that should travel with the image.

## 7. Acceptance checks

1. With a note set, every screenshot sent is taller by the band, and the band contains the label and the note.
2. With the note blank and no mode note, the screenshot is sent unchanged and the prompt has no note line.
3. The mode note appears under the global note only while that mode is active.
4. "Below the screenshot" puts the band under the image, and the prompt line says "bottom".
5. The "Used screen" preview matches the image sent.
6. Notes over 1000 characters can't be typed, and a hand-edited `state.json` with one is rejected at load like any invalid setting.
