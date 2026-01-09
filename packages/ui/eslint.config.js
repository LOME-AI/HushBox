import { createBaseConfig, reactConfig, prettierConfig } from '@lome-chat/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [...createBaseConfig(import.meta.dirname), ...reactConfig, prettierConfig];
