import { describe, expect, it } from 'vitest';
import { buildTurnSystemPrompt, utcDayKey } from '@hushbox/shared';
import { inputTokensOf, priceableModelFrom } from '@hushbox/shared/affordability';
import { DAY_MS, OLD_RELEASE_SECONDS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import {
  perImagePricingFixture,
  perSecondPricingFixture,
  tokenPricingFixture,
} from '@hushbox/shared/pricing-fixture';
import {
  TRIAL_MESSAGE_COST_CAP_NANO_USD,
  isTextModel,
  premiumThresholdFor,
  trialEligibility,
  trialMessageReserveNanoUsd,
} from './trial-eligibility.js';
import type { Modality, ModelDescriptor } from '@hushbox/shared';

// A fixed reference clock; recency is evaluated against it, not the wall clock.
const NOW_MS = TEST_DAY_START;
// releasedAt 100 days back — inside the 182-day recency window.
const RECENT_RELEASE = secondsAt(NOW_MS - 100 * DAY_MS);

function pricing(inputPerToken: bigint, outputPerToken: bigint): ModelDescriptor['pricing'] {
  return tokenPricingFixture({ input: inputPerToken, output: outputPerToken });
}

function model(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'test/model',
    provider: 'test',
    version: '1',
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    parameters: {},
    behaviors: [],
    limits: { contextLength: 1_000_000 },
    pricing: pricing(1n, 1n),
    zdrReachable: true,
    releasedAt: OLD_RELEASE_SECONDS,
    fetchedAt: 0,
    ...overrides,
  };
}

/** A token-priced row's combined base rate. */
function combinedOf(entry: ModelDescriptor): bigint | undefined {
  if (entry.pricing.kind !== 'tokens') return undefined;
  return entry.pricing.anchor.base.input + entry.pricing.anchor.base.output;
}

/** A spread of cheap-to-expensive text models, target excluded, for the percentile. */
function priceSpread(prices: readonly bigint[]): ModelDescriptor[] {
  return prices.map((combined, index) =>
    // A rate is positive, so the output leg carries 1 of the combined price.
    model({ id: `spread/${String(index)}`, pricing: pricing(combined - 1n, 1n) })
  );
}

describe('TRIAL_MESSAGE_COST_CAP_NANO_USD', () => {
  it('caps a trial message at one cent', () => {
    // A repricing tripwire, not a restatement: moving the trial cap is a money
    // decision, and this is the assertion that makes it loud.
    expect(TRIAL_MESSAGE_COST_CAP_NANO_USD).toBe(10_000_000n);
  });
});

describe('isTextModel', () => {
  it('accepts a text-in text-out model', () => {
    expect(isTextModel(model({ inputs: ['text'], outputs: ['text'] }))).toBe(true);
  });

  it('accepts a multimodal-input text-out model (text plus image in, text out)', () => {
    expect(isTextModel(model({ inputs: ['text', 'image'] as Modality[], outputs: ['text'] }))).toBe(
      true
    );
  });

  it('rejects a multi-output model', () => {
    expect(isTextModel(model({ inputs: ['text'], outputs: ['text', 'image'] as Modality[] }))).toBe(
      false
    );
  });

  it('rejects a non-text single-output model', () => {
    expect(isTextModel(model({ inputs: ['text'], outputs: ['image'] as Modality[] }))).toBe(false);
  });
});

describe('trialEligibility', () => {
  it('blocks an image-output model as non-text', () => {
    const image = model({ outputs: ['image'] as Modality[] });
    expect(trialEligibility(image, [image], NOW_MS)).toEqual({
      eligible: false,
      reason: 'non-text',
    });
  });

  it('blocks a video-output model as non-text', () => {
    // Shaped as the catalog emits a video model: a per-second resolution matrix,
    // and no limits at all — no per-token rate and no context length.
    const video = model({
      outputs: ['video'] as Modality[],
      pricing: perSecondPricingFixture({
        anchor: { '720p': 57_500_000n },
        dearest: { '720p': 57_500_000n },
      }),
      limits: {},
    });
    expect(trialEligibility(video, [video], NOW_MS)).toEqual({
      eligible: false,
      reason: 'non-text',
    });
  });

  it('blocks a text-output model with no text input as non-text', () => {
    const imageInputOnly = model({ inputs: ['image'] as Modality[] });
    expect(trialEligibility(imageInputOnly, [imageInputOnly], NOW_MS)).toEqual({
      eligible: false,
      reason: 'non-text',
    });
  });

  it('blocks a text-plus-media-output model as non-text', () => {
    const textPlusImage = model({ outputs: ['text', 'image'] as Modality[] });
    expect(trialEligibility(textPlusImage, [textPlusImage], NOW_MS)).toEqual({
      eligible: false,
      reason: 'non-text',
    });
  });

  it('allows a multimodal-input, text-only-output model (text input present)', () => {
    const target = model({
      inputs: ['text', 'image'] as Modality[],
      pricing: pricing(1n, 1n),
      releasedAt: OLD_RELEASE_SECONDS,
    });
    const catalog = [target, ...priceSpread([1000n, 2000n, 3000n])];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({ eligible: true });
  });

  it('marks a top-quartile-priced text model premium', () => {
    // Spread combined prices 10,20,30 with the target at 100 (the top).
    const target = model({ id: 'test/expensive', pricing: pricing(99n, 1n) });
    const catalog = [...priceSpread([10n, 20n, 30n]), target];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({
      eligible: false,
      reason: 'premium',
    });
  });

  it('marks a recently released cheap text model premium', () => {
    const target = model({ pricing: pricing(1n, 1n), releasedAt: RECENT_RELEASE });
    // Sits alongside pricier models so the percentile leg does NOT fire — only recency.
    const catalog = [target, ...priceSpread([1000n, 2000n, 3000n])];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({
      eligible: false,
      reason: 'premium',
    });
  });

  it('marks a per-token-expensive text model premium via minimal-exchange affordability', () => {
    // The output rate drives a minimal exchange (2000 output tokens) past 1¢:
    // 334 × 1 + 2000 × 5999 = 11,998,334 nano > 10,000,000 cap.
    // The pool's 75th percentile is 9,000, above the target's combined 6,000, so
    // the price leg admits this model and only affordability refuses it.
    const target = model({ pricing: pricing(1n, 5999n) });
    const catalog = [target, ...priceSpread([7000n, 8000n, 9000n])];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({
      eligible: false,
      reason: 'premium',
    });
  });

  it('marks a cheap, old, below-quartile text model eligible', () => {
    const target = model({ pricing: pricing(1n, 1n), releasedAt: OLD_RELEASE_SECONDS });
    const catalog = [target, ...priceSpread([1000n, 2000n, 3000n])];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({ eligible: true });
  });

  it('refuses a text model with no per-token rates as premium (would error mid-send)', () => {
    // A per-image price names no token rate; pricing a token exchange requires
    // both, so the send would error — refuse at the gate as premium instead.
    const target = model({
      pricing: perImagePricingFixture({ anchor: 5n, dearest: 5n }),
      releasedAt: OLD_RELEASE_SECONDS,
    });
    const catalog = [target, ...priceSpread([1000n, 2000n, 3000n])];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({
      eligible: false,
      reason: 'premium',
    });
  });

  it('refuses a text model with no context length as premium', () => {
    // Both per-token rates are present, so the context length is the only half
    // of priceability this model fails — the rate legs cannot decide it.
    const target = model({ pricing: pricing(1n, 1n), limits: {}, releasedAt: OLD_RELEASE_SECONDS });
    const catalog = [target, ...priceSpread([1000n, 2000n, 3000n])];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({
      eligible: false,
      reason: 'premium',
    });
  });

  it('does not mark the sole text model premium via a degenerate small-sample percentile', () => {
    // A single-model catalog would otherwise price the model premium against
    // itself (floor(1 * 0.75) = index 0). The min-sample guard skips the leg.
    // The minimum is pinned in `packages/shared/src/affordability/money/premium.test.ts`,
    // which asserts its value and covers a pool one short of it; lowering it reds nothing here.
    const target = model({ pricing: pricing(1n, 1n), releasedAt: OLD_RELEASE_SECONDS });
    expect(trialEligibility(target, [target], NOW_MS)).toEqual({ eligible: true });
  });
});

describe('the premium price boundary over the exposed catalog', () => {
  // Neither half of the ranking is decided in this file: pool membership is
  // `priceableModelFrom` and the ranking is `premiumPriceThresholdNanoUsd`, both
  // from `@hushbox/shared/affordability`; the cases below reach them through
  // this gate's composition. What keeps the pool text is the pool's own
  // `isTextModel` filter — projectability does not, because a language-source
  // row keeps its per-token rates and its context length whatever its output
  // modality. The image-output case in this block is what pins that.
  it('marks the model at floor(len * 0.75) of the combined prices premium', () => {
    // Five members, not four: floor(n * 0.75) and ceil(n * 0.75) select the same
    // index whenever n is a multiple of four, so a four-member pool cannot tell the
    // two spellings apart. At five, floor picks index 3 (the 40 model) and ceil picks 4.
    const catalog = priceSpread([100n, 10n, 30n, 20n, 40n]);
    const atThreshold = catalog.find((entry) => combinedOf(entry) === 40n);
    const below = catalog.find((entry) => combinedOf(entry) === 30n);
    expect(trialEligibility(atThreshold!, catalog, NOW_MS)).toEqual({
      eligible: false,
      reason: 'premium',
    });
    expect(trialEligibility(below!, catalog, NOW_MS)).toEqual({ eligible: true });
  });

  it('counts each pool member’s output rate in the combined rate it ranks', () => {
    // Five models on one input rate, priced apart on output alone: combined
    // 11,20,30,40,50, so floor(5 × 0.75) puts the threshold at 40 and the target
    // — the member with the smallest output rate — sits at the bottom of the
    // pool. Read on input rates alone every member is identical, the target
    // becomes its own threshold, and a `>=` comparison calls it premium.
    const outputPriced = [1n, 10n, 20n, 30n, 40n].map((outputRate, index) =>
      model({ id: `output/${String(index)}`, pricing: pricing(10n, outputRate) })
    );
    const cheapest = outputPriced[0];
    expect(trialEligibility(cheapest!, outputPriced, NOW_MS)).toEqual({ eligible: true });
  });

  it('leaves an image-output model the money layer can price out of the distribution', () => {
    // The shape the pool's text filter exists for, and the reason projectability
    // cannot stand in for it: catalog normalization applies token pricing and
    // the context-length limit to every LANGUAGE-sourced row it admits, image
    // outputs included — so a text→image row carries per-token rates and a
    // context length, passes the exposure gate, and projects as priceable. The
    // first assertion is what makes the second one about the filter: the money
    // layer prices this row, so the filter is the only thing keeping it out of
    // the percentile.
    const textToImage = model({
      id: 'spread/text-to-image',
      outputs: ['image'] as Modality[],
      behaviors: [],
      pricing: pricing(299n, 1n),
    });
    expect(priceableModelFrom(textToImage)).toBeDefined();

    // Priced above the pool, so admitting it would carry the threshold from 40
    // up to 100 and stop pricing the 40-rate model premium. Sat mid-array,
    // where a member read by position rather than by price would be a
    // different one.
    const textPool = priceSpread([10n, 20n, 30n, 40n, 100n]);
    const mixed = [...textPool.slice(0, 3), textToImage, ...textPool.slice(3)];
    expect(premiumThresholdFor(mixed)).toBe(premiumThresholdFor(textPool));
  });
});

/**
 * The trial cap comparison is strict: a minimal exchange costing exactly the cap
 * is affordable, and the smallest excess past it is not. Every target here sits
 * below its pool's 75th percentile and is old, so the price and recency legs
 * admit it and the minimal-exchange leg alone decides each case.
 */
describe('the minimal-exchange affordability boundary', () => {
  /** Combined rates above the targets that use it, so the price leg admits them. */
  const ADMITTING_POOL = [7000n, 8000n, 9000n];

  it('admits a model whose minimal exchange costs exactly the cap', () => {
    // Stored at 800 / 3,866, held at their ceilings, 1,000 / 4,833: 334 input
    // tokens × 1,000 + 2,000 output tokens × 4,833 = 10,000,000 nano — the cap
    // itself.
    const target = model({ pricing: pricing(800n, 3866n) });
    expect(trialEligibility(target, [target, ...priceSpread(ADMITTING_POOL)], NOW_MS)).toEqual({
      eligible: true,
    });
  });

  it('admits a model that clears the cap only because a trial turn is charged no storage', () => {
    // Stored at 800 / 3,200, held at 1,000 / 4,000: 334 input tokens × 1,000 +
    // 2,000 output tokens × 4,000 = 8,334,000, comfortably inside the cap and
    // comfortably short of it under a strict comparison. What it is NOT inside
    // is the cap once those tokens carry storage: at 5 stored chars a token and
    // 300 nano a char they add 3,000,000 and the same exchange runs past
    // 10,000,000. So this case answers for the provider-only selection
    // specifically, which the case sitting exactly on the cap cannot — every
    // excess whatsoever reaches that one.
    const target = model({ pricing: pricing(800n, 3200n) });
    expect(trialEligibility(target, [target, ...priceSpread(ADMITTING_POOL)], NOW_MS)).toEqual({
      eligible: true,
    });
  });

  it('prices the minimal exchange over a 1,000-character prompt, not a longer one', () => {
    // The classification leg prices a fixed prompt, never the send's own. At 3
    // chars per token that is 334 input tokens, and the stored 3,600 / 3,200
    // are held at 4,500 / 4,000: 334 × 4,500 plus 2,000 × 4,000 = 9,503,000,
    // inside the cap. This model stays inside it for every basis through 1,332
    // characters and runs past it from 1,333, so the case bounds the basis from
    // ABOVE at 1,332 rather than pinning it at 1,000.
    const target = model({ pricing: pricing(3600n, 3200n) });
    const catalog = [target, ...priceSpread([8000n, 9000n, 10_000n])];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({ eligible: true });
  });

  it('prices the minimal exchange over a 1,000-character prompt, not a shorter one', () => {
    // The same fixed 334 input tokens, on a model they price past the cap, its
    // stored 4,800 / 3,200 held at 6,000 / 4,000: 334 × 6,000 plus 2,000 ×
    // 4,000 = 10,004,000. This model runs past the cap for every basis from
    // 1,000 characters up, so the case bounds the basis from BELOW at 1,000,
    // and the pair brackets it to [1,000, 1,332] rather than pinning it.
    // Sharper cases would not reach a pin: the leg reads the basis only as
    // `ceil(chars / 3)`, which prices 1,000, 1,001 and 1,002 characters as the
    // same 334 input tokens, so no model's verdict separates them and the
    // tightest bracket any pair of cases can prove is [1,000, 1,002].
    const target = model({ pricing: pricing(4800n, 3200n) });
    const catalog = [target, ...priceSpread([11_000n, 12_000n, 13_000n])];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({
      eligible: false,
      reason: 'premium',
    });
  });

  it('refuses a model one representable step past the cap', () => {
    // The exchange that costs exactly the cap, its stored input rate one nano
    // dearer: 801 is held at 1,002, two nano more per input token of the
    // classification prompt, the smallest excess over the cap one more stored
    // nano of input can add on this basis.
    const target = model({ pricing: pricing(801n, 3866n) });
    expect(trialEligibility(target, [target, ...priceSpread(ADMITTING_POOL)], NOW_MS)).toEqual({
      eligible: false,
      reason: 'premium',
    });
  });
});

/**
 * The adapter prices through the shared trial turn price, which reads a
 * non-persisting text curve (`persists: false`, `newMessageChars: 0`) at the
 * trial answer allocation. One neighbouring choice is an arithmetic identity
 * rather than an untested gap, which is why no case here pins it:
 * `newMessageChars` reaches only the input-storage term, and a non-persisting
 * curve carries no storage term at all. Pinned instead: that no storage is
 * priced, the answer allocation's token count, and a positive price.
 */
describe('trialMessageReserveNanoUsd', () => {
  it('prices the character count on the minimum basis (2000 output tokens), not the context window', () => {
    // 10 chars -> ceil(10 / 3) = 4 input tokens; 2,000 output tokens; both
    // rates held at 1,250, the ceiling of 1,000. 4 × 1,250 + 2,000 × 1,250 =
    // 2,505,000 — independent of the 1,000,000 context window.
    const target = model({ pricing: pricing(1000n, 1000n), limits: { contextLength: 1_000_000 } });
    expect(trialMessageReserveNanoUsd(target, 10)._unsafeUnwrap()).toBe(2_505_000n);
  });

  it('prices NO storage — a trial turn persists nothing', () => {
    // Priced at the smallest output rate, so the answer allocation adds only its
    // provider cost. A persisting price would add output storage over those
    // tokens and the framing allowance; the trial price is `persists: false`,
    // so neither appears. Input storage would stay zero even on a persisting
    // price, because the trial price passes `newMessageChars: 0`.
    const target = model({ pricing: pricing(1000n, 1n) });
    // 10 chars -> 4 input tokens × 1,250 nano, plus 2,000 output tokens × 2
    // nano, the ceilings of 1,000 and 1, and nothing else.
    expect(trialMessageReserveNanoUsd(target, 10)._unsafeUnwrap()).toBe(4n * 1250n + 2000n * 2n);
  });

  it('charges the output rate over exactly 2,000 tokens', () => {
    // A difference between two rates rather than a total: it cancels every term
    // that does not scale with the output rate (storage among them) and reads
    // only the token count the fixed output allocation prices. The output rates
    // 1,000 and 1,001 are held at 1,250 and 1,252, two nano apart.
    const base = model({ pricing: pricing(1000n, 1000n) });
    const oneNanoDearer = model({ pricing: pricing(1000n, 1001n) });
    expect(
      trialMessageReserveNanoUsd(oneNanoDearer, 10)._unsafeUnwrap() -
        trialMessageReserveNanoUsd(base, 10)._unsafeUnwrap()
    ).toBe(2000n * 2n);
  });

  it('exceeds the 1¢ cap for a long prompt on a mid-price model', () => {
    // 30,000 chars -> 10,000 input tokens; the stored 800 is held at 1,000:
    // 10,000,000 + 2,000,000 > cap.
    const target = model({ pricing: pricing(800n, 800n) });
    const result = trialMessageReserveNanoUsd(target, 30_000);
    expect(result.isOk() && result.value > TRIAL_MESSAGE_COST_CAP_NANO_USD).toBe(true);
  });

  it('stays within the 1¢ cap at the largest prompt a mid-price model can carry', () => {
    // 24,000 chars -> 8,000 input tokens; the stored 800 is held at 1,000:
    // 8,000,000 plus the 2,000,000 of output is the cap exactly. Sitting on the
    // boundary rather than well under it is what makes the comparison
    // discriminate — any term this gate does not price today, and any wider
    // basis, puts the same send over.
    const target = model({ pricing: pricing(800n, 800n) });
    const result = trialMessageReserveNanoUsd(target, 24_000);
    expect(result.isOk() && result.value <= TRIAL_MESSAGE_COST_CAP_NANO_USD).toBe(true);
  });

  it('derives input tokens from the shared input-token conversion', () => {
    const totalChars = 20;
    const expectedInputTokens = inputTokensOf(totalChars);
    // Both rates held at 1,250, the ceiling of 1,000.
    const providerBase = BigInt(expectedInputTokens) * 1250n + 2000n * 1250n;
    const target = model({ pricing: pricing(1000n, 1000n) });
    expect(trialMessageReserveNanoUsd(target, totalChars)._unsafeUnwrap()).toBe(providerBase);
  });

  it('surfaces a model without a token price as a validation error (never a silent price)', () => {
    // A per-image price has no token rates to price a trial turn with, so the
    // send cannot be priced and the trial gate refuses it rather than
    // under-charging.
    const target = model({ pricing: perImagePricingFixture({ anchor: 5n, dearest: 5n }) });
    const result = trialMessageReserveNanoUsd(target, 2);
    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error.code).toBe('validation');
    expect(result.isErr() && result.error.message).toBe('model pricing is not a token price');
  });

  it('never prices a rated model at zero', () => {
    // A zero total reads as a free send and clears the 1¢ cap for every model.
    const target = model({ pricing: pricing(1000n, 1000n) });
    expect(trialMessageReserveNanoUsd(target, 10)._unsafeUnwrap() > 0n).toBe(true);
  });

  // One case per half of the guard: a single case asserting both halves cannot
  // tell a dropped half from a dropped guard — every such mutation reds it alike.
  it('refuses a negative character count', () => {
    const target = model({ pricing: pricing(1000n, 1000n) });
    expect(trialMessageReserveNanoUsd(target, -1).isErr()).toBe(true);
  });

  it('refuses a fractional character count', () => {
    const target = model({ pricing: pricing(1000n, 1000n) });
    expect(trialMessageReserveNanoUsd(target, 1.5).isErr()).toBe(true);
  });
});

/**
 * The per-message gate must stay strictly stricter than the floor the compiled
 * trial turn prices, or an over-cap turn reaches the provider. Both now price the
 * same input — the whole send, system prompt included — and the gate allocates
 * 2,000 output tokens where the floor allocates 1,000, so the gate's surplus is
 * exactly 1,000 output tokens at the rate both hold the model's output at, the
 * ceiling of its stored rate.
 *
 * That is an identity, not a band: it is positive for EVERY rate shape, including
 * an inverted one (input dearer than output), which is the case a sweep over
 * realistic catalog shapes cannot see. The pair of pins below is what keeps the
 * two halves of that identity — no storage, whole-prompt basis — from being
 * separated later: the second measures what the gate would admit if the basis
 * narrowed back to history-plus-prompt.
 */
describe('the per-message gate dominates the compiled turn floor', () => {
  /** The system prompt the send carries — counted by BOTH sides now. */
  const SYSTEM_PROMPT_CHARS = buildTurnSystemPrompt({
    utcDay: utcDayKey(new Date(TEST_DAY_START)),
  }).length;
  const PROMPT_CHARS = 400;
  const SEND_CHARS = SYSTEM_PROMPT_CHARS + PROMPT_CHARS;

  /** The unstamped turn's own floor: the whole input the send carries, at a
   * minimum answer, provider-only — trial turns persist nothing — at the held
   * rates. */
  function compiledTurnFloorNanoUsd(held: {
    readonly input: bigint;
    readonly output: bigint;
  }): bigint {
    return BigInt(inputTokensOf(SEND_CHARS)) * held.input + 1000n * held.output;
  }

  /** The gate as the route calls it: the send's whole character count. */
  function gateNanoUsd(target: ModelDescriptor): bigint {
    return trialMessageReserveNanoUsd(target, SEND_CHARS)._unsafeUnwrap();
  }

  /** The gate on the narrower basis it used to price — the regression this pair
   * exists to catch, kept as a measurement rather than as a second gate. */
  function gateOnNarrowBasisNanoUsd(target: ModelDescriptor): bigint {
    return trialMessageReserveNanoUsd(target, PROMPT_CHARS)._unsafeUnwrap();
  }

  /** Each shape's stored rates, and the ceilings both sides hold them at. */
  const SHAPES: readonly {
    readonly label: string;
    readonly stored: { readonly input: bigint; readonly output: bigint };
    readonly held: { readonly input: bigint; readonly output: bigint };
  }[] = [
    {
      label: 'output far dearer',
      stored: { input: 100n, output: 400n },
      held: { input: 125n, output: 500n },
    },
    {
      label: 'output slightly dearer',
      stored: { input: 100n, output: 200n },
      held: { input: 125n, output: 250n },
    },
    { label: 'flat', stored: { input: 100n, output: 100n }, held: { input: 125n, output: 125n } },
    {
      label: 'input dearer',
      stored: { input: 400n, output: 100n },
      held: { input: 500n, output: 125n },
    },
    {
      label: 'input far dearer',
      stored: { input: 4000n, output: 100n },
      held: { input: 5000n, output: 125n },
    },
  ];

  it.each(SHAPES)(
    'clears the floor by exactly 1,000 output tokens on a $label shape',
    ({ stored, held }) => {
      const target = model({ pricing: pricing(stored.input, stored.output) });
      expect(gateNanoUsd(target) - compiledTurnFloorNanoUsd(held)).toBe(1000n * held.output);
    }
  );

  it('would admit an over-floor turn if the basis narrowed back to history-plus-prompt', () => {
    // 4,000 in / 100 out, held at 5,000 / 125: the system prompt's unpriced
    // input tokens outrun the extra 1,000 output tokens, so the narrow basis
    // lands BELOW the floor while the shipped basis stays above it. This is the
    // inverted shape the storage term used to hide.
    const inverted = model({ pricing: pricing(4000n, 100n) });
    const floor = compiledTurnFloorNanoUsd({ input: 5000n, output: 125n });
    expect(gateNanoUsd(inverted)).toBeGreaterThan(floor);
    expect(gateOnNarrowBasisNanoUsd(inverted)).toBeLessThan(floor);
    const unpricedInputTokens = BigInt(inputTokensOf(SEND_CHARS) - inputTokensOf(PROMPT_CHARS));
    expect(floor - gateOnNarrowBasisNanoUsd(inverted)).toBe(
      unpricedInputTokens * 5000n - 1000n * 125n
    );
  });
});
