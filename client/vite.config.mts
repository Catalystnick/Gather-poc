import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";

// @ricky0123/vad-web requires its worklet, ONNX model, and onnxruntime WASM files
// to be served from the same origin (our COEP headers block cross-origin loads).
// vite-plugin-static-copy makes them available at / in both dev and prod.
const vadAssets = viteStaticCopy({
  targets: [
    {
      src: "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js",
      dest: "./",
    },
    {
      src: "node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx",
      dest: "./",
    },
    {
      src: "node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx",
      dest: "./",
    },
    {
      src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
      dest: "./",
    },
    {
      src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
      dest: "./",
    },
    {
      src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm",
      dest: "./",
    },
    {
      src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs",
      dest: "./",
    },
    // @timephy/rnnoise-wasm: worklet and deps for RNnoise noise suppression (COEP-safe).
    // Transform adds .js to import paths — browsers require extensions for ESM resolution.
    {
      src: "node_modules/@timephy/rnnoise-wasm/dist/NoiseSuppressorWorklet.js",
      dest: "./",
      transform: (content: string | Buffer) => {
        const str = typeof content === "string" ? content : content.toString("utf-8");
        return str.replace(/"\.\/([^"]+)"/g, (_, path) => (path.endsWith(".js") ? `"./${path}"` : `"./${path}.js"`));
      },
    },
    {
      src: "node_modules/@timephy/rnnoise-wasm/dist/polyfills.js",
      dest: "./",
    },
    {
      src: "node_modules/@timephy/rnnoise-wasm/dist/RnnoiseProcessor.js",
      dest: "./",
    },
    {
      src: "node_modules/@timephy/rnnoise-wasm/dist/index.js",
      dest: "./",
    },
    {
      src: "node_modules/@timephy/rnnoise-wasm/dist/math.js",
      dest: "./",
    },
    {
      src: "node_modules/@timephy/rnnoise-wasm/dist/generated/rnnoise-sync.js",
      dest: "./generated/",
    },
  ],
});

export default defineConfig({
  plugins: [react(), vadAssets],
  server: {
    port: 5173,
    host: true,
    // Proxy /socket.io through Vite so the client never makes an HTTP request
    // from an HTTPS page (mixed content). Works for both LAN and localhost.
    proxy: {
      "/socket.io": {
        target: "http://localhost:3001",
        ws: true,
        changeOrigin: true,
      },
      "/livekit": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/tenant": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
    // AudioWorklet scripts loaded via audioContext.audioWorklet.addModule()
    // require Cross-Origin isolation headers on some browsers. These are safe
    // to set for local dev; for production they are set at the CDN/server layer.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  // Ensure .wasm files bundled by @timephy/rnnoise-wasm are included as assets.
  assetsInclude: ["**/*.wasm", "**/*.onnx"],
  optimizeDeps: {
    // @timephy/rnnoise-wasm: WASM + worklet pair loaded at runtime — keep excluded.
    // @ricky0123/vad-web: CJS-only, must be pre-bundled to ESM.
    // onnxruntime-web/wasm: included so esbuild sees both entry points in one run and
    //   can resolve vad-web's require("onnxruntime-web/wasm") as a proper inter-chunk
    //   import rather than a __require shim. Resolves to ort.wasm.bundle.min.mjs (ESM,
    //   self-contained) via the exports map — no external WASM file references.
    exclude: ['@timephy/rnnoise-wasm'],
    include: ['@ricky0123/vad-web', 'onnxruntime-web/wasm'],
  },
});
