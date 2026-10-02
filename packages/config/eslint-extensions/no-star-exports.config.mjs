/**
 * Wildcard re-export ban for the shared package: the vendored no-star-exports
 * rule.
 *
 * `@hushbox/shared` publishes the money vocabulary both apps price through, so
 * a name that reaches its barrels is public. `export * from './fees.js'`
 * enrols every future declaration in that leaf automatically — the surface
 * widens with no line written at any barrel and nothing to review. The rule
 * makes each widening an explicit re-export line. Applies repo-wide (every
 * package linting through createBaseConfig); the rule self-scopes by absolute
 * filename to `scopeDir`, so the broad `files` glob below is safe under any
 * package's glob base path.
 *
 * A star into a barrel that only forwards names stays legal, and that carries
 * the whole design: `affordability/dimensions/index.ts` needs no exemption
 * because it enumerates itself, and the same test governs its own re-exports.
 */
import noStarExports from './rules/no-star-exports.mjs';

/** The tree the ban governs, as a repo-relative directory prefix. */
const STAR_EXPORT_SCOPE_DIR = 'packages/shared/src/';

/**
 * The ONE authoritative exemption list, matched as repo-relative path suffixes
 * of the file holding the wildcard. Each entry carries the gate that stands in
 * for enumeration:
 *
 * - `affordability/estimate/index.ts` and `affordability/smart-model/index.ts`
 *   publish a set-equality inventory pinned in `affordability/index.test.ts`
 *   (`ESTIMATE_SUBBARREL_SURFACE`, `SMART_MODEL_SUBBARREL_SURFACE`). A pin that
 *   fails on an added name as loudly as a removed one is a STRONGER gate than
 *   enumeration, so converting these would trade a set equality for a weaker
 *   guarantee and redden the door-set pin for a non-regression.
 * - `packages/shared/src/index.ts` carries wildcards that predate the ban and
 *   belong to surfaces it never covered. `exceptTargetsUnder` keeps the money
 *   layer gated at this second entry point regardless: the root barrel is one
 *   of the two doors into the affordability tree, and exempting it wholesale
 *   would leave that door open while reporting it closed.
 */
export const STAR_EXPORT_EXEMPTIONS = [
  { file: 'packages/shared/src/affordability/estimate/index.ts' },
  { file: 'packages/shared/src/affordability/smart-model/index.ts' },
  {
    file: 'packages/shared/src/index.ts',
    exceptTargetsUnder: 'packages/shared/src/affordability/',
  },
];

const barrelPlugin = {
  meta: { name: 'barrel', version: '1.0.0' },
  rules: {
    'no-star-exports': noStarExports,
  },
};

/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'no-star-exports',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { barrel: barrelPlugin },
    rules: {
      'barrel/no-star-exports': [
        'error',
        { scopeDir: STAR_EXPORT_SCOPE_DIR, exemptions: STAR_EXPORT_EXEMPTIONS },
      ],
    },
  },
];
