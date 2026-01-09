// @ts-check
import { createBaseConfig, reactConfig, prettierConfig } from './packages/config/eslint.config.js';

/** @type {import('eslint').Linter.Config[]} */
export default [...createBaseConfig(import.meta.dirname), ...reactConfig, prettierConfig];
