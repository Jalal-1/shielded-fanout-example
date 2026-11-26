import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import type { Backend } from './backend';
import './styles.css';

// `pnpm dev:mock` (Vite mode "mock") swaps the real wallet and chain for
// in-memory fakes. The check is on a build-time constant, so a production
// build contains no mock code.
async function start(): Promise<void> {
  let backend: Backend;
  let sampleAddresses: readonly string[] | undefined;

  if (import.meta.env.MODE === 'mock') {
    const { createMockChain } = await import('./mock/mock-chain');
    const funded = !new URLSearchParams(window.location.search).has('unfunded');
    const mock = createMockChain({ funded });
    window.midnight = { ...window.midnight, mock: mock.wallet };
    backend = mock.backend;
    sampleAddresses = mock.sampleAddresses;
  } else {
    // Loaded on demand: Midnight.js pulls in the ledger as WebAssembly.
    const { createRealBackend } = await import('./midnight/real-backend');
    backend = createRealBackend();
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App backend={backend} sampleAddresses={sampleAddresses} />
    </StrictMode>,
  );
}

void start();
