// Speaker ID off the main thread: a voice embedding takes ~50 ms for 4 s of speech and a speaker split ~35 ms for a
// 9 s line, which blocked windows, IPC and dragging when someone stopped talking. Ending the worker frees both models.
import { parentPort } from 'node:worker_threads'
import { OfflineSpeakerDiarization, SpeakerEmbeddingExtractor } from 'sherpa-onnx-node'

type Message =
  | { t: 'load'; model: string; segmentation: string }
  | { t: 'embed'; id: number; samples: Float32Array }
  | { t: 'split'; id: number; samples: Float32Array }

let extractor: SpeakerEmbeddingExtractor | null = null
let splitter: OfflineSpeakerDiarization | null = null
let paths = { model: '', segmentation: '' }

parentPort!.on('message', (m: Message) => {
  try {
    if (m.t === 'load') {
      paths = { model: m.model, segmentation: m.segmentation }
      extractor = new SpeakerEmbeddingExtractor({ model: m.model, numThreads: 1, debug: false })
      parentPort!.postMessage({ t: 'ready' })
    } else if (m.t === 'embed' && extractor) {
      const stream = extractor.createStream()
      stream.acceptWaveform({ sampleRate: 16000, samples: m.samples })
      stream.inputFinished()
      parentPort!.postMessage({ t: 'result', id: m.id, value: Array.from(extractor.compute(stream, false)) })
    } else if (m.t === 'split' && extractor) {
      splitter ??= new OfflineSpeakerDiarization({
        segmentation: { pyannote: { model: paths.segmentation }, numThreads: 1, debug: 0 },
        embedding: { model: paths.model, numThreads: 1, debug: 0 },
        clustering: { numClusters: -1, threshold: 0.5 },
        minDurationOn: 0.3,
        minDurationOff: 0.5,
      })
      parentPort!.postMessage({ t: 'result', id: m.id, value: splitter.process(m.samples) })
    }
  } catch (err) {
    parentPort!.postMessage({ t: 'error', id: 'id' in m ? m.id : undefined, message: (err as Error).message })
  }
})
