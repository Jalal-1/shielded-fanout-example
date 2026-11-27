import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The tests cover the logic that can be checked without a wallet or a network.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 30_000,
  },
});
