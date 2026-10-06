import { systemPreferences } from 'electron'
import type { Perm } from '../../shared/state'

export function mediaAccess(kind: 'microphone' | 'screen'): Perm {
  const st = systemPreferences.getMediaAccessStatus(kind)
  return st === 'granted' ? 'granted' : st === 'not-determined' ? 'unknown' : 'denied'
}
