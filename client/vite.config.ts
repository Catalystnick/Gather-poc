import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
    // Pre-bundle the RNNoise package so Vite handles its WASM import correctly.
    exclude: ['@timephy/rnnoise-wasm'],
  },
})
