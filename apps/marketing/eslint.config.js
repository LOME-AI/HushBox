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
  {
    files: ['public/.well-known/**/*.test.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['public/.well-known/*.test.ts'],
        },
      },
    },
  },
  ...reactConfig,
  ...astroConfig,
  ...testConfig,
  prettierConfig,
];
