// @ts-check
import { createBaseConfig, nodeConfig, prettierConfig } from './packages/config/eslint.config.js';

/**
 * The repo-root files belong to no workspace, so nothing linted them: ESLint
 * discovers no nested configs, and every package's `eslint .` runs from its own
 * root and resolves its own config there. This one governs the root level and
 * nothing else, and `typecheck:root` is its typechecking counterpart.
 *
 * Imported from `@hushbox/config` by relative path rather than by package name:
 * the root manifest declares no workspace dependencies, so the specifier would
 * not resolve. Nothing is redefined here — a second copy of a rule set would
 * enforce a stale policy over this tree the moment the shared one changed.
 *
 * @type {import('eslint').Linter.Config[]}
 */
const eslintConfig = [
  {
    // Every subdirectory is a workspace package with a config of its own. This
    // is what makes the boundary the config's rather than the invocation's: a
    // root `eslint .` would otherwise lint the whole repo under THIS rule set
    // instead of each package's.
    ignores: ['*/**', '.*/**'],
  },
  {
    // The frontend-design skill's detector: dev-only tooling that ships to no
    // user and runs on no production path, seeded verbatim at a pinned commit
    // from `pbakaus/impeccable` (Apache-2.0) and since maintained here as a
    // fork, so the directory holds that vendored code plus HushBox additions
    // written in its style — this exempts both. None of it was written to this
    // repo's conventions, and it is deliberately not held to them; the
    // provenance, the fork's divergence, and the three further upstreams the
    // surrounding skill merges are recorded in
    // `.claude/skills/frontend-design/.MAINTAINERS.md`.
    //
    // Stated here even though the workspace-package ignore already covers it:
    // that pattern excludes every dot-directory for an unrelated reason, so
    // without this line the decision to skip this tree would disappear the day
    // someone narrows it. Scoped to that one directory, so narrowing that
    // pattern brings first-party code elsewhere under `.claude/` into the gate
    // instead of leaving it exempt by inheritance.
    ignores: ['.claude/skills/frontend-design/scripts/**'],
  },
  ...createBaseConfig(import.meta.dirname),
  {
    // Withdraws the base's package-root tool-config exemption for this tree. The
    // base exempts `*.config.ts` because tool config is written against
    // third-party plugin APIs — but that exemption is stated there as a claim
    // about a file's ROLE, and these carry real logic: how every package's tests
    // and coverage run, and how the whole E2E matrix is built. MUST stay after
    // createBaseConfig — flat-config ignores resolve in order, and placed before
    // it this block is silently inert.
    ignores: ['!*.config.ts'],
  },
  ...nodeConfig,
  prettierConfig,
];

export default eslintConfig;
