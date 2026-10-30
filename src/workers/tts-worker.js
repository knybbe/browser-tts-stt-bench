import { env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;

const models = new Map();

async function detectWebGPU() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

async function getKokoro(preferWebGPU) {
  const key = `kokoro|${preferWebGPU ? 'webgpu' : 'wasm'}`;
  if (models.has(key)) return models.get(key);
  const { KokoroTTS } = await import('kokoro-js');
  const loadStart = performance.now();
  let device = 'wasm';
  let dtype = 'q8';
  let tts;
  if (preferWebGPU && (await detectWebGPU())) {
    try {
      tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: 'fp32',
        device: 'webgpu',
        progress_callback: (info) => self.postMessage({ type: 'progress', modelId: 'kokoro', info }),
      });
      device = 'webgpu';
      dtype = 'fp32';
    } catch (err) {
      self.postMessage({
        type: 'log',
        modelId: 'kokoro',
        message: `WebGPU failed (${err?.message || err}); falling back to WASM q8`,
      });
    }
  }
  if (!tts) {
    tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (info) => self.postMessage({ type: 'progress', modelId: 'kokoro', info }),
    });
    device = 'wasm';
    dtype = 'q8';
  }
  const loadMs = performance.now() - loadStart;
  models.set(key, { kind: 'kokoro', tts, device, dtype, loadMs });
  return models.get(key);
}

async function getKitten() {
  const key = 'kitten|wasm';
  if (models.has(key)) return models.get(key);
  const { KittenTTS } = await import('kitten-tts-js');
  const loadStart = performance.now();
  // npm kitten-tts-js 0.1.x is WASM-only; uses KittenML Hub repos.
  const tts = await KittenTTS.from_pretrained('KittenML/kitten-tts-nano-0.8');
  const loadMs = performance.now() - loadStart;
  models.set(key, { kind: 'kitten', tts, device: 'wasm', dtype: 'int8/fp32', loadMs });
  return models.get(key);
}

function mergeFloat32(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    merged.set(c, o);
    o += c.length;
  }
  return merged;
}

self.onmessage = async (ev) => {
  const { id, action, modelKey, text, preferWebGPU } = ev.data;
  try {
    if (action !== 'synthesize') return;
    const entry =
      modelKey === 'kokoro' ? await getKokoro(preferWebGPU !== false) : await getKitten();

    const inferStart = performance.now();
    let firstOutMs = null;
    let audio;
    let sampleRate = 24000;

    if (entry.kind === 'kokoro') {
      const pcmChunks = [];
      for await (const part of entry.tts.stream(text, { voice: 'af_heart' })) {
        if (firstOutMs == null) firstOutMs = performance.now() - inferStart;
        const ra = part.audio;
        sampleRate = ra.sampling_rate || 24000;
        pcmChunks.push(ra.audio);
      }
      if (!pcmChunks.length) throw new Error('Kokoro returned no audio');
      audio = mergeFloat32(pcmChunks);
    } else {
      // Stream sentence chunks for first-audio latency
      const pcmChunks = [];
      if (typeof entry.tts.stream === 'function') {
        for await (const part of entry.tts.stream(text, { voice: 'Bella' })) {
          if (firstOutMs == null) firstOutMs = performance.now() - inferStart;
          const ra = part.audio;
          sampleRate = ra.sampling_rate || entry.tts.sampleRate || 24000;
          pcmChunks.push(ra.data || ra.audio);
        }
        audio = mergeFloat32(pcmChunks);
      } else {
        const ra = await entry.tts.generate(text, { voice: 'Bella' });
        firstOutMs = performance.now() - inferStart;
        sampleRate = ra.sampling_rate || entry.tts.sampleRate || 24000;
        audio = ra.data || ra.audio;
      }
      if (!audio?.length) throw new Error('KittenTTS returned no audio');
    }

    const inferMs = performance.now() - inferStart;
    const audioSec = audio.length / sampleRate;
    // Transfer a copy so we keep ownership of typed array meta
    const transfer = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
    const out = new Float32Array(transfer);
    self.postMessage(
      {
        type: 'result',
        id,
        modelId: modelKey,
        device: entry.device,
        dtype: entry.dtype,
        loadMs: entry.loadMs,
        firstOutMs: firstOutMs ?? inferMs,
        inferMs,
        audioSec,
        rtf: audioSec > 0 ? inferMs / 1000 / audioSec : null,
        sampleRate,
        audio: out,
        notes: entry.kind === 'kokoro' ? 'streamed sentences' : 'kitten nano (~25MB, WASM)',
      },
      [out.buffer],
    );
    entry.loadMs = 0;
  } catch (err) {
    self.postMessage({
      type: 'error',
      id,
      modelId: modelKey,
      message: err?.message || String(err),
      stack: err?.stack,
    });
  }
};
