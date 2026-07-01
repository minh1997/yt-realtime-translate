import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = dirname(fileURLToPath(import.meta.url));

// pcm-worklet.js is loaded by the browser via audioContext.audioWorklet.addModule().
// It must exist as a plain, unbundled static file next to offscreen.html, so we
// copy it verbatim instead of letting Rollup process it as a module import.
function copyPcmWorkletPlugin() {
  return {
    name: 'copy-pcm-worklet',
    closeBundle() {
      const outDir = resolve(__dirname, 'dist/offscreen');
      mkdirSync(outDir, { recursive: true });
      copyFileSync(
        resolve(__dirname, 'src/offscreen/pcm-worklet.js'),
        resolve(outDir, 'pcm-worklet.js')
      );
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, 'src'),
  publicDir: resolve(__dirname, 'public'),
  plugins: [react(), copyPcmWorkletPlugin()],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/background.js'),
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
        sidepanel: resolve(__dirname, 'src/sidepanel/sidepanel.html'),
      },
      output: {
        // Force the background service worker to a stable, predictable path
        // (referenced directly from manifest.json). Everything else (the
        // offscreen and side panel JS/CSS bundles, discovered automatically
        // from their HTML entry points) can use hashed asset names.
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
            return 'background/background.js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
