import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** A temp folder for `fn`, deleted after it. */
export async function withTemp<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'glint-')) // removeLeftoverTemp clears it after a crash
  try {
    return await fn(tmp)
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true })
  }
}
