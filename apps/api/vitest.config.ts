import { defineProject, mergeConfig } from 'vitest/config';
import rootConfig from '@hushbox/config/vitest';

export default mergeConfig(
  rootConfig,
  defineProject({
    test: {
      name: 'api',
      environment: 'node',
      globals: true,
      exclude: ['**/dist/**', '**/node_modules/**'],
    },
  })
);
