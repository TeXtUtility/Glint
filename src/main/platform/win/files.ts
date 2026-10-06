// Mode files on Windows, with what it ships instead of macOS's: tar.exe opens .docx, .odt and .epub, PDF.js (unpdf)
// reads a PDF's text, and Windows' own text recognition (Windows.Media.Ocr, through PowerShell) reads scans and images.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { getDocumentProxy } from 'unpdf'
import { htmlText as fromHtml, isUtf8, officeXmlText, rtfText } from '../../../shared/doctext'
import { withTemp } from '../../temp'
import { IMAGES } from '../formats'
import { POWERSHELL, TAR } from '../system'
import type { FileProgress as Progress } from '../types'

const run = promisify(execFile)

export const unzip = (file: string, into: string) => run(TAR, ['-xf', file, '-C', into], { timeout: 120_000, windowsHide: true })

const decodeText = (buf: Buffer) => (isUtf8(buf) ? buf.toString('utf8') : buf.toString('latin1'))

export async function extract(file: string, ext: string, onProgress?: Progress): Promise<{ text: string; pages?: number }> {
  if (ext === 'pdf') return pdfText(file, onProgress)
  if (IMAGES.includes(ext)) {
    const [text] = Object.values(await recognize(file, 'image', [], onProgress))
    return { text: `[text recognized from the image]\n${text ?? ''}` }
  }
  if (ext === 'html' || ext === 'htm') return { text: fromHtml(decodeText(await fs.promises.readFile(file))) }
  if (ext === 'rtf') return { text: rtfText((await fs.promises.readFile(file)).toString('latin1')) }
  if (ext === 'docx' || ext === 'odt') {
    return withTemp(async (tmp) => {
      await unzip(file, tmp).catch(() => Promise.reject(new Error(`isn't a readable ${ext === 'docx' ? 'Word' : 'OpenDocument'} file`)))
      const xml = path.join(tmp, ext === 'docx' ? 'word/document.xml' : 'content.xml')
      if (!fs.existsSync(xml)) throw new Error(`isn't a readable ${ext === 'docx' ? 'Word' : 'OpenDocument'} file`)
      return { text: officeXmlText(await fs.promises.readFile(xml, 'utf8')) }
    })
  }
  throw new Error("can't be read on Windows: save it as .docx or PDF, or add it as plain text")
}

/** Each page's text layer; pages with almost none (scans, slides that are pictures) are recognized from their image too. */
async function pdfText(file: string, onProgress?: Progress): Promise<{ text: string; pages: number }> {
  let pdf
  try {
    pdf = await getDocumentProxy(new Uint8Array(await fs.promises.readFile(file)))
  } catch (err) {
    throw new Error((err as Error).name === 'PasswordException' ? 'is password-protected' : "isn't a readable PDF")
  }
  const labels = await pdf.getPageLabels().catch(() => null)
  const bodies: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent()
    bodies.push(content.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join(''))
  }
  const thin = bodies.flatMap((b, i) => (b.trim().length < 200 ? [i + 1] : []))
  let failed: Error | null = null
  const seen = thin.length ? await recognize(file, 'pdf', thin, onProgress).catch((err: Error) => ((failed = err), {} as Record<string, string>)) : {}
  const pages = bodies.flatMap((b, i) => {
    let body = b
    let seenOnly = false
    const s = seen[String(i + 1)] ?? ''
    if (s.trim().length > body.trim().length) (body = s), (seenOnly = true)
    if (!body.trim()) return []
    const label = labels?.[i] || String(i + 1)
    return [`[page ${label}${seenOnly ? ', text recognized from the page image' : ''}]\n${body}`]
  })
  if (!pages.length && failed) throw failed
  return { text: pages.join('\n\n'), pages: pdf.numPages }
}

// No backticks or ${ in here: it's a template literal.
const OCR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$ext = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
$asOp = $ext | Where-Object { $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' } | Select-Object -First 1
$asAction = $ext | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
function Await($op, [Type]$type) { $t = $asOp.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
function AwaitAction($op) { $t = $asAction.Invoke($null, @($op)); $t.Wait(-1) | Out-Null }
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { throw 'Windows has no text recognition language installed' }
function Recognize($stream) {
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $bitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bitmap, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8)
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  ($result.Lines | ForEach-Object { $_.Text }) -join [char]10
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($args[0])) ([Windows.Storage.StorageFile])
$out = @{}
if ($args[2] -eq 'image') {
  [Console]::Error.WriteLine('ocr 1')
  $out['1'] = Recognize (Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream]))
  [Console]::Error.WriteLine('page 1')
} else {
  $pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  foreach ($n in $args[3].Split(',')) {
    [Console]::Error.WriteLine('ocr ' + $n)
    $page = $pdf.GetPage([uint32]$n - 1)
    $scale = [Math]::Min(3, 4000 / [Math]::Max($page.Size.Width, $page.Size.Height))
    $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opts.DestinationWidth = [uint32]($page.Size.Width * $scale)
    $opts.DestinationHeight = [uint32]($page.Size.Height * $scale)
    $mem = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    AwaitAction ($page.RenderToStreamAsync($mem, $opts))
    $out[$n] = Recognize $mem
    [Console]::Error.WriteLine('page ' + $n)
  }
}
[IO.File]::WriteAllText($args[1], ($out | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
`

/** Text recognized in an image, or in some pages of a PDF, by page number. Logs "ocr i" and "page i" like files.ts. */
function recognize(file: string, kind: 'image' | 'pdf', pages: number[], onProgress?: Progress): Promise<Record<string, string>> {
  const list = kind === 'pdf' ? pages : [1]
  return withTemp(async (tmp) => {
    const script = path.join(tmp, 'ocr.ps1')
    const out = path.join(tmp, 'out.json')
    await fs.promises.writeFile(script, OCR_SCRIPT)
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, path.resolve(file), out, kind, pages.join(',')]
    await new Promise<void>((resolve, reject) => {
      const p = spawn(POWERSHELL, args, { windowsHide: true })
      const timer = setTimeout(() => p.kill(), 30 * 60_000)
      let stderr = ''
      let pending = ''
      p.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk
        const lines = (pending + chunk).split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) {
          const m = /^(ocr|page) (\d+)$/.exec(line.trim())
          if (m) onProgress?.({ done: list.indexOf(Number(m[2])) + (m[1] === 'page' ? 1 : 0), total: list.length, ocr: true })
        }
      })
      p.on('error', reject)
      p.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) return resolve()
        const why = /no text recognition language installed/.test(stderr) ? "can't be read: Windows has no text recognition language installed" : `couldn't be read as ${kind === 'pdf' ? 'a PDF' : 'an image'}`
        reject(new Error(why))
      })
    })
    const json = JSON.parse((await fs.promises.readFile(out, 'utf8')).trim() || '{}') as Record<string, string | string[]>
    return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, Array.isArray(v) ? v.join('\n') : v ?? '']))
  })
}

/** EPUB chapters (XHTML) as text, in order. */
export const htmlText = async (files: string[]) => (await Promise.all(files.map((c) => fs.promises.readFile(c, 'utf8')))).map(fromHtml).join('\n\n')
