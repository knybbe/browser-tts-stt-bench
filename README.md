# Browser TTS / STT Bench

Static benchmark page for in-browser speech-to-text and text-to-speech models (WebGPU with WASM fallback).

**Live:** https://knybbe.github.io/browser-tts-stt-bench/

## Models included

### STT
| Model | Hub | Notes |
|-------|-----|-------|
| Moonshine Tiny | `onnx-community/moonshine-tiny-ONNX` | English, low-latency, ~53 MB WebGPU |
| Whisper Tiny | `onnx-community/whisper-tiny` | Multilingual (incl. Finnish/Swedish) |
| Whisper Base | `onnx-community/whisper-base` | Better accuracy, larger download |

### TTS
| Model | Hub / package | Notes |
|-------|---------------|-------|
| Kokoro-82M | `onnx-community/Kokoro-82M-v1.0-ONNX` via `kokoro-js` | Streaming sentences, WebGPU |
| KittenTTS Nano | `KittenML/kitten-tts-nano-0.8` via `kitten-tts-js` | ~25 MB, WASM |

Piper (Finnish/Swedish voices) and Voxtral Mini Realtime (~2.6 GB) are documented on the research Page but not in the default bench to keep phone downloads small.

## Local

```bash
npm install
npm run dev
```

## Build / Pages

```bash
npm run build
```

GitHub Pages serves `dist/` from the `gh-pages` branch (or `/docs`). Models download from Hugging Face on first Run and are cached by the browser.

## Metrics

- **Load ms** — cold model download + init (0 after cache within the same worker)
- **First out ms** — time to first transcript / first audio chunk
- **Infer ms** — full generation time
- **RTF** — infer seconds / audio seconds (lower is better; &lt; 1 is faster than realtime)

Copy results as JSON and paste into the research Page placeholder.
