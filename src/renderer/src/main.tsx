import { createRoot } from 'react-dom/client'
import { ChatPanel } from './ChatPanel'
import { ControlBar } from './ControlBar'
import { FollowUpWindow } from './FollowUp'
import { glint } from './glint'
import { Onboarding } from './Onboarding'
import { Settings } from './Settings'
import { Tooltips } from './ui'
import './styles.css'

const routes = { controlBar: ControlBar, chat: ChatPanel, onboarding: Onboarding, settings: Settings, followup: FollowUpWindow }
const route = location.hash.replace('#/', '').split('?')[0] as keyof typeof routes
const Page = routes[route] ?? (() => null)

document.documentElement.dataset.route = route
// Main shows an overlay once it has drawn (windows.ts setShown): two frames, so the update that showed it is on screen.
glint.on('window:paint', () => requestAnimationFrame(() => requestAnimationFrame(() => glint.send('window:painted'))))
// Errors in this window go to main's log, for bug reports.
window.addEventListener('error', (e) => glint.send('app:renderer-error', `${e.message} (${e.filename}:${e.lineno})`))
window.addEventListener('unhandledrejection', (e) => glint.send('app:renderer-error', `unhandled rejection: ${e.reason instanceof Error ? e.reason.stack ?? e.reason.message : String(e.reason)}`))
createRoot(document.getElementById('root')!).render(<><Page /><Tooltips /></>)
