import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// @ricky0123/vad-web requires its worklet, ONNX model, and onnxruntime WASM files
// to be served from the same origin (our COEP headers block cross-origin loads).
// vite-plugin-static-copy makes them available at / in both dev and prod.
const vadAssets = viteStaticCopy({
  targets: [
    {
      src: 'node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js',
      dest: './',
    },
    {
      src: 'node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx',
      dest: './',
    },
    {
      src: 'node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx',
      dest: './',
    },
    {
      src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
      dest: './',
    },
    {
      src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
      dest: './',
    },
    {
      src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
      dest: './',
    },
    {
      src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
      dest: './',
    },
  ],
})

export default defineConfig({
  plugins: [react(), vadAssets],
  server: {
    port: 5173,
    host: true,
    // Proxy /socket.io through Vite so the client never makes an HTTP request
    // from an HTTPS page (mixed content). Works for both LAN and localhost.
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
    },
    // AudioWorklet scripts loaded via audioContext.audioWorklet.addModule()
    // require Cross-Origin isolation headers on some browsers. These are safe
    // to set for local dev; for production they are set at the CDN/server layer.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // Ensure .wasm files bundled by @timephy/rnnoise-wasm are included as assets.
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    // Exclude packages with WASM or worker internals from Vite's pre-bundler.
    // onnxruntime-web uses dynamic WASM loading that the bundler can't handle.
    exclude: ['@timephy/rnnoise-wasm', '@ricky0123/vad-web', 'onnxruntime-web'],
  },
})
