import type { KeyInput } from './keys'

/** Windows: a key from the hook as typing input. Ctrl, Alt or Win make a shortcut; AltGr (Ctrl+Right Alt) types. */
export function parseWinKey(vk: number, m: { ctrl: boolean; alt: boolean; win: boolean; altGr: boolean }, chars: string): KeyInput | null {
  if (m.win || ((m.ctrl || m.alt) && !m.altGr)) return null
  if (vk === 0x08 || vk === 0x2e) return { type: 'backspace' } // Backspace, Delete
  if (vk === 0x0d) return { type: 'text', text: '\n' }
  if (vk === 0x09) return { type: 'text', text: '\t' }
  const text = [...chars].filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f).join('')
  return text ? { type: 'text', text } : null
}
