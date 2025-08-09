// Runs on the audio thread. The AudioContext is created at 16 kHz, so Chromium has already resampled.
const CHUNK = 1600 // 100 ms at 16 kHz: half the wakeups and IPC of 50 ms; the extra delay is small next to VAD's pauses

class GlintMic extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Int16Array(CHUNK)
    this.n = 0
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]))
        this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff
        if (this.n === CHUNK) {
          this.port.postMessage(this.buf.buffer, [this.buf.buffer])
          this.buf = new Int16Array(CHUNK)
          this.n = 0
        }
      }
    }
    return true // outputs stay silent; we're only connected so the graph keeps pulling us
  }
}

registerProcessor('glint-mic', GlintMic)
