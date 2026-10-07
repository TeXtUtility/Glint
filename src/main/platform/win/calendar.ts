// Calendar invites on Windows come from classic Outlook: the one calendar an app installed this way can read (its COM
// interface, through PowerShell). New Outlook has no such interface. Read only, and only when the user presses Guess.
import { execFile } from 'node:child_process'
import path from 'node:path'
import type { CalendarEvent } from '../../../shared/meetings'
import { POWERSHELL, psArgs } from '../system'
import type { CalendarAccess } from '../types'

const SCRIPT = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$from = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$env:GLINT_FROM).LocalDateTime
$to = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$env:GLINT_TO).LocalDateTime
$ns = (New-Object -ComObject Outlook.Application).GetNamespace('MAPI')
$smtp = { param($entry) try { $entry.GetExchangeUser().PrimarySmtpAddress } catch { '' } }
$meName = [string]$ns.CurrentUser.Name
$meMail = [string]$ns.CurrentUser.Address
if ($meMail -notmatch '@') { $meMail = [string](& $smtp $ns.CurrentUser.AddressEntry) }
$items = $ns.GetDefaultFolder(9).Items
$items.IncludeRecurrences = $true
$items.Sort('[Start]')
$found = $items.Restrict("[Start] < '" + $to.ToString('g') + "' AND [End] > '" + $from.ToString('g') + "'")
$out = @()
$a = $found.GetFirst()
while ($a -ne $null -and $out.Count -lt 50) {
  $people = @()
  foreach ($r in $a.Recipients) {
    $mail = [string]$r.Address
    if ($mail -notmatch '@') { $mail = [string](& $smtp $r.AddressEntry) }
    $people += @{ name = [string]$r.Name; email = $mail; me = (($mail -and $mail -eq $meMail) -or $r.Name -eq $meName) }
  }
  if ($a.Organizer -and -not ($people | Where-Object { $_.name -eq $a.Organizer })) { $people += @{ name = [string]$a.Organizer; email = ''; me = ($a.Organizer -eq $meName) } }
  $out += @{ title = [string]$a.Subject; start = [DateTimeOffset]::new($a.Start).ToUnixTimeMilliseconds(); end = [DateTimeOffset]::new($a.End).ToUnixTimeMilliseconds(); allDay = [bool]$a.AllDayEvent; attendees = @($people) }
  $a = $found.GetNext()
}
ConvertTo-Json -InputObject @($out) -Depth 5 -Compress`

/** Classic Outlook's COM class is registered, whether or not it's running. */
function outlookInstalled(): Promise<boolean> {
  return new Promise((resolve) =>
    execFile('reg', ['query', path.win32.join('HKCR', 'Outlook.Application', 'CLSID')], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err)),
  )
}

export const access = async (): Promise<CalendarAccess> => ((await outlookInstalled()) ? 'granted' : 'denied')
export const request = access

/** Events in Outlook's JSON, kept only where they have the fields an invite needs. */
export function parseEvents(json: string): CalendarEvent[] {
  const raw: unknown = JSON.parse(json || '[]')
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return (Array.isArray(raw) ? raw : [raw]).flatMap((e: Record<string, unknown> | null) => {
    if (!e || !Number.isFinite(e.start) || !Number.isFinite(e.end)) return []
    const people = Array.isArray(e.attendees) ? e.attendees : e.attendees ? [e.attendees] : []
    return [{
      title: str(e.title), start: e.start as number, end: e.end as number, allDay: e.allDay === true,
      attendees: people.map((p: Record<string, unknown>) => ({ name: str(p?.name), email: str(p?.email), me: p?.me === true })),
    }]
  })
}

/** Starting Outlook to answer can take a while when it isn't running. */
export function events(at: number): Promise<CalendarEvent[]> {
  const env = { ...process.env, GLINT_FROM: String(at - 6 * 3600e3), GLINT_TO: String(at + 3600e3) }
  return new Promise((resolve, reject) =>
    execFile(POWERSHELL, psArgs(SCRIPT), { env, windowsHide: true, timeout: 60_000, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err) return reject(err)
      try {
        resolve(parseEvents(stdout.trim()))
      } catch (e) {
        reject(e)
      }
    }),
  )
}
