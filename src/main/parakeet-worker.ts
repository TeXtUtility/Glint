// Parakeet runs in this worker so ending the worker frees its ~660 MB when a session ends: sherpa-onnx holds the model
// in native memory, which the main process's garbage collector doesn't give back.
import { parentPort } from 'node:worker_threads'
import { OfflineRecognizer } from 'sherpa-onnx-node'
import { serve, transducer } from './worker'

type Message = { t: 'load'; dir: string } | { t: 'decode'; id: number; samples: Float32Array }

let rec: OfflineRecognizer | null = null

serve(async (m: Message) => {
  if (m.t === 'load') {
    rec = await OfflineRecognizer.createAsync(transducer(m.dir, { modelType: 'nemo_transducer' }))
    parentPort!.postMessage({ t: 'ready' })
  } else if (m.t === 'decode' && rec) {
    const stream = rec.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples: m.samples })
    parentPort!.postMessage({ t: 'result', id: m.id, value: (await rec.decodeAsync(stream)).text.trim() })
  }
})
