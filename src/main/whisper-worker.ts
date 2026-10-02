// Whisper (transformers.js) runs in this worker: onnxruntime decodes on the calling thread, about 500 ms per 5 s
// line with whisper-base, which stalled the app's windows and IPC. Ending the worker frees the model.
import { parentPort } from 'node:worker_threads'

type WhisperAsr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>
type Message = { t: 'load'; model: string; cacheDir: string } | { t: 'decode'; id: number; samples: Float32Array; language: string }

let asr: WhisperAsr | null = null

parentPort!.on('message', async (m: Message) => {
  try {
    if (m.t === 'load') {
      // Loaded here, not at launch: alone it's about 20 MB and most of a second, and only Whisper languages need it.
      const { env, pipeline } = await import('@huggingface/transformers')
      env.cacheDir = m.cacheDir
      asr = (await pipeline('automatic-speech-recognition', m.model, {
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' }, // a q8 decoder is ~2x faster, no visible accuracy loss
        progress_callback: (p: { status: string; progress?: number }) => {
          if (p.status === 'progress' && p.progress != null) parentPort!.postMessage({ t: 'progress', pct: p.progress })
        },
      })) as unknown as WhisperAsr
      parentPort!.postMessage({ t: 'ready' })
    } else if (m.t === 'decode' && asr) {
      const out = await asr(m.samples, { language: m.language, task: 'transcribe' })
      parentPort!.postMessage({ t: 'text', id: m.id, text: (Array.isArray(out) ? out[0] : out).text })
    }
  } catch (err) {
    parentPort!.postMessage({ t: 'error', id: m.t === 'decode' ? m.id : undefined, message: (err as Error).message })
  }
})
