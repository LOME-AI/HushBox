/**
 * The synthetic strict-video catalog descriptors the E2E/dev seed injects into
 * `model_catalog` after the live `catalog:refresh`. Together they are the whole
 * of the suite's video catalog.
 *
 * No video model the gateway offers has a zero-data-retention endpoint, and ZDR
 * is fail-closed, so `catalog:refresh` excludes every one of them as `non-zdr`
 * and the live catalog exposes no video model at all. That is a privacy position
 * rather than a gap: nothing in this repo makes a video model sellable, so the
 * video specs drive ids this repo owns and `E2E_MODELS.video` declares none.
 * Video coverage is synthetic by design and stays that way.
 *
 * Two rows rather than one — the image side needs a single synthetic partner
 * beside its live model — because the two-distinct-model video fan-out
 * (`multi-model-media.spec.ts`) has to select two exposed strict-video ids and
 * there is no live one to pair with.
 *
 * The rows are priced per second of output and ZDR-reachable so admission and
 * settlement treat them exactly as they would a real per-second-priced video
 * model; the release date is fixed well in the past so no premium-recency gate
 * ever hides them.
 *
 * The three media axes below are chosen so the composer's default video config
 * (16:9 · 4s · 720p) is valid for every member of the set: a multi-model video
 * turn is then sendable without the client having to snap any axis. They are the
 * values a video model realistically offers.
 */
import { applyMarkupCeil } from '@hushbox/shared';
import { mediaParameterSpecs } from '@hushbox/shared/affordability';
import { DESCRIPTOR_VERSION } from '@hushbox/api/dev-seed';
import { E2E_SEEDED_VIDEO_MODEL_IDS } from './model-ids.js';
import type { UpsertCatalogParams } from '@hushbox/api/dev-seed';

export { E2E_SEEDED_VIDEO_MODEL_IDS } from './model-ids.js';

/**
 * Raw PROVIDER per-second rates in nano-USD ($0.05/s at 720p, $0.08/s at 1080p).
 * 1080p is priced strictly above 720p because `video-generation.spec.ts` asserts
 * the cost preview rises with the resolution at a fixed duration; equal rates
 * would let that spec pass over a broken estimator. This object is also the
 * resolution domain: the estimator resolves a matrix rate by strict exact-key
 * lookup, so deriving both from one literal makes "every declared resolution has
 * a rate" true by construction rather than by review.
 */
const SYNTHETIC_PER_SECOND_PROVIDER_NANO_USD = {
  '720p': 50_000_000n,
  '1080p': 80_000_000n,
} as const;

const SYNTHETIC_RESOLUTIONS = Object.keys(SYNTHETIC_PER_SECOND_PROVIDER_NANO_USD);
const SYNTHETIC_ASPECT_RATIOS = ['16:9', '9:16'] as const;
const SYNTHETIC_DURATIONS_SECONDS = [4, 6, 8] as const;

/**
 * The stored matrix. The catalog invariant since descriptor v2 is billable
 * (after-fee) rates only — baked with the SAME ceil-markup helper normalize
 * uses, so these rows can never drift from what `catalog:refresh` would store
 * for a real per-second-priced model.
 */
const SYNTHETIC_PER_SECOND_BILLABLE_NANO_USD: Record<string, string> = Object.fromEntries(
  Object.entries(SYNTHETIC_PER_SECOND_PROVIDER_NANO_USD).map(([resolution, providerNano]) => [
    resolution,
    applyMarkupCeil(providerNano).toString(),
  ])
);

/** 2023-01-01T00:00:00Z in unix seconds — a fixed, well-past release date. */
const SYNTHETIC_RELEASED_AT_SECONDS = 1_672_531_200;

/**
 * Build the upsert params for every synthetic strict-video catalog row, one per
 * {@link E2E_SEEDED_VIDEO_MODEL_IDS} entry and in that order. Pure so the rows
 * are unit-testable against the shared descriptor/exposure predicates without a
 * database; `fetchedAt` is supplied by the caller at seed time.
 *
 * The rows differ only in identity — same axes, same rates — so either can stand
 * in for the other in a single-model video spec while the pair still drives a
 * genuine two-model fan-out.
 */
export function seededVideoModelUpserts(fetchedAt: Date): readonly UpsertCatalogParams[] {
  return E2E_SEEDED_VIDEO_MODEL_IDS.map((modelId, index) => ({
    modelId,
    fetchedAt,
    popularityRank: null,
    content: {
      version: DESCRIPTOR_VERSION,
      id: modelId,
      provider: 'hushbox-e2e',
      inputs: ['text'],
      outputs: ['video'],
      releasedAt: SYNTHETIC_RELEASED_AT_SECONDS,
      parameters: mediaParameterSpecs({
        resolution: SYNTHETIC_RESOLUTIONS,
        aspectRatio: SYNTHETIC_ASPECT_RATIOS,
        durationSeconds: SYNTHETIC_DURATIONS_SECONDS,
      }),
      behaviors: [],
      limits: {},
      pricing: {
        kind: 'perSecond',
        anchor: SYNTHETIC_PER_SECOND_BILLABLE_NANO_USD,
        dearest: SYNTHETIC_PER_SECOND_BILLABLE_NANO_USD,
      },
      zdrReachable: true,
      name: `HushBox E2E Mock Video ${String(index + 1)}`,
    },
  }));
}
