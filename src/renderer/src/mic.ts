import { useEffect, useRef, useState } from 'react'
import { glint, isMac, patch } from './glint'

/** Session capture settings; the Settings mic test uses the same so its meter matches what gets transcribed. */
export const MIC_CONSTRAINTS: MediaTrackConstraints = { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true }
/** Room mode: no gain control, since loudness is a clue to who is nearest the mic (the user). */
const ROOM_CONSTRAINTS: MediaTrackConstraints = { ...MIC_CONSTRAINTS, autoGainControl: false }

/** The system's default input, as Chromium lists it ("Default - AirPods"). */
const defaultMic = async () => (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audioinput' && d.deviceId === 'default')?.label

/**
 * Streams 16 kHz PCM16 chunks (50 ms) from the mic until the returned function is called. `onEnded` (once): the device
 * went away (unplugged, AirPods out of range) or the system default changed; calling the returned function doesn't count.
 */
export async function openMic(onChunk: (pcm16: ArrayBuffer) => void, constraints = MIC_CONSTRAINTS, onEnded?: () => void): Promise<() => void> {
  return openPcm(await navigator.mediaDevices.getUserMedia({ audio: constraints }), onChunk, onEnded)
}

/** Windows: everything the PC plays, through Chromium's loopback (main hands it the screen with audio: 'loopback'). */
async function openCall(onChunk: (pcm16: ArrayBuffer) => void, onEnded: () => void): Promise<() => void> {
  const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: raw, video: true })
  stream.getVideoTracks().forEach((t) => (t.stop(), stream.removeTrack(t)))
  if (!stream.getAudioTracks().length) throw new Error('Windows gave no system audio')
  return openPcm(stream, onChunk, onEnded)
}

async function openPcm(stream: MediaStream, onChunk: (pcm16: ArrayBuffer) => void, onEnded?: () => void): Promise<() => void> {
  let done = false
  const ended = () => !done && ((done = true), onEnded?.())
  // Chromium stays on the device it opened when another becomes the default (AirPods connecting), so watch for that.
  let opened: string | undefined
  const changed = () => void defaultMic().then((now) => now !== opened && ended(), () => {})
  if (onEnded) {
    stream.getAudioTracks()[0]?.addEventListener('ended', ended, { once: true })
    navigator.mediaDevices.addEventListener('devicechange', changed)
  }
  const ctx = new AudioContext({ sampleRate: 16000 }) // Chromium resamples the mic with a proper filter
  const close = () => {
    done = true
    navigator.mediaDevices.removeEventListener('devicechange', changed)
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
  }
  try {
    if (onEnded) opened = await defaultMic()
    await ctx.audioWorklet.addModule('mic-worklet.js')
    const node = new AudioWorkletNode(ctx, 'glint-mic')
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onChunk(e.data)
    ctx.createMediaStreamSource(stream).connect(node)
    node.connect(ctx.destination) // silent output; keeps the node scheduled
  } catch (err) {
    close()
    throw err
  }
  return close
}

export function useMicCapture(active: boolean, room: boolean) {
  useEffect(() => {
    if (!active) return
    let cancelled = false
    let close: (() => void) | undefined
    let failures = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    // A mic that goes away mid-session reopens on the current default, so the session doesn't go quietly deaf.
    const open = () => {
      openMic((pcm) => glint.send('audio:mic', new Uint8Array(pcm)), room ? ROOM_CONSTRAINTS : MIC_CONSTRAINTS, () => {
        close?.()
        close = undefined
        if (!cancelled) retry = setTimeout(open, 500)
      }).then(
        (c) => {
          if (cancelled) return c() // cleanup ran before the mic opened
          close = c
          failures = 0
        },
        (err) => {
          if (cancelled) return
          if (++failures < 3) retry = setTimeout(open, 1000)
          else void patch({ audioError: `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}` })
        },
      )
    }
    open()
    return () => {
      cancelled = true
      clearTimeout(retry)
      close?.()
    }
  }, [active, room])
}

/** The call's side on Windows; macOS hears it in main (audiotee). Reopened when output devices change. */
export function useCallCapture(active: boolean) {
  useEffect(() => {
    if (!active || isMac) return
    let cancelled = false
    let close: (() => void) | undefined
    let failures = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    const open = () => {
      close?.()
      close = undefined
      openCall((pcm) => glint.send('audio:call', new Uint8Array(pcm)), () => !cancelled && (clearTimeout(retry), (retry = setTimeout(open, 500)))).then(
        (c) => (cancelled ? c() : ((close = c), (failures = 0))),
        (err) => {
          if (cancelled) return
          if (++failures < 3) retry = setTimeout(open, 1000)
          else void patch({ audioError: `Couldn't hear the call: ${err instanceof Error ? err.message : String(err)}` })
        },
      )
    }
    const reopen = () => (clearTimeout(retry), (retry = setTimeout(open, 500)))
    navigator.mediaDevices.addEventListener('devicechange', reopen)
    open()
    return () => {
      cancelled = true
      clearTimeout(retry)
      navigator.mediaDevices.removeEventListener('devicechange', reopen)
      close?.()
    }
  }, [active])
}

export interface Recording {
  /** Seconds of audio captured so far. */
  seconds(): number
  /** Stops and returns the PCM16. */
  stop(): Uint8Array
  /** Stops and throws the audio away. */
  cancel(): void
}

/** Starts recording the mic; `onLevel` gets 0–1 as audio arrives. Resolves once the mic is actually open. */
export async function startRecording(onLevel: (level: number) => void): Promise<Recording> {
  const chunks: Int16Array[] = []
  let samples = 0
  const close = await openMic((pcm) => {
    const c = new Int16Array(pcm)
    chunks.push(c)
    samples += c.length
    let peak = 0
    for (const x of c) peak = Math.max(peak, Math.abs(x))
    onLevel(Math.sqrt(peak / 0x8000))
  })
  return {
    seconds: () => samples / 16000,
    stop() {
      close()
      const out = new Int16Array(samples)
      let o = 0
      for (const c of chunks) (out.set(c, o), (o += c.length))
      return new Uint8Array(out.buffer)
    },
    cancel: close,
  }
}

/** Plays 16 kHz PCM16. Web Audio, since the page's CSP blocks media from blob: and data: URLs. */
export function playPcm16(bytes: Uint8Array): { stop: () => void; ended: Promise<void> } | null {
  const s16 = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1)))
  if (!s16.length) return null
  const ctx = new AudioContext({ sampleRate: 16000 })
  const buf = ctx.createBuffer(1, s16.length, 16000)
  buf.copyToChannel(Float32Array.from(s16, (x) => x / 0x8000), 0)
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.connect(ctx.destination)
  const ended = new Promise<void>((resolve) => (src.onended = () => (void ctx.close(), resolve())))
  src.start()
  return { stop: () => src.stop(), ended }
}

/** One voice clip at a time: which id is playing, and `toggle`, which plays that id's clip or stops it. */
export function usePlayback() {
  const [playing, setPlaying] = useState<string | null>(null)
  const cur = useRef<{ id: string; stop: () => void } | null>(null)
  useEffect(() => () => cur.current?.stop(), [])
  const toggle = async (id: string) => {
    const was = cur.current?.id
    cur.current?.stop()
    cur.current = null
    setPlaying(null)
    if (was === id) return true
    const bytes = await glint.invoke<Uint8Array | null>('voice:audio', id)
    const p = bytes && playPcm16(bytes)
    if (!p) return false
    const mine = { id, stop: p.stop }
    cur.current = mine
    setPlaying(id)
    void p.ended.then(() => cur.current === mine && ((cur.current = null), setPlaying(null)))
    return true
  }
  return { playing, toggle }
}
