import { desktopCapturer, screen } from 'electron'
import { patchState } from './state'
import { getWin } from './windows'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let inflight: Promise<string | null> | null = null

/** PNG data URL of the display holding the chat panel. Overlays are content-protected while capturing. */
export function captureScreen(): Promise<string | null> {
  return (inflight ??= capture().finally(() => (inflight = null)))
}

async function capture(): Promise<string | null> {
  const chat = getWin('chat')
  const display = chat ? screen.getDisplayMatching(chat.getBounds()) : screen.getPrimaryDisplay()
  patchState({ isCapturingScreenshot: true })
  try {
    await sleep(50) // let the compositor apply content protection before grabbing the frame
    const px = { w: display.size.width * display.scaleFactor, h: display.size.height * display.scaleFactor }
    // 1568 px on the long side: about 2,100 image tokens a screenshot instead of 3,200 at 1920, with screen text still legible.
    const k = Math.min(1, 1568 / Math.max(px.w, px.h))
    const thumbnailSize = { width: Math.round(px.w * k), height: Math.round(px.h * k) }
    for (let attempt = 0; attempt < 4; attempt++) {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
      const src = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined)
      if (src && !src.thumbnail.isEmpty()) return src.thumbnail.toDataURL()
      if (attempt < 3) await sleep(500)
    }
    console.error('[screenshot] empty thumbnail after retries')
    return null
  } finally {
    patchState({ isCapturingScreenshot: false })
  }
}
