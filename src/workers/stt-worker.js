import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;

const pipes = new Map();

async function detectWebGPU() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

async function getPipe(modelId, preferWebGPU) {
  const key = `${modelId}|${preferWebGPU ? 'webgpu' : 'wasm'}`;
  if (pipes.has(key)) return pipes.get(key);

  const loadStart = performance.now();
  let device = 'wasm';
  let dtype = 'q8';

  if (preferWebGPU && (await detectWebGPU())) {
    try {
      const opts = modelId.includes('moonshine')
        ? { device: 'webgpu', dtype: 'q4f16' }
        : { device: 'webgpu', dtype: 'fp16' };
      const p = await pipeline('automatic-speech-recognition', modelId, {
        ...opts,
        progress_callback: (info) => self.postMessage({ type: 'progress', modelId, info }),
      });
      device = 'webgpu';
      dtype = opts.dtype;
      const loadMs = performance.now() - loadStart;
      pipes.set(key, { pipe: p, device, dtype, loadMs });
      return pipes.get(key);
    } catch (err) {
      self.postMessage({
        type: 'log',
        modelId,
        message: `WebGPU failed (${err?.message || err}); falling back to WASM`,
      });
    }
  }

  const p = await pipeline('automatic-speech-recognition', modelId, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: (info) => self.postMessage({ type: 'progress', modelId, info }),
  });
  const loadMs = performance.now() - loadStart;
  pipes.set(key, { pipe: p, device: 'wasm', dtype: 'q8', loadMs });
  return pipes.get(key);
}

self.onmessage = async (ev) => {
  const { id, action, modelId, samples, sampleRate, preferWebGPU } = ev.data;
  try {
    if (action === 'transcribe') {
      const entry = await getPipe(modelId, preferWebGPU !== false);
      const inferStart = performance.now();
      const result = await entry.pipe(samples, {
        sampling_rate: sampleRate || 16000,
        return_timestamps: false,
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      const inferMs = performance.now() - inferStart;
      const text = typeof result === 'string' ? result : result?.text || '';
      const audioSec = (samples?.length || 0) / (sampleRate || 16000);
      self.postMessage({
        type: 'result',
        id,
        modelId,
        device: entry.device,
        dtype: entry.dtype,
        loadMs: entry.loadMs,
        firstOutMs: inferMs,
        inferMs,
        audioSec,
        rtf: audioSec > 0 ? inferMs / 1000 / audioSec : null,
        text,
        notes: '',
      });
      // subsequent loads are cached
      entry.loadMs = 0;
    } else if (action === 'dispose') {
      for (const [, entry] of pipes) {
        try {
          await entry.pipe.dispose?.();
        } catch {}
      }
      pipes.clear();
      self.postMessage({ type: 'disposed', id });
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      id,
      modelId,
      message: err?.message || String(err),
      stack: err?.stack,
    });
  }
};
