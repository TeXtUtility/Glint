// "Run" on a code block: the commands open in the user's terminal behind a y/N prompt, so nothing runs until they
// read it and press y. The commands then run in their own shell (aliases, PATH, working directory). Each platform's
// terminals are in platform/.
import type { TerminalApp } from '../shared/state'
import { platform } from './platform'

/** The terminals this computer has. */
export const installedTerminals = () => platform.terminals()

/**
 * A console block's "$ " and "% " prompts are the reader's, not part of the command. The lines without one are output,
 * except those continuing a command whose line ends in "\".
 */
export function commandsOf(code: string): string {
  const lines = code.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  const prompt = /^\s*(?:[$%]|PS(?: [^>\n]*)?>) /
  if (!lines.some((l) => prompt.test(l))) return lines.join('\n')
  const kept: string[] = []
  let more = false
  for (const l of lines) {
    if (more) kept.push(l)
    else if (prompt.test(l)) kept.push(l.replace(prompt, ''))
    else continue
    more = /(^|[^\\])(\\\\)*\\$/.test(l) // an odd number of backslashes: the last one escapes the newline
  }
  return kept.join('\n')
}

/**
 * Escape sequences and other control characters, and bidi overrides, which could redraw or reorder the review screen
 * so it shows something other than what runs. Tabs and newlines are fine.
 */
export const hasHiddenControls = (s: string) => /[\0-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(s)

/** Opens the terminal on the commands, behind the y/N prompt. Returns the terminal used. */
export async function runInTerminal(code: string, choice: TerminalApp, newWindow: boolean): Promise<string> {
  const commands = commandsOf(code)
  if (!commands.trim()) throw new Error('There are no commands in this block.')
  if (hasHiddenControls(commands)) throw new Error("This block has hidden control characters that could disguise what it runs, so Glint won't run it.")
  return platform.runInTerminal(commands, choice, newWindow)
}
