import { defineProject, mergeConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import rootConfig from '@hushbox/config/vitest';

export default mergeConfig(
  rootConfig,
  defineProject({
    plugins: [react()],
    test: {
      name: 'marketing',
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test-setup.ts'],
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
  })
);
