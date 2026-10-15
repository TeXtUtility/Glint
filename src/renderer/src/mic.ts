import { useEffect, useRef, useState } from 'react'
import { glint, isMac, patch } from './glint'

/** Session capture settings; the Settings mic test uses the same so its meter matches what gets transcribed. */
const MIC_CONSTRAINTS: MediaTrackConstraints = { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true }
/** Room mode: no gain control, since loudness is a clue to who is nearest the mic (the user). */
const ROOM_CONSTRAINTS: MediaTrackConstraints = { ...MIC_CONSTRAINTS, autoGainControl: false }

/** The system's default input, as Chromium lists it ("Default - AirPods"). */
export const defaultMic = async () => (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audioinput' && d.deviceId === 'default')?.label

/**
 * Streams 16 kHz PCM16 chunks (100 ms) from the mic until the returned function is called. `onEnded` (once): the device
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
  // Chromium resamples the mic with a proper filter. Nothing is played, so the audio thread can wake for 32 ms buffers
  // instead of 8 ms ('playback'). (Electron 44 has no sinkId, which would skip opening the output device too.)
  const ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'playback' })
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
  useCapture(active, (ended) => openMic((pcm) => glint.send('audio:mic', new Uint8Array(pcm)), room ? ROOM_CONSTRAINTS : MIC_CONSTRAINTS, ended),
    'Microphone unavailable', false, room)
}

/** The call's side on Windows; macOS hears it in main (audiotee). Reopened when output devices change. */
export function useCallCapture(active: boolean) {
  useCapture(active && !isMac, (ended) => openCall((pcm) => glint.send('audio:call', new Uint8Array(pcm)), ended), "Couldn't hear the call", true)
}

function useCapture(active: boolean, start: (onEnded: () => void) => Promise<() => void>, failed: string, onDeviceChange: boolean, variant?: unknown) {
  useEffect(() => {
    if (!active) return
    let cancelled = false
    let close: (() => void) | undefined
    let opening = 0
    let failures = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    const reopen = () => (clearTimeout(retry), (retry = setTimeout(open, 500)))
    // A mic that goes away mid-session reopens on the current default, so the session doesn't go quietly deaf.
    const open = () => {
      const n = ++opening
      close?.()
      close = undefined
      start(() => {
        if (cancelled || n !== opening) return
        close?.()
        close = undefined
        reopen()
      }).then(
        (c) => (cancelled || n !== opening ? c() : ((close = c), (failures = 0))),
        (err) => {
          if (cancelled || n !== opening) return
          if (++failures < 3) (clearTimeout(retry), (retry = setTimeout(open, 1000)))
          else void patch({ audioError: `${failed}: ${err instanceof Error ? err.message : String(err)}` })
        },
      )
    }
    if (onDeviceChange) navigator.mediaDevices.addEventListener('devicechange', reopen)
    open()
    return () => {
      cancelled = true
      clearTimeout(retry)
      navigator.mediaDevices.removeEventListener('devicechange', reopen)
      close?.()
    }
  }, [active, variant])
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
    onLevel(peak(pcm))
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

export function peak(pcm16: ArrayBuffer) {
  let p = 0
  for (const x of new Int16Array(pcm16)) p = Math.max(p, Math.abs(x))
  return Math.sqrt(p / 0x8000) // sqrt: normal speech lands mid-meter instead of near the bottom
}

/** Plays 16 kHz PCM16. Web Audio, since the page's CSP blocks media from blob: and data: URLs. */
function playPcm16(bytes: Uint8Array): { stop: () => void; ended: Promise<void> } | null {
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
