// @ts-check
import {
  createBaseConfig,
  nodeConfig,
  testConfig,
  scriptsConfig,
  prettierConfig,
  NO_CONSOLE_RULE,
} from '@hushbox/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
const eslintConfig = [
  {
    // The dist snapshots this package caches are build output: minified bundles
    // whose single lines run to thousands of characters. Lint cost is linear in
    // bytes rather than in files, so walking them dominated this package's gate
    // while proving nothing about any source. Nothing a linter would visit here
    // is tracked, and a gate should not walk what the repository does not track.
    // What version control does keep here, a generated JSON map the ignore rules
    // re-include, resolves to no lint configuration with or without this entry.
    ignores: ['.cache/**'],
  },
  ...createBaseConfig(import.meta.dirname),
  ...nodeConfig,
  ...testConfig,
  ...scriptsConfig,
  {
    // CODE-RULES: `log`/`info`/`debug` are allowed only in CLI entry points
    // under `scripts/`. A directory name here says nothing about whether a file
    // is run or imported, so scriptsConfig's blanket exemption is withdrawn over
    // the whole tree and handed back one file at a time below — a helper that
    // wants to report progress returns it to the entry point that prints.
    // Withdrawn over `**/*.ts` rather than over the directories that hold a
    // print today, so a subtree added later is governed on arrival instead of
    // exempt until someone thinks to look at it. Scoped to this package rather
    // than to the shared scriptsConfig because `ops/` composes the same export
    // and keeps its CLI entry points in `ops/lib/` (`generate:ops-dispatch` runs
    // `ops/lib/generate-dispatch-options.ts`), so no glob separates the roles
    // for both trees at once.
    files: ['**/*.ts'],
    rules: {
      // The base policy itself, imported rather than re-typed: a withdrawal that
      // restated it would enforce a stale console policy over this tree the moment
      // the base one changed, with nothing to notice.
      'no-console': NO_CONSOLE_RULE,
    },
  },
  {
    // Exact paths, never a name shape: nothing in a filename says whether a
    // module is run or imported, and the two roles sit side by side here
    // (`ensure-stack-cli.ts` is the `pnpm ensure-stack` target; the
    // `ensure-stack.ts` it imports is not). Every file below is named as an
    // execution target by a checked-in caller — a package.json script, a
    // workflow run step, a husky hook, or playwright.config.ts's reporter list.
    // A new CLI script adds itself here; a new helper does not, and reports
    // through the entry point that already prints. Both exemption lists in this
    // file are checked from another package by `packages/config/eslint-config.test.mjs`:
    // each entry must exist, hold no glob metacharacter, and carry one of the two
    // kinds of evidence below.
    files: [
      'bake-mobile-image.ts',
      'cap-test-update.ts',
      'cassette-store.ts',
      'concurrency.ts',
      'configure-git-clone.ts',
      'db-auth-ready.ts',
      'dev-clean.ts',
      'docker-cleanup.ts',
      'e2e-reporter.ts',
      'ensure-gitleaks.ts',
      'ensure-stack-cli.ts',
      'exec-runtime-shim.ts',
      'extract-version.ts',
      'fix-binary-privacy.ts',
      'gate-auditor.ts',
      'generate-assets.ts',
      'generate-env.ts',
      'generate-headers.ts',
      'generate-screenshots.ts',
      'git-window.ts',
      'linear/board.ts',
      'lint-check.ts',
      'merge-marketing-into-web.ts',
      'mobile-test.ts',
      'normalize-commit-date.ts',
      'normalize-migration-journal.ts',
      'pre-push.ts',
      'privacy-check.ts',
      'privacy-gate.ts',
      'privacy-sweep.ts',
      'publication/publish-mirror.ts',
      'publication/sync-alignment.ts',
      'publication/sync-auditor.ts',
      'publication/sync-inbound.ts',
      'publish-model-weights.ts',
      'readme/generate-banner.ts',
      'readme/generate-icons.ts',
      'readme/generate-problem-flow.ts',
      'readme/generate-readme.ts',
      'readme/generate-tables.ts',
      'readme/preview-readme.ts',
      'refresh-catalog.ts',
      'run-checks.ts',
      'run-package-tests.ts',
      'seed.ts',
      'skills/generate-skills.ts',
      'stack-database-ready.ts',
      'test-batch.ts',
      'test-watch.ts',
      'turbo-pool.ts',
      'verify-bundle.ts',
      'verify-commit-dates.ts',
      'verify-design-tokens.ts',
      'verify-document-paths.ts',
      'verify-env.ts',
      'verify-evidence.ts',
      'verify-licenses.ts',
      'verify-typecheck-coverage.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // The same exemption on weaker evidence, kept in its own block so the
    // difference stays visible. No caller in the repo names any of these as an
    // execution target, so each rests on declaring itself one: a top-level
    // main-module guard whose body reads `process.argv` and exits with the code
    // its action returns. `bound-mutants.ts` and `bound-sweep.ts` carry more
    // than that — each rejects an empty argument list with a `Usage:` line, and
    // each one's only print sits lexically inside the guard, so an importer of
    // their exported functions cannot reach it.
    files: ['bound-mutants.ts', 'bound-sweep.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  prettierConfig,
];

export default eslintConfig;
