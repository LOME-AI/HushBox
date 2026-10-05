/**
 * The ONE synthetic strict-image catalog descriptor the E2E/dev seed injects
 * into `model_catalog` after the live `catalog:refresh`.
 *
 * The live OpenRouter catalog exposes exactly one ZDR strict-`["image"]` model
 * (`E2E_MODELS.image` = seedream-4.5); the only other live ZDR strict-image
 * model prices its output per output-token, a shape the settlement gate refuses
 * (`token-priced-image`), so it is never exposed. A genuine two-distinct-model
 * image fan-out therefore needs a deterministic, E2E-owned second id — this one.
 * The mock send-provider synthesizes a canned PNG for any image id, so the send
 * path needs nothing beyond an exposable catalog row.
 *
 * The row is priced per-image, ZDR-reachable and pinned so admission, exposure
 * and settlement treat it exactly like the real seedream model; the release
 * date is fixed well in the past so no premium-recency gate ever hides it.
 */
import { applyMarkupCeilFromUsdDecimal } from '@hushbox/shared';
import { DESCRIPTOR_VERSION } from '@hushbox/api/dev-seed';
import { E2E_SEEDED_IMAGE_MODEL_ID } from './model-ids.js';
import type { UpsertCatalogParams } from '@hushbox/api/dev-seed';

export { E2E_SEEDED_IMAGE_MODEL_ID } from './model-ids.js';

/**
 * $0.04 per image as the vendor lists it — the raw PROVIDER rate, mirroring live
 * seedream-4.5 so the synthetic model prices identically.
 */
const SYNTHETIC_PER_IMAGE_PROVIDER_USD = '0.04';

/**
 * The stored rate. The catalog invariant since descriptor v2 is billable
 * (after-fee) rates only — baked from the vendor decimal with the SAME
 * one-round-up helper normalize uses, so this row can never drift from what
 * `catalog:refresh` would store for a real per-image model. Canonical decimal
 * NanoUSD wire string.
 */
const SYNTHETIC_PER_IMAGE_BILLABLE_NANO_USD = String(
  applyMarkupCeilFromUsdDecimal(SYNTHETIC_PER_IMAGE_PROVIDER_USD)
);

/** 2023-01-01T00:00:00Z in unix seconds — a fixed, well-past release date. */
const SYNTHETIC_RELEASED_AT_SECONDS = 1_672_531_200;

/**
 * Build the upsert params for the synthetic strict-image catalog row. Pure so it
 * is unit-testable against the shared descriptor/exposure predicates without a
 * database; `fetchedAt` is supplied by the caller at seed time.
 */
export function seededImageModelUpsert(fetchedAt: Date): UpsertCatalogParams {
  return {
    modelId: E2E_SEEDED_IMAGE_MODEL_ID,
    fetchedAt,
    popularityRank: null,
    content: {
      version: DESCRIPTOR_VERSION,
      id: E2E_SEEDED_IMAGE_MODEL_ID,
      provider: 'hushbox-e2e',
      inputs: ['text'],
      outputs: ['image'],
      releasedAt: SYNTHETIC_RELEASED_AT_SECONDS,
      parameters: {},
      behaviors: [],
      limits: {},
      pricing: {
        kind: 'perImage',
        anchor: SYNTHETIC_PER_IMAGE_BILLABLE_NANO_USD,
        dearest: SYNTHETIC_PER_IMAGE_BILLABLE_NANO_USD,
      },
      zdrReachable: true,
      zdrPin: ['hushbox-e2e'],
      name: 'HushBox E2E Mock Image 2',
    },
  };
}
