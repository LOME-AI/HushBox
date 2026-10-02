import {
  createBaseConfig,
  reactConfig,
  testConfig,
  prettierConfig,
  docketConsoleFieldConfig,
} from '@hushbox/config/eslint';
// Relative rather than through `@hushbox/config`: the package's `exports` map
// publishes no subpath for this module, and it is the declaration every
// test-module exemption in the repository reads.
import { TEST_FILE_GLOB } from '../../packages/config/test-file-spellings.ts';

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...createBaseConfig(import.meta.dirname),
  ...reactConfig,
  ...testConfig,
  {
    // The server half of this app is the dev process itself: it ends its own
    // process with a status code when the idle window closes. Scoped to
    // `src/server` by exact directory, so the React half keeps the default ban.
    files: ['src/server/**/*.ts'],
    rules: {
      'unicorn/no-process-exit': 'off',
    },
  },
  {
    // The client half is bundled for a browser while `@hushbox/docket`'s root
    // barrel reaches `node:fs` through store.ts, and the client suite runs on Node
    // — so a value import here breaks only once a browser loads it, and no test can
    // see that. Its own rule key leaves docketConsoleFieldConfig's bans here intact.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/server/**', 'src/cli/**', TEST_FILE_GLOB],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@hushbox/docket',
              allowTypeImports: true,
              message:
                'Take values from @hushbox/docket/types — the root barrel drags node:fs into the browser bundle. Type-only imports are fine.',
            },
          ],
        },
      ],
    },
  },
  ...docketConsoleFieldConfig,
  prettierConfig,
];
