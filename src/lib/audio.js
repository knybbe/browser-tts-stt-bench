/** Decode an ArrayBuffer of audio into Float32Array mono @ 16 kHz. */
export async function decodeToMono16k(arrayBuffer) {
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  const ch0 = decoded.getChannelData(0);
  let mono;
  if (decoded.numberOfChannels > 1) {
    mono = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / decoded.numberOfChannels;
    }
  } else {
    mono = ch0;
  }
  if (decoded.sampleRate === 16000) {
    return { samples: mono, sampleRate: 16000, durationSec: mono.length / 16000 };
  }
  const ratio = decoded.sampleRate / 16000;
  const newLen = Math.floor(mono.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) out[i] = mono[Math.floor(i * ratio)];
  return { samples: out, sampleRate: 16000, durationSec: newLen / 16000 };
}

export async function recordSeconds(seconds = 4) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/mp4')
      ? 'audio/mp4'
      : '';
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const done = new Promise((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  recorder.stop();
  await done;
  stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
  const buf = await blob.arrayBuffer();
  return { blob, buf, url: URL.createObjectURL(blob) };
}

export function pcmToWavBlob(float32, sampleRate) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: 'audio/wav' });
}
