import { createBaseConfig, reactConfig, testConfig, prettierConfig } from '@hushbox/config/eslint';
// Relative rather than through `@hushbox/config`: the package's `exports` map
// publishes no subpath for this module, and it is the declaration every
// test-module exemption in the repository reads.
import { TEST_FILE_GLOB } from '../../packages/config/test-file-spellings.ts';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      'src/routeTree.gen.ts',
      // Each native project is a build tree carrying one synced copy of the web
      // bundle, minus the guard tests checked in among its sources. Unignoring
      // the directories is what makes the file negation that follows it work at
      // all: a pattern that ignores a directory prunes it before any negation
      // inside is consulted, which is how `!<tree>/**/*.test.ts` alone sat here
      // reading as if it re-included those tests while every one of them stayed
      // unlinted. The trailing slash keeps the negation to directories, so
      // every file in the tree but a `.test.ts` remains ignored.
      'android/**',
      '!android/**/',
      '!android/**/*.test.ts',
      'ios/**',
      '!ios/**/',
      '!ios/**/*.test.ts',
    ],
  },
  ...createBaseConfig(import.meta.dirname),
  {
    // The native guard tests sit in build trees holding no tsconfig, so the
    // project service finds no program for them and every rule that needs type
    // information fails to parse. `tsconfig.native-tests.json` is the program
    // that already covers exactly this set — `pnpm typecheck` compiles them
    // through it — so pointing lint at the same file leaves one declaration of
    // which files these are. The service's own escape hatch cannot express it:
    // `allowDefaultProject` rejects a glob containing `**`, which is the only
    // shape that reaches a test nested under `android/app/src/main/java/...`,
    // and the enumeration it forces instead stops covering the next guard test
    // somebody adds.
    files: ['ios/**/*.test.ts', 'android/**/*.test.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.native-tests.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...reactConfig,
  ...testConfig,
  {
    // Server state must flow through TanStack Query hooks wrapping the typed
    // api-client. Raw fetch() is invisible to useIsMutating, which makes the
    // settled-aware E2E harness fire its grace timer mid-mutation and throw
    // false negatives (see auth-mutations.ts for the migration template).
    //
    // The allowlist covers files that legitimately can't use TanStack:
    //   - api-client.ts / sse-client.ts: the wrappers themselves
    //   - use-chat-stream.ts: SSE streaming, has its own activity store
    //   - use-decrypt-blob.ts: direct R2 download URL, not an API endpoint
    //   - auth/client.ts: legacy OPAQUE flow, migrate via the auth-mutations.ts pattern
    //   - recovery-phrase-modal.tsx: same legacy migration path
    //   - dev.personas.tsx: dev-only feature
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/lib/api-client.ts',
      'src/lib/sse-client.ts',
      'src/lib/auth/client.ts',
      'src/hooks/chat/use-chat-stream.ts',
      'src/hooks/crypto/use-decrypt-blob.ts',
      'src/components/auth/recovery-phrase-modal.tsx',
      'src/routes/dev.personas.tsx',
      TEST_FILE_GLOB,
    ],
    rules: {
      // Both restrictions in one rule body — ESLint's no-restricted-globals
      // doesn't merge across config blocks, so listing only `fetch` here
      // would silently disable the requestAnimationFrame check from the base
      // config (see packages/config/eslint.config.js).
      'no-restricted-globals': [
        'error',
        {
          name: 'requestAnimationFrame',
          message:
            'Use useAnimationFrame from @hushbox/ui instead — respects accessibility motion settings.',
        },
        {
          name: 'fetch',
          message:
            'Use TanStack Query hooks wrapping the typed api-client (see hooks/auth-mutations.ts). Raw fetch() is invisible to useIsMutating and breaks the settled-aware E2E harness.',
        },
      ],
    },
  },
  prettierConfig,
];
