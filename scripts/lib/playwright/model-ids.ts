/**
 * The plain model-id data behind `E2E_MODELS` — deliberately free of runtime
 * imports so db-banned consumers (e2e specs/helpers may not import `@hushbox/db`) can
 * share the one id list with `scripts/lib/playwright/models.ts`'s catalog assertion.
 * Both sides import from here; there is no hand-copied mirror to drift.
 */
import type { CanonicalReasoningEffort } from '@hushbox/shared';

export interface E2eModelSet {
  readonly text: readonly string[];
  readonly image: readonly string[];
  readonly video: readonly string[];
}

/**
 * The reasoning-effort rung the `E2E_MODELS.text` ids guarantee to run at when
 * selected together — the rung the multi-model spec pins, read from here so the
 * spec and the guard that holds the pair to it name one rung.
 */
export const E2E_TEXT_PINNED_EFFORT: CanonicalReasoningEffort = 'high';

/**
 * Both referenced by the E2E specs / seed AND exposed strict-family models in
 * the live OpenRouter catalog (validated by `assertE2eModelsPresent` at refresh
 * time). Every ZDR-reachable image model this list does not name is priced in a
 * unit settlement refuses (`token-priced-image`) and is never exposed, so the
 * second id image's fan-out needs is synthetic, seeded, and below.
 *
 * Video declares nothing, and the empty list is the declaration rather than an
 * omission: no video model the gateway offers has a zero-data-retention
 * endpoint, ZDR is fail-closed, and so `catalog:refresh` excludes every one of
 * them as `non-zdr` and the live catalog exposes no video model at all. Nothing
 * in this repo can change that, so the guard is given nothing to validate for
 * video and the suite's whole video catalog is the seeded pair below.
 *
 * A TEXT id answers to three further conditions the guard also checks, because
 * the specs that drive a priced turn need each and none follows from exposure: the
 * model must let reasoning be turned OFF, so the turn-shape helper can pin the
 * rung that keeps a turn's persisted characters sizeable; it must be BASIC rather
 * than premium, because the picker refuses a premium row to any payer at a zero
 * purchased balance and several specs send exactly as that payer; and the text
 * ids selected together must run at {@link E2E_TEXT_PINNED_EFFORT}, because the
 * multi-model spec pins that rung for the pair and the effort menu greys a rung
 * whose reasoning budget plus a minimum answer outruns a model's output cap.
 *
 * They move with the live catalog, and a text id's validity is a window closed
 * at BOTH ends: a model is premium while its release sits inside
 * `PREMIUM_RECENCY_MS` or its combined rate reaches `PREMIUM_PRICE_PERCENTILE`
 * of the priceable text pool, and catalog admission drops it as `too-old` once
 * its release passes `MAX_MODEL_AGE_MS`, which only a top-context row is exempt
 * from. Age is spent rather than banked, so the id that survives longest is the
 * one furthest from the FAR edge — the deepest margin under the percentile
 * first, then the most time left before the age cutoff — never the
 * longest-released candidate that still qualifies.
 *
 * Both terms are read only over candidates this set does not already hold whose
 * ZDR reachability rests on MORE THAN ONE distinct provider. That is a bar
 * ahead of the ordering rather than a third term inside it, because it decides
 * whether an id is exposed at all: reachability is set membership over the live
 * endpoint-granular ZDR listing, so a membership carried by one provider's
 * endpoints ends the moment that provider withdraws zero data retention, while
 * one carried by endpoints from several distinct providers ends only when all
 * of them do — and an id that leaves the set is excluded as `non-zdr` and
 * refused by `assertE2eModelsPresent`. Among what clears the bar the margin
 * under the percentile decides, and time before the age cutoff separates
 * equals: the percentile moves with the pool and can reclassify a row with no
 * commit in this repo, while the age edge advances at exactly one day per day
 * and is foreseeable.
 *
 * Graded over the qualifying pool as a whole, before the bar, the bar costs
 * neither slot anything: `E2E_MODELS.text`'s second id has the deepest margin
 * under the percentile of any row that meets every condition above, and its
 * first id the deepest of the rest. What narrows the pool is the pinned rung:
 * rows outside this set with a deeper margin than the first id exist, and each
 * caps output below what that rung needs.
 */
export const E2E_MODELS = {
  text: ['z-ai/glm-4.7-flash', 'nvidia/nemotron-3-nano-30b-a3b'],
  image: ['bytedance-seed/seedream-4.5'],
  video: [],
} as const satisfies E2eModelSet;

/**
 * Live-catalog model ids that literals OUTSIDE `E2E_MODELS` name: the stamp on
 * seeded AI turns, the two demo usage mixes, and the classifier resolutions the
 * Smart Model spec mocks. Declared here so `assertE2eModelsPresent` validates
 * them too, including against the shape a gateway retirement leaves — a row
 * nothing marks, which the refresh simply stops sighting — so a retirement
 * reddens this declaration at `e2e:prepare` rather than passing the guard.
 *
 * WHAT THIS SET GUARANTEES, AND WHAT {@link E2E_MODELS} GUARANTEES BEYOND IT.
 * Here the guarantee is PRESENCE and nothing else: a sellable, exposed,
 * language-family row in the live catalog. `E2E_MODELS`'s text ids answer to
 * further conditions — a reasoning-off rung, selectability by a payer at a zero
 * purchased balance, and a pinned effort rung — and these ids answer to NONE,
 * because every site that names one needs the model to EXIST: none pins a
 * reasoning rung, and none selects it as a payer spending a free allowance. Both
 * of these are premium today, so the two sets are not interchangeable in either
 * direction. Moving an id from here into `E2E_MODELS` hands it obligations it
 * does not meet; moving one the other way strips the turn-shape pin and the
 * multi-model spec's pinned rung of the properties they depend on.
 */
export const PRESENCE_ONLY_MODELS = {
  /** Stamped on seeded AI turns, and the heaviest-weighted row of both demo usage mixes. */
  primary: 'anthropic/claude-opus-4.6',
  /** A second, distinct id: the routing spec compares two tiles' nametags, which must differ. */
  secondary: 'anthropic/claude-sonnet-4.6',
} as const;

/**
 * The text model the hold-probe spec drives, declared apart from
 * {@link E2E_MODELS} because it carries the OPPOSITE money obligation to that
 * set's text ids. That spec measures the admission hold one turn on this model
 * takes and then pins its payer's purchased balance at half of it, so the hold
 * must exceed twice the paid negative-balance cushion or the pin lands at or
 * below zero and the scarcity it needs is unreachable. At a catalog output cap
 * only a dear row prices that high, while `E2E_MODELS.text` must stay BASIC for
 * the specs whose payer sits at a zero purchased balance — one id cannot answer
 * both, which is why this is its own slot. `assertE2eModelsPresent` holds it to
 * the hold size in place of the text obligations, the same way
 * {@link PRESENCE_ONLY_MODELS} is held to presence alone.
 *
 * A second requirement decides WHICH dear row, and nothing checks it: the spec
 * observes the hold while the stream is parked, and the hold mock parks a turn
 * on its reasoning trace — ahead of any answer delta — only when the turn
 * carries a reasoning wire. An id whose reasoning is mandatory carries one
 * whatever effort the composer resolves.
 */
export const HOLD_PROBE_MODEL_ID = 'openai/gpt-5.4-pro';

/**
 * A synthetic, seed-only strict-`["image"]` model id injected into
 * `model_catalog` AFTER the live `catalog:refresh` (see `scripts/seed.ts` +
 * `seeded-image-model.ts`). Every ZDR strict-image model the live OpenRouter
 * catalog offers beyond `E2E_MODELS.image` is token-priced and excluded at
 * settlement, so a genuine two-distinct-model image fan-out
 * (`multi-model-media.spec.ts`) needs this second exposed id. It is deliberately
 * NOT in `E2E_MODELS`: that set is validated against the LIVE catalog BEFORE the
 * seed injects this row (`assertE2eModelsPresent`), which a synthetic id would
 * fail. The mock send-provider renders a canned PNG for any image id, so nothing
 * else is needed to drive it. Lives here, import-free, so the db-banned E2E spec
 * can share it.
 */
export const E2E_SEEDED_IMAGE_MODEL_ID = 'hushbox-e2e/mock-image-2';

/**
 * The synthetic, seed-only strict-`["video"]` model ids, injected the same way
 * as {@link E2E_SEEDED_IMAGE_MODEL_ID} (see `seeded-video-model.ts`).
 *
 * Two of them, where image needs only one, because the image side still has a
 * live partner and video has none: the live catalog exposes no video model
 * whatsoever, so both members of a two-distinct-model video fan-out have to be
 * ours. That also makes this pair the entire video catalog the suite sees, which
 * is why every video spec drives one of these ids. The mock send-provider
 * synthesizes a canned MP4 for any video id.
 */
export const E2E_SEEDED_VIDEO_MODEL_IDS = [
  'hushbox-e2e/mock-video-1',
  'hushbox-e2e/mock-video-2',
] as const;

/** Every E2E model id, flattened across modalities. */
export function e2eModelIds(): readonly string[] {
  return [...E2E_MODELS.text, ...E2E_MODELS.image, ...E2E_MODELS.video];
}
