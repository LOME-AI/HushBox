import { createBaseConfig, prettierConfig } from '@lome-chat/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [...createBaseConfig(import.meta.dirname), prettierConfig];
