import './style.css';
import { decodeToMono16k, recordSeconds, pcmToWavBlob } from './lib/audio.js';
import SttWorker from './workers/stt-worker.js?worker';
import TtsWorker from './workers/tts-worker.js?worker';

const STT_MODELS = [
  {
    id: 'onnx-community/moonshine-tiny-ONNX',
    label: 'Moonshine Tiny',
    checked: true,
    note: 'EN realtime, ~53 MB WebGPU',
  },
  {
    id: 'onnx-community/whisper-tiny',
    label: 'Whisper Tiny',
    checked: true,
    note: '99 langs incl. fi/sv, ~73 MB',
  },
  {
    id: 'onnx-community/whisper-base',
    label: 'Whisper Base',
    checked: false,
    note: 'Better fi/sv, ~139 MB',
  },
];

const TTS_MODELS = [
  {
    id: 'kokoro',
    label: 'Kokoro-82M',
    checked: true,
    note: 'Best quality/size, streaming, EN',
  },
  {
    id: 'kitten',
    label: 'KittenTTS Nano',
    checked: true,
    note: '~25 MB, WASM, EN voices',
  },
];

const results = [];
let audioBuf = null;
let audioUrl = null;
let sampleMeta = { durationSec: 0 };

const $ = (sel) => document.querySelector(sel);

function setStatus(el, msg) {
  el.textContent = msg || '';
}

function renderChecks(container, models) {
  container.innerHTML = '';
  for (const m of models) {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = m.id;
    cb.checked = m.checked;
    cb.dataset.id = m.id;
    lab.append(cb, document.createTextNode(` ${m.label}`));
    const tip = document.createElement('span');
    tip.className = 'hint';
    tip.style.margin = '0';
    tip.textContent = ` — ${m.note}`;
    lab.append(tip);
    container.append(lab);
  }
}

function selected(container) {
  return [...container.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
}

async function detectCaps() {
  const caps = $('#caps');
  const pills = [];
  let webgpu = false;
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      webgpu = !!adapter;
    }
  } catch {}
  pills.push(`<span class="pill ${webgpu ? 'on' : 'off'}">WebGPU ${webgpu ? 'yes' : 'no'}</span>`);
  pills.push(`<span class="pill on">WASM yes</span>`);
  const ua = navigator.userAgent;
  const isAndroid = /Android/i.test(ua);
  const isMac = /Macintosh|Mac OS X/i.test(ua);
  pills.push(`<span class="pill">${isAndroid ? 'Android' : isMac ? 'Mac' : 'Desktop/other'}</span>`);
  pills.push(`<span class="pill">${navigator.hardwareConcurrency || '?'} threads</span>`);
  if (navigator.deviceMemory) pills.push(`<span class="pill">${navigator.deviceMemory} GB RAM (approx)</span>`);
  caps.innerHTML = pills.join('');
  return { webgpu };
}

function addResult(row) {
  results.push({
    ...row,
    ts: new Date().toISOString(),
    ua: navigator.userAgent,
    deviceMemory: navigator.deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
  });
  renderTable();
}

function renderTable() {
  const tbody = $('#results tbody');
  tbody.innerHTML = '';
  for (const r of results) {
    const tr = document.createElement('tr');
    const cells = [
      r.modelId,
      r.task,
      `${r.device}${r.dtype ? ` (${r.dtype})` : ''}`,
      r.loadMs?.toFixed?.(0) ?? r.loadMs,
      r.firstOutMs?.toFixed?.(0) ?? r.firstOutMs,
      r.inferMs?.toFixed?.(0) ?? r.inferMs,
      r.audioSec?.toFixed?.(2) ?? '',
      r.rtf == null ? '' : r.rtf.toFixed(3),
      r.notes || r.text || '',
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c == null ? '' : String(c);
      if (String(c).length > 48) td.title = String(c);
      tr.append(td);
    }
    tbody.append(tr);
  }
}

function progressLine(info) {
  if (!info) return '';
  if (info.status === 'progress' && info.file) {
    return `${info.file}: ${(info.progress ?? 0).toFixed(0)}%`;
  }
  if (info.status === 'progress_total') return `total ${(info.progress ?? 0).toFixed(0)}%`;
  return info.status || '';
}

function runWorkerJobs(WorkerCtor, jobs, onProgress) {
  return new Promise((resolve) => {
    const worker = new WorkerCtor();
    const pending = new Map();
    const out = [];
    let done = 0;

    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === 'progress' || msg.type === 'log') {
        onProgress?.(msg);
        return;
      }
      if (msg.type === 'result' || msg.type === 'error') {
        const job = pending.get(msg.id);
        if (!job) return;
        pending.delete(msg.id);
        out.push(msg);
        done++;
        if (done >= jobs.length) {
          worker.terminate();
          resolve(out);
        } else {
          // start next sequentially to avoid OOM on phones
          startNext();
        }
      }
    };

    let idx = 0;
    function startNext() {
      if (idx >= jobs.length) return;
      const job = jobs[idx++];
      pending.set(job.id, job);
      worker.postMessage(job.payload);
    }
    // One at a time
    startNext();
  });
}

async function loadSample() {
  const res = await fetch(`${import.meta.env.BASE_URL}samples/sample.wav`);
  const buf = await res.arrayBuffer();
  audioBuf = buf;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  $('#preview').src = audioUrl;
  const decoded = await decodeToMono16k(buf);
  sampleMeta = decoded;
  setStatus($('#stt-status'), `Sample ready: ${decoded.durationSec.toFixed(2)} s @ 16 kHz`);
  return decoded;
}

async function runStt() {
  const ids = selected($('#stt-checks'));
  if (!ids.length) {
    setStatus($('#stt-status'), 'Pick at least one STT model.');
    return;
  }
  if (!audioBuf) await loadSample();
  const decoded = await decodeToMono16k(audioBuf);
  sampleMeta = decoded;

  const btn = $('#btn-run-stt');
  btn.disabled = true;
  setStatus($('#stt-status'), `Running ${ids.length} model(s)…`);

  const jobs = ids.map((modelId, i) => ({
    id: `stt-${i}-${Date.now()}`,
    payload: {
      id: `stt-${i}-${Date.now()}`,
      action: 'transcribe',
      modelId,
      samples: decoded.samples,
      sampleRate: 16000,
      preferWebGPU: true,
    },
  }));
  // Fix ids to match payload
  jobs.forEach((j) => {
    j.id = j.payload.id;
  });

  // Transfer samples copy per job sequentially inside worker; send copy once
  // Re-build jobs to share one worker and transfer samples each time (copy)
  const worker = new SttWorker();
  const out = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const samplesCopy = decoded.samples.slice();
    setStatus($('#stt-status'), `STT ${i + 1}/${jobs.length}: ${job.payload.modelId}`);
    const result = await new Promise((resolve) => {
      const onMsg = (ev) => {
        const msg = ev.data;
        if (msg.type === 'progress') {
          setStatus(
            $('#stt-status'),
            `STT ${i + 1}/${jobs.length}: ${job.payload.modelId}\n${progressLine(msg.info)}`,
          );
          return;
        }
        if (msg.type === 'log') {
          setStatus($('#stt-status'), `STT: ${msg.message}`);
          return;
        }
        if (msg.id !== job.id) return;
        if (msg.type === 'result' || msg.type === 'error') {
          worker.removeEventListener('message', onMsg);
          resolve(msg);
        }
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage(
        { ...job.payload, samples: samplesCopy },
        [samplesCopy.buffer],
      );
    });
    out.push(result);
    if (result.type === 'error') {
      addResult({
        modelId: result.modelId,
        task: 'stt',
        device: '—',
        dtype: '',
        loadMs: null,
        firstOutMs: null,
        inferMs: null,
        audioSec: decoded.durationSec,
        rtf: null,
        notes: `ERROR: ${result.message}`,
        text: '',
      });
    } else {
      addResult({
        modelId: result.modelId,
        task: 'stt',
        device: result.device,
        dtype: result.dtype,
        loadMs: result.loadMs,
        firstOutMs: result.firstOutMs,
        inferMs: result.inferMs,
        audioSec: result.audioSec,
        rtf: result.rtf,
        notes: result.notes,
        text: result.text,
      });
    }
  }
  worker.terminate();
  setStatus(
    $('#stt-status'),
    out
      .map((r) =>
        r.type === 'error'
          ? `${r.modelId}: ERROR ${r.message}`
          : `${r.modelId}: "${(r.text || '').trim()}"  RTF=${r.rtf?.toFixed?.(3)}`,
      )
      .join('\n'),
  );
  btn.disabled = false;
}

async function runTts() {
  const ids = selected($('#tts-checks'));
  if (!ids.length) {
    setStatus($('#tts-status'), 'Pick at least one TTS model.');
    return;
  }
  const text = $('#tts-text').value.trim();
  if (!text) {
    setStatus($('#tts-status'), 'Enter some text.');
    return;
  }
  const btn = $('#btn-run-tts');
  btn.disabled = true;

  const worker = new TtsWorker();
  let lastAudio = null;
  let lastRate = 24000;

  for (let i = 0; i < ids.length; i++) {
    const modelKey = ids[i];
    const id = `tts-${i}-${Date.now()}`;
    setStatus($('#tts-status'), `TTS ${i + 1}/${ids.length}: ${modelKey}`);
    const result = await new Promise((resolve) => {
      const onMsg = (ev) => {
        const msg = ev.data;
        if (msg.type === 'progress') {
          setStatus(
            $('#tts-status'),
            `TTS ${i + 1}/${ids.length}: ${modelKey}\n${progressLine(msg.info)}`,
          );
          return;
        }
        if (msg.type === 'log') {
          setStatus($('#tts-status'), `TTS: ${msg.message}`);
          return;
        }
        if (msg.id !== id) return;
        if (msg.type === 'result' || msg.type === 'error') {
          worker.removeEventListener('message', onMsg);
          resolve(msg);
        }
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage({
        id,
        action: 'synthesize',
        modelKey,
        text,
        preferWebGPU: true,
      });
    });

    if (result.type === 'error') {
      addResult({
        modelId: result.modelId,
        task: 'tts',
        device: '—',
        dtype: '',
        loadMs: null,
        firstOutMs: null,
        inferMs: null,
        audioSec: null,
        rtf: null,
        notes: `ERROR: ${result.message}`,
      });
    } else {
      addResult({
        modelId: result.modelId,
        task: 'tts',
        device: result.device,
        dtype: result.dtype,
        loadMs: result.loadMs,
        firstOutMs: result.firstOutMs,
        inferMs: result.inferMs,
        audioSec: result.audioSec,
        rtf: result.rtf,
        notes: result.notes,
      });
      lastAudio = result.audio;
      lastRate = result.sampleRate;
    }
  }
  worker.terminate();

  if (lastAudio) {
    const blob = pcmToWavBlob(lastAudio, lastRate);
    const url = URL.createObjectURL(blob);
    $('#tts-preview').src = url;
  }
  setStatus($('#tts-status'), 'TTS done. Last model audio is in the player.');
  btn.disabled = false;
}

async function main() {
  renderChecks($('#stt-checks'), STT_MODELS);
  renderChecks($('#tts-checks'), TTS_MODELS);
  await detectCaps();
  await loadSample().catch((e) => setStatus($('#stt-status'), `Sample load failed: ${e.message}`));

  $('#btn-play-sample').onclick = () => {
    const a = $('#preview');
    a.currentTime = 0;
    a.play();
  };

  $('#btn-rec').onclick = async () => {
    setStatus($('#stt-status'), 'Recording 4 seconds…');
    try {
      const rec = await recordSeconds(4);
      audioBuf = rec.buf;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = rec.url;
      $('#preview').src = audioUrl;
      const decoded = await decodeToMono16k(rec.buf);
      sampleMeta = decoded;
      setStatus($('#stt-status'), `Recorded ${decoded.durationSec.toFixed(2)} s`);
    } catch (e) {
      setStatus($('#stt-status'), `Mic error: ${e.message}`);
    }
  };

  $('#btn-run-stt').onclick = () => runStt();
  $('#btn-run-tts').onclick = () => runTts();

  $('#btn-copy').onclick = async () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      timezoneHint: 'device local',
      userAgent: navigator.userAgent,
      webgpu: !!navigator.gpu,
      results,
    };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    const ok = $('#copy-ok');
    ok.hidden = false;
    setTimeout(() => {
      ok.hidden = true;
    }, 1500);
  };

  $('#btn-clear').onclick = () => {
    results.length = 0;
    renderTable();
  };
}

main();
