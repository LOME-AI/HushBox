/**
 * Fee-seam confinement lint extension: the vendored fee-seams rule.
 *
 * BILLING.md §Fee Structure: the customer markup is applied in exactly two
 * money-path places — catalog rate baking at ingestion (ceil) and the
 * ModelProvider port's charge conversion (half-even) — plus the tool fee
 * seam, which bakes each tool's raw provider per-call price billable once.
 * This extension makes that structural: importing a fee helper
 * (`applyMarkup*` from shared money, `applyFees*` from shared pricing)
 * anywhere else fails lint, so fee
 * application can never quietly spread back into estimators, settlement, or
 * client code. Applies repo-wide (every package linting through
 * createBaseConfig); the rule self-scopes by absolute importer filename, so
 * the broad `files` glob is safe under any package's glob base path.
 */
import feeSeams from './rules/fee-seams.mjs';

/**
 * The sanctioned fee-application seams — the ONE authoritative list, matched
 * as repo-relative path suffixes of the importing file. Each site carries a
 * comment stating why it is a seam:
 *
 * - `packages/shared/src/affordability/money/money.ts` — defines the `applyMarkup*` helpers,
 *   the only non-test code that scales an amount by `MARKUP_BASIS_POINTS`.
 * - `packages/shared/src/index.ts` — the root barrel publishes the helpers to
 *   the sanctioned cross-package seams (publication, not application).
 * - `packages/shared/src/affordability/estimate/tool-pricing.ts`: each tool's
 *   raw provider per-call price, baked billable once (ceil) by its only reader.
 * - `apps/api/src/slices/models/domain/catalog/normalize.ts` — catalog ingestion:
 *   every stored rate baked billable (ceil), the first of the two money-path
 *   seams.
 * - `apps/api/src/slices/billing/domain/money.ts` — the ModelProvider port's
 *   charge conversion (half-even), the second money-path seam, and the routing
 *   cap's un-bake of a billable rate into `max_price`.
 * - `scripts/lib/playwright/seeded-image-model.ts` — the synthetic e2e catalog row's
 *   rate, baked with the same ceil helper so the seeded row can never drift
 *   from what ingestion would store.
 * - `scripts/lib/playwright/seeded-video-model.ts` — the same seam for the synthetic
 *   e2e video row's per-second rates.
 */
export const FEE_APPLICATION_SEAMS = [
  'packages/shared/src/affordability/money/money.ts',
  'packages/shared/src/index.ts',
  'packages/shared/src/affordability/estimate/tool-pricing.ts',
  'apps/api/src/slices/models/domain/catalog/normalize.ts',
  'apps/api/src/slices/billing/domain/money.ts',
  'scripts/lib/playwright/seeded-image-model.ts',
  'scripts/lib/playwright/seeded-video-model.ts',
];

const moneyPlugin = {
  meta: { name: 'money', version: '1.0.0' },
  rules: {
    'fee-seams': feeSeams,
  },
};

/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'fee-seams',
    // `.astro` is in scope deliberately: the float helper's documented consumer
    // is the marketing fee breakdown, and marketing pages are astro frontmatter.
    files: ['**/*.ts', '**/*.tsx', '**/*.astro'],
    plugins: { money: moneyPlugin },
    rules: {
      'money/fee-seams': ['error', { allowedFiles: FEE_APPLICATION_SEAMS }],
    },
  },
];
