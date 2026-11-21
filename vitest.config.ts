import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Same JSX transform as the Next build, so components need no `import React` for tests.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    restoreMocks: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
