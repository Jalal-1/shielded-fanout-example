import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  // Relative asset paths, so the same build works at a domain root, under a
  // sub-path, on a preview URL and from `pnpm preview`.
  base: './',
  // public/ holds the circuit files the site serves: keys/, zkir/ and
  // compiler/. scripts/copy-zk.mjs fills it from contract/managed/FanoutToken
  // before `pnpm dev` and `pnpm build`, and `vite build` copies it into dist/.
  build: {
    target: 'esnext',
    commonjsOptions: { transformMixedEsModules: true },
  },
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    // Parts of the Midnight SDK still reach for Node built-ins (Buffer, process,
    // assert). Without these the page fails the first time a transaction is built.
    nodePolyfills({
      include: ['assert', 'buffer', 'process', 'util', 'crypto', 'stream'],
      globals: { Buffer: true, process: true },
    }),
  ],
  optimizeDeps: {
    esbuildOptions: { target: 'esnext' },
    // The ledger and on-chain runtime ship as WASM and must not be pre-bundled.
    exclude: [
      '@midnightntwrk/ledger-v9',
      '@midnightntwrk/onchain-runtime-v4',
      '@midnight-ntwrk/midnight-js-protocol',
    ],
  },
  server: { port: 3000 },
  preview: { port: 3000 },
});
