import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { State } from '../../shared/state'

interface GlintBridge {
  on(channel: string, cb: (payload: any) => void): () => void
  send(channel: string, payload?: unknown): void
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  /** The latest state; the preload keeps it from before the page runs. */
  state(): State | null
  platform: string
}

declare global {
  interface Window {
    glint: GlintBridge
  }
}

const bridge = window.glint
/** The preload bridge, with IPC errors reduced to the message main threw (Electron prefixes it). */
export const glint: GlintBridge = {
  ...bridge,
  invoke: <T,>(channel: string, ...args: unknown[]) =>
    bridge.invoke<T>(channel, ...args).catch((err: Error) => {
      throw new Error(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''))
    }),
}

// Main forwards its own errors so they show up in each window's DevTools console.
glint.on('app:error', (msg: string) => console.error('[main]', msg))
export const isMac = glint.platform === 'darwin'
/** As in "on this Mac". */
export const COMPUTER = isMac ? 'Mac' : 'PC'
export const OS = isMac ? 'macOS' : 'Windows'
export const SYSTEM_SETTINGS = isMac ? 'System Settings' : 'Windows Settings'
export const ENCRYPTED = isMac ? 'encrypted with your keychain' : 'encrypted for your Windows account'
export const KEY_GONE = isMac ? 'the keychain key that protected it is gone' : "Windows can't unlock it anymore"

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] }
export const patch = (p: DeepPartial<State>) => glint.invoke('state:patch', p)

/** The opacity settings as CSS variables on an overlay's root element (read by .bar, .panel and .discreet). */
export const opacityStyle = (o: State['opacity']) =>
  ({ '--overlay-opacity': o.overlay, '--glass-alpha': o.background, '--idle-opacity': o.idle }) as CSSProperties

export function useAppState(): State | null {
  const [s, set] = useState<State | null>(glint.state)
  useEffect(() => {
    // Main sends only the top-level keys that changed; the rest keep their identity, so memoized parts skip.
    const off = glint.on('state:changed', (changed: Partial<State>) => set((cur) => (cur ? { ...cur, ...changed } : glint.state())))
    set(glint.state()) // a change between the first render and subscribing
    return off
  }, [])
  return s
}

export function useTick(active: boolean) {
  const [, setN] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setN((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])
}

/** A page's new frame reaches the screen about three frames after the change; main's blur, about one (screen recordings). */
const GROW_WAIT_FRAMES = 4
const afterFrames = (n: number, fn: () => void): void => void requestAnimationFrame(() => (n > 1 ? afterFrames(n - 1, fn) : fn()))

/**
 * Tells main where this page's glass surfaces are, so it can blur what's behind them (macOS vibrancy under the page).
 * Re-sent when they move, resize, fade or come and go, and on every render of the caller, from its layout effects. A
 * caller that reports its size to main calls this first, so a smaller surface's blur goes before its window shrinks.
 */
/** `ax`: how much of a window width change moves the surfaces (see mac-panel.ts): 0.5 centred, 0 or 1 pinned left or right. */
export function useGlass(selector: string, active: boolean, ax = 0.5) {
  const measureNow = useRef<(() => void) | null>(null)
  useLayoutEffect(() => measureNow.current?.())
  useEffect(() => {
    document.documentElement.classList.toggle('glass', active)
    if (!active) return void glint.send('window:glass', { rects: [], vw: innerWidth })
    let raf = 0
    let queued = false
    let last = ''
    let lastArea = 0
    let sent = 0
    let resized = false
    // Measured as soon as the page changes. Blur outside a surface shows as a dark ghost, so a surface that grew gets
    // its blur once the page has drawn it bigger, and one that shrank gets it at once. Mid-animation it follows each frame.
    const measure = () => {
      queued = false
      cancelAnimationFrame(raf)
      const animating = fading()
      const now = animating || resized // a window resize: the page's frame at the new size is already on its way
      resized = false
      const rects = [...document.querySelectorAll<HTMLElement>(selector)].map((el) => {
        // Inside the border, where the page's tint is, so no blur shows round the edge.
        const b = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        const bw = parseFloat(cs.borderTopWidth) || 0
        const r = Math.max(0, (parseFloat(cs.borderTopLeftRadius) || 0) - bw)
        // Its opacity, times how frosted it is (--frost in styles.css).
        const frost = parseFloat(cs.getPropertyValue('--frost'))
        return { x: b.x + bw, y: b.y + bw, w: b.width - 2 * bw, h: b.height - 2 * bw, r, a: parseFloat(cs.opacity) * (Number.isFinite(frost) ? frost : 1) }
      }).filter((g) => g.w > 0 && g.h > 0)
      const key = JSON.stringify([innerWidth, rects])
      if (key !== last) {
        const area = rects.reduce((n, g) => n + g.w * g.h * g.a, 0)
        const n = ++sent
        const send = () => n === sent && glint.send('window:glass', { rects, vw: innerWidth, ax })
        if (area > lastArea && !now) afterFrames(GROW_WAIT_FRAMES, send)
        else send()
        lastArea = area
      }
      last = key
      if (animating) raf = requestAnimationFrame(measure)
    }
    const report = () => void (queued || ((queued = true), queueMicrotask(measure)))
    measureNow.current = measure
    // A surface fading, or popping in or out, is followed frame by frame, so the blur moves with the glass instead of
    // catching up when it ends.
    const fading = () => document.getAnimations().some((a) =>
      (a instanceof CSSAnimation || (a instanceof CSSTransition && ['opacity', '--frost'].includes(a.transitionProperty))) && a.playState === 'running'
      && a.effect instanceof KeyframeEffect && !!a.effect.target?.matches(selector))
    report()
    const mo = new MutationObserver(report)
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] })
    const onResize = () => ((resized = true), report())
    window.addEventListener('resize', onResize)
    const events = ['transitionrun', 'transitionend', 'animationend'] as const
    events.forEach((ev) => window.addEventListener(ev, report))
    return () => (measureNow.current = null, cancelAnimationFrame(raf), mo.disconnect(), window.removeEventListener('resize', onResize), events.forEach((ev) => window.removeEventListener(ev, report)), glint.send('window:glass', { rects: [], vw: innerWidth }))
  }, [selector, active, ax])
}

