import { appendFileSync, mkdirSync } from 'node:fs';
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

/**
 * Development only: the app posts one line per step to /__diag (see
 * src/diag.ts) and this writes them to .dev-log/diag.log, so a stuck or failed
 * transaction can be located. Not part of a production build.
 */
const devDiagnostics = (): Plugin => ({
  name: 'dev-diagnostics',
  apply: 'serve',
  configureServer(server) {
    mkdirSync('.dev-log', { recursive: true });
    server.middlewares.use('/__diag', (request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        if (body.length < 20_000) appendFileSync('.dev-log/diag.log', `${body}\n`);
        response.statusCode = 204;
        response.end();
      });
    });
  },
});

/**
 * The chain, through this server.
 *
 * The page asks its own origin for /chain/<network>/..., and this passes the
 * request to Blockfrost with the project ID added. The ID is read from
 * BLOCKFROST_<NETWORK>_ID in .env and never reaches the browser. On the hosted
 * site, deploy/nginx.conf.template does the same job.
 */
function chainProxy(env: Record<string, string>): Record<string, ProxyOptions> {
  const routes: Record<string, ProxyOptions> = {};
  for (const network of ['preprod', 'preview', 'mainnet']) {
    const projectId = env[`BLOCKFROST_${network.toUpperCase()}_ID`];
    if (!projectId) continue;
    const to = (target: string, path: string, ws = false): ProxyOptions => ({
      target,
      ws,
      changeOrigin: true,
      rewrite: () => path,
      headers: { project_id: projectId },
    });
    // The longer path first: the first route a request starts with is the one used.
    routes[`/chain/${network}/indexer/ws`] = to(`wss://midnight-${network}.blockfrost.io`, '/api/v0/ws', true);
    routes[`/chain/${network}/indexer`] = to(`https://midnight-${network}.blockfrost.io`, '/api/v0');
    routes[`/chain/${network}/node`] = to(`wss://rpc.midnight-${network}.blockfrost.io`, '/', true);
  }
  return routes;
}

export default defineConfig(({ mode }) => {
  const proxy = chainProxy(loadEnv(mode, process.cwd(), 'BLOCKFROST_'));
  return {
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
    devDiagnostics(),
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
    // The wallet SDK is pre-bundled through one local entry point; see sdk/index.js.
    include: ['fanout-wallet-sdk'],
    // The ledger and on-chain runtime ship as WASM and must not be pre-bundled.
    exclude: [
      '@midnightntwrk/ledger-v9',
      '@midnightntwrk/onchain-runtime-v4',
      '@midnight-ntwrk/midnight-js-protocol',
    ],
  },
  server: { port: 3000, proxy },
  preview: { port: 3000, proxy },
  };
});
