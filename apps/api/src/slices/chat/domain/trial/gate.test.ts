import { describe, expect, it } from 'vitest';
import { HOUR_MS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';

import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { trialGateVerdict } from './gate.js';
import type { Modality, ModelDescriptor } from '@hushbox/shared';

const NOW_MS = TEST_DAY_START + 12 * HOUR_MS;
/**
 * Well outside the premium recency window, so the recency leg never fires. A
 * different instant from the shared old-release stamp (`OLD_RELEASE_SECONDS` in
 * `packages/shared/src/testing/test-instants.ts`): swapping this for that import
 * moves the fixture's release date by well over two years.
 */
const PRE_RECENCY_RELEASE_SECONDS = secondsAt(TEST_DAY_START - 40_000 * HOUR_MS);

function pricing(inputPerToken: bigint, outputPerToken: bigint): ModelDescriptor['pricing'] {
  return tokenPricingFixture({ input: inputPerToken, output: outputPerToken });
}

function model(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'trial/cheap',
    provider: 'vendor',
    version: '1',
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    parameters: {},
    behaviors: [],
    limits: { contextLength: 1_000_000 },
    pricing: pricing(1n, 1n),
    zdrReachable: true,
    releasedAt: PRE_RECENCY_RELEASE_SECONDS,
    fetchedAt: 0,
    ...overrides,
  };
}

/**
 * Three mid-priced text models, in every catalog these cases build. Their job is
 * the POOL, not a dear side: below `MIN_POOL_FOR_PRICE_PERCENTILE` priceable
 * text models the premium price leg has no threshold at all
 * (`packages/shared/src/affordability/money/premium.ts`), so a catalog holding only
 * the case's own fixtures disables that leg rather than firing it — and a
 * premium-by-price case would then read as basic. With the spread present the
 * threshold exists and sits above {@link CHEAP} and {@link DEAR}, which must
 * clear the price leg, and at or below {@link PREMIUM_BY_PRICE}, which must not.
 */
function priceSpread(): readonly ModelDescriptor[] {
  return [2000n, 3000n, 4000n].map((rate, index) =>
    model({ id: `trial/spread-${String(index)}`, pricing: pricing(rate, rate) })
  );
}

const CHEAP = model();
/** Priced under the quartile — eligible on every model leg — yet dear per token. */
const DEAR = model({ id: 'trial/dear', pricing: pricing(999n, 5n) });
/**
 * Combined rate at or above the spread's percentile, yet cheap enough that the
 * eligibility affordability leg clears it — so a `premium-required` on this
 * model can only be the PRICE leg, which is the leg the exposed catalog exists
 * to feed.
 */
const PREMIUM_BY_PRICE = model({ id: 'trial/premium-priced', pricing: pricing(9999n, 1n) });

function catalogWith(...targets: readonly ModelDescriptor[]): readonly ModelDescriptor[] {
  return [...targets, ...priceSpread()];
}

describe('the trial send gate answers a verdict, not a status', () => {
  it('allows a send whose model the exposed catalog does not carry', () => {
    // An unknown id resolves to no descriptor: the gate has nothing to judge and
    // the compile step refuses it as unknown.
    expect(trialGateVerdict(undefined, catalogWith(CHEAP), 400, NOW_MS)._unsafeUnwrap()).toBe(
      'allowed'
    );
  });

  it('allows an eligible cheap text model whose message prices under the cap', () => {
    expect(trialGateVerdict(CHEAP, catalogWith(CHEAP), 400, NOW_MS)._unsafeUnwrap()).toBe(
      'allowed'
    );
  });

  it('blocks a non-text model', () => {
    const image = model({ id: 'trial/image', outputs: ['image'] as Modality[] });
    expect(trialGateVerdict(image, catalogWith(CHEAP, image), 400, NOW_MS)._unsafeUnwrap()).toBe(
      'media-blocked'
    );
  });

  it('blocks a recently released model as premium', () => {
    const premium = model({
      id: 'trial/premium',
      releasedAt: secondsAt(NOW_MS),
    });
    expect(
      trialGateVerdict(premium, catalogWith(CHEAP, premium), 400, NOW_MS)._unsafeUnwrap()
    ).toBe('premium-required');
  });

  it('blocks a model the exposed catalog prices at or above the premium percentile', () => {
    // Discriminates the catalog argument: released long ago and affordable, so
    // neither the recency leg nor the eligibility affordability leg can reach
    // `premium-required`, leaving only the price leg the catalog feeds.
    expect(
      trialGateVerdict(
        PREMIUM_BY_PRICE,
        catalogWith(CHEAP, PREMIUM_BY_PRICE),
        400,
        NOW_MS
      )._unsafeUnwrap()
    ).toBe('premium-required');
  });

  it('admits the dear model on a short message, so the refusal below is the cost leg', () => {
    // The premise the DEAR cost cases rest on: this model clears every
    // eligibility leg, so its verdict at a longer prompt is the per-message cap's.
    expect(trialGateVerdict(DEAR, catalogWith(CHEAP, DEAR), 400, NOW_MS)._unsafeUnwrap()).toBe(
      'allowed'
    );
  });

  it('blocks a message the model prices above the per-message cap', () => {
    expect(trialGateVerdict(DEAR, catalogWith(CHEAP, DEAR), 37_500, NOW_MS)._unsafeUnwrap()).toBe(
      'too-expensive'
    );
  });

  it('allows a message the model prices at exactly the per-message cap', () => {
    // 30,000 characters is 10,000 input tokens at 999 nano-USD each, and the
    // 2,000-token answer at 5 each: 9,990,000 + 10,000 = 10,000,000 — the 1¢ cap
    // to the nano. The refusal is strictly above it.
    expect(trialGateVerdict(DEAR, catalogWith(CHEAP, DEAR), 30_000, NOW_MS)._unsafeUnwrap()).toBe(
      'allowed'
    );
  });

  it('carries a pricing failure out as the typed error rather than a verdict', () => {
    const failed = trialGateVerdict(CHEAP, catalogWith(CHEAP), -1, NOW_MS);
    expect(failed._unsafeUnwrapErr().code).toBe('validation');
  });
});
