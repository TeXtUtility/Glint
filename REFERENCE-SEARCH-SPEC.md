# Reference File Search: Spec

Status: built on `beta`.

A mode's reference files are sent whole with every ask today, up to 1.5M characters (`MODE_FILES_MAX_CHARS`, about 375k tokens). This spec keeps that for files that fit and adds search for files that don't: Glint finds the passages that best match each ask and sends only those. The limit on what a mode can hold goes away; what an ask can see becomes the best-matching ~30k tokens instead of everything.

## 1. When search is used

- **Whole files, as today,** while a mode's files total at most 1.5M characters. Whole files answered best in the benchmark (§ 9), especially questions about a document as a whole.
- **Search,** once they total more. It's per mode and automatic: adding the file that crosses the line switches that mode to search; removing enough to fit switches it back.
- Nothing else changes for modes under the line: same prompt, same caching, same warm-up.

## 2. Adding files

- A mode can hold up to **15M characters** (about 3.75M tokens, ten times today's cap). The cap is on memory: the text of every file in use is held decrypted in memory (`texts` in `src/main/files.ts`), plus its index.
- Each file keeps its current limits: 300 MB on disk (`FILE_MAX_BYTES`), the same formats, OCR for scans and images.
- The error for a file that doesn't fit changes from the 1.5M cap to the 15M one. Crossing 1.5M is not an error.

## 3. The index

- **Pieces:** each file's text is split at paragraph breaks into pieces of about 1,200 characters. A paragraph longer than that is split at sentence ends. Pieces never span two files.
- **Pages:** the `[page N]` markers the PDF reader writes stay with the piece they start, and each piece remembers the page it's on, so a passage sent alone still carries its page for quoting.
- **Terms:** lowercase words, apostrophes kept, English stopwords and words under three letters dropped, lightly stemmed: common endings (-s, -es, -ed, -ing, -ies, 's) and then a final -e come off words of four letters or more, so "picks up" finds "picked me up" and "price" finds "prices". That was the benchmark's one search miss; with stemming, all five fact questions find their passage.
- **Kept in memory only.** Built from the decrypted text the first time an ask in that mode needs it, reused after, and dropped when a file is added to or removed from the mode, or the mode is deleted. Nothing new is written to disk, so the encryption story is unchanged.
- **Cost:** building it for Moby-Dick (1.2M characters, 1,174 pieces) takes milliseconds; 15M characters should take well under a second. Warm-up (`warmForUse` in `src/main/index.ts`) builds it ahead of the first ask, as it warms the cache today.

Lives in a new `src/shared/search.ts` (no Electron imports, tested under plain Node like `speakers.ts`); `files.ts` owns the per-mode cache.

## 4. What is searched for

- **A typed question:** its text.
- **No question typed** (help with the conversation, or with the screen): the last six transcript lines, since that's what the answer is about. Outside a session, with nothing typed, nothing is searched and no passages are sent.
- **A retry** ("again", or the same ask repeated): the original question, so the retry sees the same material.
- Glance's automatic answers search with the question they're answering.

## 5. Ranking and picking

- **Score:** BM25 (k1 = 1.2, b = 0.75) over the pieces of all the mode's files together.
- **Pick:** best score first, each with the piece before and after it (the benchmark's one search miss sat a piece away from the best match), until the passages reach **120,000 characters** (about 30k tokens). A piece already picked isn't picked twice.
- **Order:** the picked pieces go back into reading order, grouped by file, with `[…]` between pieces that aren't next to each other.
- **Nothing matches** (no term of the query is in any piece): no passages, and the model is told the files had nothing on it.

## 6. What the model gets

- **Where:** the passages lead the new turn, in `<reference_passages>` with a `file` attribute per group, through a new `reference` field on the ask that `userPrompt` (`src/shared/prompt.ts`) places first. Not in the system prompt: they change every ask, and the system prompt stays small and cached.
- **Not cached:** no `cache_control` on them. Caching text that changes every ask only pays the cache-write premium (the benchmark's search cost $0.17 per ask through Claude Code, which caches everything, against about $0.09 without).
- **Not kept:** chat history keeps what the user typed, not the passages, so earlier asks' passages never pile up in later ones.
- **The instruction:** `REFERENCE_PROMPT` gets a search variant for these modes: the passages are the parts of the user's files that best match this ask, not the whole files; answer from them first, quote with pages where they're marked; if they don't cover it, say so in a few words, then answer from general knowledge where that's useful.

## 7. Providers

- **Claude API and OpenAI API:** as above. The system prompt is cached as today.
- **Claude Code:** its warm process remembers every turn it's sent, passages included, so a chat of ten asks would carry about 300k tokens of old passages. Each warm process counts the passage characters it has been sent; past 200,000, the next ask starts a fresh process, told the chat so far as text the way a new process already is (`cliPrompt`). Warm spares are unaffected.
- **Codex:** one process per ask already, so nothing to add.
- **Timeouts:** the first-text allowance (`firstTextMs` in `src/main/ai.ts`) counts the passages as it counts the system prompt, about 3 s more for 120k characters.

## 8. What the user sees

- **Settings > Modes,** on a mode past 1.5M characters: "Too big to send whole: Glint searches these files for each question." under the file list, with the total.
- **In the chat,** an ask that searched says so under the question, as "Used screen" does: "Searched your files: 14 passages, pages 212 to 240" (pages when the files have them), or "nothing matched". Clicking it shows the passages sent.
- **Nothing** changes for modes whose files fit.

## 9. Evidence

Ten questions on a copy of Moby-Dick with five names changed (so answers from memory show), through the Claude Code CLI on Sonnet 5, 2026-09-27. Scores out of 10 per group (2 per question).

| | Whole book | Search (this spec) | Folder for Claude Code to read |
|---|---|---|---|
| Single facts | 8 | 7 | 4 |
| Needs the whole book | 9 | 9 | 8 |
| Time to first word, median | 7.2 s | 2.2 s | ~6.4 s (often narration before any searching) |
| Time to full answer, median (slowest) | 12.9 s (21 s) | 7.1 s (13 s) | 12.2 s (33 s) |
| Cost per ask, API prices | $1.75 first, then ~$0.09 | $0.17 through the CLI, ~$0.09 without caching | ~$0.03 |

Search's one miss: a question worded differently from the text ("picks up Ishmael") missed the passage; it said so rather than guessing. The folder approach answered from memory twice without reading and searched for a remembered word the text didn't use. Small sample, one run each: good enough to choose the approach, not to tune it.

## 10. Not in this version

- **Search by meaning (embeddings).** Fixes wording mismatches, but needs a model download and an index on disk. Worth it only if keyword misses show up on real documents.
- **A smaller budget for Glance's one-line answers.** One budget until there's a reason for two.
- **Searching past sessions' transcripts.** People search (`design/people-search.md`) covers that.
- **Tools that let the model search for itself.** Slower and less accurate in the benchmark, and a tool the prompt's injected text could reach.

## 11. Acceptance checks

1. A mode whose files total 1.5M characters or less sends them whole, exactly as before, and its asks carry no `<reference_passages>`.
2. Adding a file that takes a mode past 1.5M succeeds (up to 15M), shows the Settings note, and the next ask sends passages instead of the files.
3. A fact planted once in a 5M-character file is found by a question naming it, and the passage sent contains it.
4. A passage from a PDF carries its page, and the reply can quote it with that page.
5. The passages sent never exceed 120,000 characters, are in reading order, and contain no piece twice.
6. An ask with nothing typed during a session searches with the last transcript lines; with nothing typed outside a session, it sends no passages.
7. Through the Claude API, the passages carry no `cache_control`, and the system prompt's cache is still read on the second ask.
8. A Claude Code chat of twenty asks restarts its process once the passages sent pass 200,000 characters, and the answer after the restart still knows the earlier conversation.
9. Removing files until a mode fits under 1.5M sends them whole again on the next ask.
10. Adding or removing a file drops that mode's index; the next ask builds it again from the new files.
