import { baseConfig, workersConfig, prettierConfig } from '@lome-chat/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [{ ignores: ['.wrangler/**'] }, ...baseConfig, ...workersConfig, prettierConfig];
