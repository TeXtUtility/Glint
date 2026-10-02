import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { commandsOf, hasHiddenControls, idleTty, wrapper } from './run.ts'

test('commandsOf: a console block keeps only its prompted lines, without the prompt', () => {
  assert.equal(commandsOf('npm ci\nnpm run build\n'), 'npm ci\nnpm run build')
  assert.equal(commandsOf('$ ls -la\ntotal 8\n$ cd src\n'), 'ls -la\ncd src')
  assert.equal(commandsOf('% brew install gh'), 'brew install gh')
  // A command continued with "\" keeps its unprompted lines; a line ending in an escaped backslash doesn't continue.
  assert.equal(commandsOf('$ docker run \\\n  -p 8080:80 \\\n  nginx\nabc123\n$ echo done'), 'docker run \\\n  -p 8080:80 \\\n  nginx\necho done')
  assert.equal(commandsOf('$ echo \\\\\nout\n$ ls'), 'echo \\\\\nls')
})

test('hasHiddenControls: escape sequences and bidi overrides, which could rewrite the review screen, are caught', () => {
  assert.equal(hasHiddenControls('ls -la\tsrc\necho done'), false)
  assert.equal(hasHiddenControls('ls # \x1b[1A\x1b[2K'), true) // erases the line above
  assert.equal(hasHiddenControls('echo \x9b2K'), true) // C1 CSI
  assert.equal(hasHiddenControls(`echo ${String.fromCharCode(0x202e)}txt.exe`), true)
  assert.equal(hasHiddenControls('echo caf\u00e9 → done'), false)
})

test('wrapper: shows the commands, runs them only on y, in the same shell', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glint-run-test-'))
  const cmds = path.join(dir, 'commands.sh')
  const marker = path.join(dir, 'ran')
  fs.writeFileSync(cmds, `touch '${marker}'\ncd '${dir}'\n`)
  const wrap = path.join(dir, 'run.sh')
  fs.writeFileSync(wrap, wrapper('bash', cmds, `touch '${marker}'`))
  const shell = (answer: string) => execFileSync('/bin/bash', ['-c', `source '${wrap}'; pwd`], { input: answer, env: { ...process.env, TERM: 'dumb' } }).toString()
  const no = shell('n')
  assert.match(no, /Glint wants to run:/)
  assert.match(no, /\x1b\[31mCheck these before you press y/) // the red warning above the question
  assert.match(no, /Not run\./)
  assert.equal(fs.existsSync(marker), false)
  const yes = shell('y')
  assert.equal(fs.existsSync(marker), true)
  assert.match(yes, new RegExp(`${path.basename(dir)}\\n?$`)) // the cd happened in the calling shell
  // A command containing a line like the heredoc's end marker still prints whole.
  assert.match(wrapper('zsh', cmds, 'echo __GLINT__\necho EOF'), /echo __GLINT__\necho EOF\n__GLINT_[0-9a-f]{12}__/)
  // Given its own temp folder, it deletes it when done, answered y or not.
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'glint-run-test-own-'))
  fs.writeFileSync(path.join(own, 'run.sh'), wrapper('bash', cmds, `touch '${marker}'`, own))
  execFileSync('/bin/bash', ['-c', `source '${path.join(own, 'run.sh')}'`], { input: 'n', env: { ...process.env, TERM: 'dumb' } })
  assert.equal(fs.existsSync(own), false)
  fs.rmSync(dir, { recursive: true })
})

test('idleTty: a tab is idle only when its shell is all that runs in the foreground', () => {
  assert.equal(idleTty('Ss   -zsh\nS+   /bin/zsh\n'), true)
  assert.equal(idleTty('S+   -zsh\n'), true)
  assert.equal(idleTty('Ss   -zsh\nS+   vim\n'), false)
  assert.equal(idleTty('Ss   -zsh\nS+   node\nS+   /usr/local/bin/claude\n'), false)
  assert.equal(idleTty('Ss   -zsh\n'), false) // no foreground process: can't tell, so not idle
  assert.equal(idleTty(''), false)
})
