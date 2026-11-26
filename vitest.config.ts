import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Tests need no wallet and no network. The UI test opts into a browser-like
// environment with a `@vitest-environment jsdom` comment at its top.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 30_000,
  },
});
