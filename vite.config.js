import { defineConfig } from 'vite';

export default defineConfig({
  base: '/browser-tts-stt-bench/',
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
