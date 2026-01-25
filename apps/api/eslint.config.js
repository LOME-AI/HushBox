import {
  createBaseConfig,
  workersConfig,
  testConfig,
  devServicesConfig,
  prettierConfig,
} from '@lome-chat/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  { ignores: ['.wrangler/**'] },
  ...createBaseConfig(import.meta.dirname),
  ...workersConfig,
  ...devServicesConfig,
  ...testConfig,
  prettierConfig,
];
