// @ts-check
import {
  createBaseConfig,
  nodeConfig,
  testConfig,
  scriptsConfig,
  prettierConfig,
} from '@lome-chat/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...createBaseConfig(import.meta.dirname),
  ...nodeConfig,
  ...testConfig,
  ...scriptsConfig,
  prettierConfig,
];
