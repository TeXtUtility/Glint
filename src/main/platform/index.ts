// Each OS's side of Glint behind one interface (types.ts). Only the running OS's native code is ever loaded.
import { mac } from './mac'
import type { Platform } from './types'
import { win } from './win'

export const platform: Platform = process.platform === 'win32' ? win : mac
