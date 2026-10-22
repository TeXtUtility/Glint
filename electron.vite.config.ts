import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/** The commit this build came from, for Settings → About and beta updates; blank outside a git checkout. */
const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return (process.env.GLINT_COMMIT ?? '').slice(0, 7) // install.ps1 builds a download, with no git
  }
})()

/** Built by the release workflow for its installers, which update from releases rather than by building from source. */
const release = process.env.GLINT_RELEASE === '1'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], define: { __GLINT_COMMIT__: JSON.stringify(commit), __GLINT_RELEASE__: JSON.stringify(release) } },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()], define: { __GLINT_COMMIT__: JSON.stringify(commit) } },
})
