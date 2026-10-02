// The parts of sherpa-onnx-node Glint uses; the package ships JSDoc, not declarations.
declare module 'sherpa-onnx-node' {
  interface Stream {
    acceptWaveform(o: { sampleRate: number; samples: Float32Array }): void
    inputFinished(): void
  }
  export class SpeakerEmbeddingExtractor {
    constructor(config: { model: string; numThreads?: number; debug?: boolean; provider?: string })
    dim: number
    createStream(): Stream
    /** Electron forbids external ArrayBuffers, so always pass false. */
    compute(stream: Stream, enableExternalBuffer: false): Float32Array
  }
  interface TransducerConfig {
    featConfig: { sampleRate: number; featureDim: number }
    modelConfig: {
      transducer: { encoder: string; decoder: string; joiner: string }
      tokens: string
      numThreads?: number
      provider?: string
      debug?: number
      modelType?: string
    }
  }
  export class OfflineRecognizer {
    static createAsync(config: TransducerConfig): Promise<OfflineRecognizer>
    createStream(): Stream
    decodeAsync(stream: Stream): Promise<{ text: string }>
  }
  /** Streaming recognition; decode() runs on the calling thread. */
  export class OnlineRecognizer {
    constructor(config: TransducerConfig)
    createStream(): Stream
    isReady(stream: Stream): boolean
    decode(stream: Stream): void
    getResult(stream: Stream): { text: string }
    reset(stream: Stream): void
  }
  export class OfflineSpeakerDiarization {
    constructor(config: {
      segmentation: { pyannote: { model: string }; numThreads?: number; debug?: number }
      embedding: { model: string; numThreads?: number; debug?: number }
      clustering: { numClusters: number; threshold: number }
      minDurationOn?: number
      minDurationOff?: number
    })
    /** Turns in seconds; `speaker` is an index local to this call. */
    process(samples: Float32Array): { start: number; end: number; speaker: number }[]
  }
}
