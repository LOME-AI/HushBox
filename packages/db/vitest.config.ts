import { defineProject, mergeConfig } from 'vitest/config';
import rootConfig from '@hushbox/config/vitest';

export default mergeConfig(
  rootConfig,
  defineProject({
    test: {
      name: 'db',
      environment: 'node',
      exclude: ['**/dist/**', '**/node_modules/**'],
    },
  })
);
