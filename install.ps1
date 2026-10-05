# Build Glint from source and install it for this Windows user (Windows 10 2004 or later). Run it again to update.
#
# One line, in PowerShell:
#   irm https://raw.githubusercontent.com/TeXtUtility/Glint/main/install.ps1 | iex
# From a checkout, it builds that checkout instead:
#   .\install.ps1
# GLINT_BRANCH picks another branch (Glint's beta updates set it to beta). Glint's Update button also sets GLINT_COMMIT
# to the full commit it listed, so the build is exactly that one even if the branch has moved on since.
#
# Everything is inside Install-Glint, called on the last line, so a piped script is read whole before any of it runs.
# Errors throw instead of exiting, so a terminal it was piped into stays open.

function Install-Glint {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # Windows PowerShell's progress bar slows downloads to a crawl
  $repo = 'TeXtUtility/Glint'
  $branch = if ($env:GLINT_BRANCH) { $env:GLINT_BRANCH } else { 'main' }
  $dest = Join-Path $env:LOCALAPPDATA 'Programs\Glint'
  $data = Join-Path $env:APPDATA 'Glint'
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  function Step($m) { Write-Host "==> $m" }
  function Die($m) { [Console]::Error.WriteLine("error: $m"); throw $m }
  # Windows PowerShell turns a program's stderr into errors, which 'Stop' would end the install on (npm's first
  # warning, say): here they're plain output. Returns the exit code.
  function Native {
    $ErrorActionPreference = 'Continue'
    $rest = @($args | Select-Object -Skip 1)
    & $args[0] @rest 2>&1 | ForEach-Object { "$_" } | Out-Host
    $LASTEXITCODE
  }

  if ([Environment]::OSVersion.Version.Build -lt 19041) { Die 'Windows 10 version 2004 or later is needed: earlier ones show Glint in screen shares.' }
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { Die "Windows on Arm isn't supported yet." }

  # npm.cmd, not npm: Windows PowerShell's default policy blocks npm.ps1.
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Die 'Node.js is not installed. Get version 22.18 or later from https://nodejs.org, then run this again.' }
    Step 'Installing Node.js with winget'
    Native winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node.js didn't install. Get version 22.18 or later from https://nodejs.org, then run this again." }
  }
  $nodeVersion = [version](node -p 'process.versions.node')
  if ($nodeVersion -lt [version]'22.18') { Die "Node.js 22.18 or later is needed (found $nodeVersion). Update it (winget upgrade OpenJS.NodeJS.LTS, or https://nodejs.org), then run this again." }

  $temp = @()
  Push-Location
  try {
    $here = if ($PSCommandPath) { Split-Path $PSCommandPath } else { '' }
    if ($here -and (Test-Path (Join-Path $here 'package.json')) -and (Select-String -Quiet -Path (Join-Path $here 'package.json') -Pattern '"name": "glint"')) {
      Set-Location $here
    } else {
      $commit = $env:GLINT_COMMIT
      if (-not $commit) { $commit = (Invoke-RestMethod "https://api.github.com/repos/$repo/commits/$branch").sha }
      Step "Downloading Glint ($branch at $($commit.Substring(0, 7)))"
      $src = Join-Path ([IO.Path]::GetTempPath()) ('glint-install-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
      $temp += $src
      New-Item -ItemType Directory $src | Out-Null
      try {
        Invoke-WebRequest "https://codeload.github.com/$repo/zip/$commit" -OutFile "$src\glint.zip" -UseBasicParsing
      } catch {
        Die "couldn't download commit $($commit.Substring(0, 7)) of Glint. Check the internet connection, then run this again."
      }
      if (Native $tar -xf "$src\glint.zip" -C $src) { Die "couldn't unpack the download." }
      Set-Location (Get-ChildItem $src -Directory | Select-Object -First 1).FullName
      $env:GLINT_COMMIT = $commit # no git here, so the build reads its commit from this
    }

    Step 'Installing dependencies'
    if (Native npm.cmd ci --no-audit --no-fund) { Die "couldn't install Glint's dependencies. The Glint you have is unchanged." }

    # Before anything is built or copied, so a failing build never replaces the Glint that's installed.
    Step 'Checking the code'
    if (Native npm.cmd run typecheck) { Die "this version of Glint fails its type check, so it wasn't installed. The Glint you have is unchanged." }
    if (Native npm.cmd test) { Die "this version of Glint fails its tests, so it wasn't installed. The Glint you have is unchanged." }

    Step 'Building (takes a minute or two)'
    if (Native npm.cmd run package:win) { Die "the build failed, so Glint wasn't installed. The Glint you have is unchanged." }
    $app = Join-Path (Get-Location) 'dist\win-unpacked'
    if (-not (Test-Path "$app\Glint.exe")) { Die 'the build finished but no Glint.exe was found in dist\win-unpacked.' }
    $version = node -p "require('./package.json').version"

    # Copied in beside the old one while it still runs, then swapped: a failed copy leaves the old Glint untouched.
    $staged = "$dest.new"
    $old = "$dest.old"
    Step "Copying into $dest"
    Remove-Item -Recurse -Force $staged, $old -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
    Copy-Item -Recurse $app $staged

    # Windows locks a running program's files. Glint quits once no session is live, so an update never cuts off a call.
    $running = Get-Process Glint -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dest\*" }
    if ($running) {
      Step 'Waiting for Glint to quit (it finishes a live session first)'
      New-Item -ItemType Directory -Force $data | Out-Null
      Set-Content (Join-Path $data 'quit-for-update') ''
      $running | Wait-Process
    }

    Step "Installing to $dest"
    if (Test-Path $dest) { Move-Item $dest $old }
    try {
      Move-Item $staged $dest
    } catch {
      if (Test-Path $old) { Move-Item $old $dest; Start-Process "$dest\Glint.exe" }
      Die "couldn't move the new Glint into $dest; the previous version was reopened."
    }
    Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue

    $lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Glint.lnk'
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
    $shortcut.TargetPath = "$dest\Glint.exe"
    $shortcut.WorkingDirectory = $dest
    $shortcut.Save()
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Glint'
    $uninstall = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command `"Stop-Process -Name Glint -ErrorAction SilentlyContinue; Start-Sleep 2; Remove-Item -Recurse -Force '$dest'; Remove-Item -Force '$lnk'; Remove-Item -Recurse -Force '$key'`""
    New-Item -Force $key | Out-Null
    $entry = @{ DisplayName = 'Glint'; DisplayVersion = $version; Publisher = 'TeXtUtility'; InstallLocation = $dest; DisplayIcon = "$dest\Glint.exe"; UninstallString = $uninstall }
    foreach ($k in $entry.Keys) { Set-ItemProperty $key $k $entry[$k] }
    Set-ItemProperty $key NoModify 1 -Type DWord
    Set-ItemProperty $key NoRepair 1 -Type DWord

    Step "Done: Glint $version is installed. Opening it."
    Start-Process "$dest\Glint.exe"
  } finally {
    Pop-Location
    foreach ($t in $temp) { Remove-Item -Recurse -Force $t -ErrorAction SilentlyContinue }
  }
}

Install-Glint
