import {
  createBaseConfig,
  reactConfig,
  astroConfig,
  testConfig,
  prettierConfig,
} from '@hushbox/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...createBaseConfig(import.meta.dirname),
  ...reactConfig,
  ...astroConfig,
  ...testConfig,
  prettierConfig,
];
