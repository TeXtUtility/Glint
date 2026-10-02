// Parakeet runs in this worker so ending the worker frees its ~660 MB when a session ends: sherpa-onnx holds the model
// in native memory, which the main process's garbage collector doesn't give back.
import { parentPort } from 'node:worker_threads'
import { OfflineRecognizer } from 'sherpa-onnx-node'

type Message = { t: 'load'; dir: string } | { t: 'decode'; id: number; samples: Float32Array }

let rec: OfflineRecognizer | null = null

parentPort!.on('message', async (m: Message) => {
  try {
    if (m.t === 'load') {
      const file = (f: string) => `${m.dir}/${f}`
      rec = await OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: file('encoder.int8.onnx'), decoder: file('decoder.int8.onnx'), joiner: file('joiner.int8.onnx') },
          tokens: file('tokens.txt'),
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
          modelType: 'nemo_transducer',
        },
      })
      parentPort!.postMessage({ t: 'ready' })
    } else if (m.t === 'decode' && rec) {
      const stream = rec.createStream()
      stream.acceptWaveform({ sampleRate: 16000, samples: m.samples })
      parentPort!.postMessage({ t: 'text', id: m.id, text: (await rec.decodeAsync(stream)).text.trim() })
    }
  } catch (err) {
    parentPort!.postMessage({ t: 'error', id: m.t === 'decode' ? m.id : undefined, message: (err as Error).message })
  }
})
