import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'crypto',
    environment: 'node',
    testTimeout: 30_000,
  },
});
