import { createBaseConfig, reactConfig, testConfig, prettierConfig } from '@hushbox/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    // `public/preview` is not source: it is the marketing site's build, copied
    // in by the preview task so the bundler carries it into this origin's
    // assets. Its emitted chunks are another build's output, held to that
    // build's rules and not to this package's — and linting them overruns the
    // formatter outright, so the whole gate dies rather than reporting.
    ignores: ['src/routeTree.gen.ts', 'public/preview/**'],
  },
  ...createBaseConfig(import.meta.dirname),
  ...reactConfig,
  ...testConfig,
  prettierConfig,
];
