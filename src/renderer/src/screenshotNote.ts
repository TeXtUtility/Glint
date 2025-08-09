import { wrapText } from '../../shared/prompt'

const FONT = '-apple-system, BlinkMacSystemFont, system-ui, sans-serif'

/**
 * The screenshot with `note` drawn on a light bar added above or below it, so no screen pixels are covered.
 * Nothing marks it as added: to the model it's more of the screen.
 * Text scales with the image width so it stays legible after main re-encodes the image as JPEG.
 */
export async function withNote(dataUrl: string, note: string, position: 'top' | 'bottom'): Promise<string> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const w = img.naturalWidth
  const h = img.naturalHeight
  const size = Math.max(16, Math.round(w / 64))
  const pad = Math.round(size * 0.75)
  const lineH = Math.round(size * 1.35)

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  ctx.font = `500 ${size}px ${FONT}`
  const lines = wrapText(note, w - 2 * pad, (s) => ctx.measureText(s).width)
  const band = 2 * pad + lines.length * lineH
  canvas.width = w
  canvas.height = h + band // resizing resets the context, so fonts are set again below

  const y0 = position === 'top' ? 0 : h
  ctx.drawImage(img, 0, position === 'top' ? band : 0)
  // A plain light bar with a hairline edge, like any toolbar or banner on screen.
  ctx.fillStyle = '#f2f2f2'
  ctx.fillRect(0, y0, w, band)
  ctx.fillStyle = '#d0d0d0'
  ctx.fillRect(0, position === 'top' ? band - 1 : h, w, 1)
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#000'
  ctx.font = `500 ${size}px ${FONT}`
  lines.forEach((line, i) => ctx.fillText(line, pad, y0 + pad + i * lineH))
  return canvas.toDataURL('image/png')
}
