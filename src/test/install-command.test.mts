import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { POWERSHELL } from '../main/platform/system.ts'

const run = promisify(execFile)

test("the README's one install line runs install.sh in a Mac's zsh and install.ps1 in Windows PowerShell", { skip: !['darwin', 'win32'].includes(process.platform) && 'macOS and Windows only' }, async () => {
  const line = fs.readFileSync('README.md', 'utf8').split('\n').find((l) => l.startsWith('function irm '))
  assert.ok(line, "the README's install line")
  const server = http.createServer((req, res) => res.end(req.url?.endsWith('.sh') ? 'echo ran install.sh\n' : "Write-Output 'ran install.ps1'\n"))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const cmd = line.replace(/https:\/\/\S+\/install\.ps1/, `http://127.0.0.1:${(server.address() as AddressInfo).port}/install.ps1`)
  try {
    const { stdout } = process.platform === 'win32'
      ? await run(POWERSHELL, ['-NoProfile', '-EncodedCommand', Buffer.from(cmd, 'utf16le').toString('base64')])
      : await run('/bin/zsh', ['-f', '-i', '-c', cmd]) // interactive, as typed in Terminal, without the user's rc files
    assert.match(stdout, process.platform === 'win32' ? /ran install\.ps1/ : /ran install\.sh/)
  } finally {
    server.close()
  }
})
