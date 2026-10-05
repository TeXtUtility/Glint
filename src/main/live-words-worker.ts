// Streaming speech recognition off the main thread: sherpa-onnx's streaming decode is synchronous, up to ~120 ms
// per 560 ms chunk on a base M1, which would stall the app's windows and IPC.
import { parentPort } from 'node:worker_threads'
import { OnlineRecognizer } from 'sherpa-onnx-node'
import { serve } from './worker'

type Stream = ReturnType<OnlineRecognizer['createStream']>
type Message =
  | { t: 'load'; dir: string }
  | { t: 'start'; role: string; seq: number }
  | { t: 'audio'; role: string; samples: Float32Array }
  | { t: 'end'; role: string }

let rec: OnlineRecognizer | null = null
/** Each side's stream, and which utterance it is: partials carry it so the app can drop a finished one's. */
const streams = new Map<string, { st: Stream; seq: number }>()

serve((m: Message) => {
  try {
    if (m.t === 'load') {
      const file = (f: string) => `${m.dir}/${f}`
      rec = new OnlineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: file('encoder.int8.onnx'), decoder: file('decoder.int8.onnx'), joiner: file('joiner.int8.onnx') },
          tokens: file('tokens.txt'),
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
      })
      parentPort!.postMessage({ t: 'ready' })
    } else if (m.t === 'start' && rec) {
      streams.set(m.role, { st: rec.createStream(), seq: m.seq })
    } else if (m.t === 'audio' && rec) {
      const s = streams.get(m.role)
      if (!s) return
      const { st } = s
      st.acceptWaveform({ sampleRate: 16000, samples: m.samples })
      let decoded = false
      while (rec.isReady(st)) (rec.decode(st), (decoded = true))
      if (decoded) parentPort!.postMessage({ t: 'partial', role: m.role, seq: s.seq, text: rec.getResult(st).text.trim() })
    } else if (m.t === 'end') {
      streams.delete(m.role)
    }
  } catch (err) {
    parentPort!.postMessage({ t: 'error', message: (err as Error).message })
  }
})
