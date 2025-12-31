// @ts-check
import { baseConfig, reactConfig, prettierConfig } from './packages/config/eslint.config.js';

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...baseConfig,
  ...reactConfig,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  prettierConfig,
];
