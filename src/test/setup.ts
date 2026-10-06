// Loaded before every test file (`node --import`, package.json "test") so main-process modules import under plain
// Node: 'electron' and electron-vite's `?nodeWorker` imports resolve to fakes, extensionless sibling imports (which
// the bundler allows) to their .ts files, and the build-time commit is defined.
import { registerHooks } from 'node:module'

Object.assign(globalThis, { __GLINT_COMMIT__: '' })

const fake = (file: string) => new URL(file, import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: fake('./electron.ts'), shortCircuit: true }
    if (specifier.endsWith('?nodeWorker')) return { url: fake('./node-worker.ts'), shortCircuit: true }
    try {
      return next(specifier, context)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (!specifier.startsWith('.') || (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'ERR_UNSUPPORTED_DIR_IMPORT')) throw err
      return next(code === 'ERR_UNSUPPORTED_DIR_IMPORT' ? `${specifier}/index.ts` : `${specifier}.ts`, context)
    }
  },
})
