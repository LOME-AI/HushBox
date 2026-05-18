import { defineProject, mergeConfig } from 'vitest/config';
import rootConfig from '@hushbox/config/vitest';

export default mergeConfig(
  rootConfig,
  defineProject({
    test: {
      name: 'crypto',
      environment: 'node',
      testTimeout: 30_000,
    },
  })
);
