import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    retry: 1,
    // 15s gives slow integration tests (e.g. message-shares with media
    // middleware spin-up) headroom under heavy parallel `test:all` load
    // while still catching genuine hangs. Tightening below this caused
    // sporadic timeouts that masked true-pass tests.
    testTimeout: 15000,
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 95,
        branches: 95,
        functions: 95,
        statements: 95,
      },
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/index.ts',
        'e2e/**',
        'mocks/**',
        '**/*.{test,spec}.?(c|m)[jt]s?(x)',
        '**/__tests__/**',
      ],
    },
  },
});
