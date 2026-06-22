import {
  createBaseConfig,
  reactConfig,
  astroConfig,
  testConfig,
  prettierConfig,
} from '@hushbox/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ['.astro/'],
  },
  ...createBaseConfig(import.meta.dirname),
  ...reactConfig,
  ...astroConfig,
  ...testConfig,
  prettierConfig,
];
