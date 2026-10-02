import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@hushbox/shared';
import {
  perImagePricingFixture,
  perSecondPricingFixture,
  tokenPricingFixture,
} from '@hushbox/shared/pricing-fixture';
import {
  estimateRunCeilingNanoUsd,
  mediaCallUsageFor,
  priceMediaBillableNanoUsd,
  priceUsageBillableNanoUsd,
  reservedCallParts,
} from './estimate.js';
import type { Usage, ModelDescriptor } from '@hushbox/shared';
import type { CallUsage, DeclaredCeiling, ObservedTokenUsage } from './estimate.js';

const TOKEN_PRICING: ModelDescriptor['pricing'] = tokenPricingFixture({
  input: 2500n,
  output: 10_000n,
});

/**
 * {@link TOKEN_PRICING}'s ceiling, the rates a reserve holds: five quarters of
 * 2,500 / 10,000. Written out because the price core's `ceilingOf` sits behind
 * the money wall this file is not an owner of.
 */
const TOKEN_PRICING_AT_CEILING: ModelDescriptor['pricing'] = tokenPricingFixture({
  input: 3125n,
  output: 12_500n,
});

const TOKEN_USAGE: CallUsage = { kind: 'tokens', inputTokens: 1000, outputTokens: 200 };

const CEILING: DeclaredCeiling = { maxFanOutWidth: 3, maxIterations: 2 };

const ONE_CALL: DeclaredCeiling = { maxFanOutWidth: 1, maxIterations: 1 };

const IMAGE_PRICING: ModelDescriptor['pricing'] = perImagePricingFixture({
  anchor: 5_000_000n,
  dearest: 5_000_000n,
});

const VIDEO_PRICING: ModelDescriptor['pricing'] = perSecondPricingFixture({
  anchor: { '720p': 40_000_000n },
  dearest: { '720p': 40_000_000n },
});

describe('estimateRunCeilingNanoUsd — one call', () => {
  it('prices token usage from the billable catalog rates as a pure sum (no fee math)', () => {
    const result = estimateRunCeilingNanoUsd(TOKEN_PRICING, TOKEN_USAGE, ONE_CALL);

    // At the ceiling of 2,500 / 10,000: 1000 × 3125 + 200 × 12_500 = 5_625_000 —
    // rates are billable at ingestion, so the fold applies no further markup.
    expect(result._unsafeUnwrap()).toBe(5_625_000n);
  });

  it('prices media units from a per-image catalog rate', () => {
    const result = estimateRunCeilingNanoUsd(
      IMAGE_PRICING,
      { kind: 'media', rateKey: 'perImage', units: 8 },
      ONE_CALL
    );

    expect(result._unsafeUnwrap()).toBe(40_000_000n);
  });

  it('prices media units from a per-dimension pricing matrix', () => {
    const result = estimateRunCeilingNanoUsd(
      VIDEO_PRICING,
      { kind: 'media', rateKey: 'perSecondByResolution', dimensionKey: '720p', units: 2 },
      ONE_CALL
    );

    expect(result._unsafeUnwrap()).toBe(80_000_000n);
  });

  it('rejects token usage on a price with no per-token rate (never a silent zero)', () => {
    const result = estimateRunCeilingNanoUsd(IMAGE_PRICING, TOKEN_USAGE, ONE_CALL);

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(result._unsafeUnwrapErr().message).toBe('model pricing is not a token price');
  });

  it('rejects negative token counts', () => {
    const result = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: -1, outputTokens: 0 },
      ONE_CALL
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects fractional token counts', () => {
    const result = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 1.5, outputTokens: 0 },
      ONE_CALL
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a media rate key the price does not charge by', () => {
    const result = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'media', rateKey: 'perImage', units: 1 },
      ONE_CALL
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects the per-image key on a per-resolution price', () => {
    const result = estimateRunCeilingNanoUsd(
      VIDEO_PRICING,
      { kind: 'media', rateKey: 'perImage', units: 1 },
      ONE_CALL
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a matrix rate addressed without a dimension key', () => {
    const result = estimateRunCeilingNanoUsd(
      VIDEO_PRICING,
      { kind: 'media', rateKey: 'perSecondByResolution', units: 1 },
      ONE_CALL
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a dimension key absent from the pricing matrix', () => {
    const result = estimateRunCeilingNanoUsd(
      VIDEO_PRICING,
      { kind: 'media', rateKey: 'perSecondByResolution', dimensionKey: '512x512', units: 1 },
      ONE_CALL
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a dimension key addressed at a per-image rate', () => {
    const result = estimateRunCeilingNanoUsd(
      IMAGE_PRICING,
      { kind: 'media', rateKey: 'perImage', dimensionKey: '720p', units: 1 },
      ONE_CALL
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects non-positive media units', () => {
    const result = estimateRunCeilingNanoUsd(
      IMAGE_PRICING,
      { kind: 'media', rateKey: 'perImage', units: 0 },
      ONE_CALL
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('reservedCallParts', () => {
  it('splits a persisting token call into its provider and storage parts', () => {
    const parts = reservedCallParts(TOKEN_PRICING, TOKEN_USAGE, ONE_CALL, {
      mediaStorageBytes: 0,
    })._unsafeUnwrap();

    expect(parts.providerNanoUsd).toBe(5_625_000n);
    expect(parts.storageNanoUsd).toBeGreaterThan(0n);
  });

  it('reserves no storage for a call that does not persist', () => {
    const parts = reservedCallParts(TOKEN_PRICING, TOKEN_USAGE, ONE_CALL)._unsafeUnwrap();

    expect(parts.storageNanoUsd).toBe(0n);
  });

  it('surfaces the core pricing error on the domain channel', () => {
    const result = reservedCallParts(IMAGE_PRICING, TOKEN_USAGE, ONE_CALL);

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('estimateRunCeilingNanoUsd', () => {
  it('prices the declared ceiling: per-call billable cost times width and iterations', () => {
    const result = estimateRunCeilingNanoUsd(TOKEN_PRICING, TOKEN_USAGE, CEILING);

    // 5_625_000 billable per call at the rates' ceiling × 3 × 2 = 33_750_000 —
    // rates are already fee-inclusive, so the ceiling is a pure sum.
    expect(result._unsafeUnwrap()).toBe(33_750_000n);
  });

  it('rejects a non-positive ceiling dimension', () => {
    const result = estimateRunCeilingNanoUsd(TOKEN_PRICING, TOKEN_USAGE, {
      maxFanOutWidth: 0,
      maxIterations: 1,
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a fractional ceiling dimension', () => {
    const result = estimateRunCeilingNanoUsd(TOKEN_PRICING, TOKEN_USAGE, {
      maxFanOutWidth: 1.5,
      maxIterations: 1,
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects an all-zero usage ceiling instead of pricing a free admission', () => {
    const result = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 0, outputTokens: 0 },
      CEILING
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('surfaces the per-call pricing error unchanged', () => {
    const result = estimateRunCeilingNanoUsd(IMAGE_PRICING, TOKEN_USAGE, CEILING);

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('priceUsageBillableNanoUsd', () => {
  const USAGE: Usage = { inputTokens: 1000, outputTokens: 200 };

  function oneStep(usage: Usage): ObservedTokenUsage {
    return { kind: 'perStep', steps: [usage] };
  }

  /** Base 2,500 / 10,000 nano per token; 5,000 / 20,000 above 999 prompt tokens. */
  const TIERED = tokenPricingFixture({
    input: 2500n,
    output: 10_000n,
    tiers: [{ abovePromptTokens: 999, input: 5000n, output: 20_000n }],
  });

  it('prices each step at the tier its own input reached', () => {
    const observed: ObservedTokenUsage = {
      kind: 'perStep',
      steps: [
        { inputTokens: 600, outputTokens: 100 },
        { inputTokens: 1000, outputTokens: 100 },
      ],
    };

    // 600 × 2500 + 100 × 10000 at base, then 1000 × 5000 + 100 × 20000 at the tier.
    expect(priceUsageBillableNanoUsd(TIERED, observed)._unsafeUnwrap()).toBe(9_500_000n);
  });

  it('prices a call reported only as its sum at base rates, past every threshold', () => {
    const observed: ObservedTokenUsage = {
      kind: 'summed',
      usage: { inputTokens: 1600, outputTokens: 200 },
    };

    // 1600 × 2500 + 200 × 10000: the sum crosses 999, no step is known to have.
    expect(priceUsageBillableNanoUsd(TIERED, observed)._unsafeUnwrap()).toBe(6_000_000n);
  });

  it('rejects a negative count in any step', () => {
    const observed: ObservedTokenUsage = {
      kind: 'perStep',
      steps: [USAGE, { inputTokens: -1, outputTokens: 0 }],
    };

    expect(priceUsageBillableNanoUsd(TOKEN_PRICING, observed)._unsafeUnwrapErr().code).toBe(
      'validation'
    );
  });

  it('rejects a fractional count in a summed usage', () => {
    const observed: ObservedTokenUsage = {
      kind: 'summed',
      usage: { inputTokens: 1, outputTokens: 0.5 },
    };

    expect(priceUsageBillableNanoUsd(TOKEN_PRICING, observed)._unsafeUnwrapErr().code).toBe(
      'validation'
    );
  });

  it('prices observed usage at the billable catalog rates with no further fee', () => {
    const result = priceUsageBillableNanoUsd(TOKEN_PRICING, oneStep(USAGE));

    expect(result._unsafeUnwrap()).toBe(4_500_000n);
  });

  it('reserves one call at exactly the same token counts priced at the ceiling rates', () => {
    const fromCall = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      TOKEN_USAGE,
      ONE_CALL
    )._unsafeUnwrap();
    const atCeiling = priceUsageBillableNanoUsd(
      TOKEN_PRICING_AT_CEILING,
      oneStep(USAGE)
    )._unsafeUnwrap();

    expect(fromCall).toBe(atCeiling);
  });

  it('reserves one call at no less than the charge the same token counts are billed', () => {
    const charged = priceUsageBillableNanoUsd(TOKEN_PRICING, oneStep(USAGE))._unsafeUnwrap();
    const fromCall = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      TOKEN_USAGE,
      ONE_CALL
    )._unsafeUnwrap();

    expect(fromCall).toBeGreaterThanOrEqual(charged);
  });

  it('prices usage past a tier boundary at that tier, as an estimated charge', () => {
    const tiered = tokenPricingFixture({
      input: 2500n,
      output: 10_000n,
      tiers: [{ abovePromptTokens: 999, input: 5000n, output: 20_000n }],
    });

    // 1000 input tokens exceed the 999 boundary: 1000 × 5000 + 200 × 20000.
    expect(priceUsageBillableNanoUsd(tiered, oneStep(USAGE))._unsafeUnwrap()).toBe(9_000_000n);
  });

  it('prices usage exactly at a tier boundary at the rate below it', () => {
    const tiered = tokenPricingFixture({
      input: 2500n,
      output: 10_000n,
      tiers: [{ abovePromptTokens: 1000, input: 5000n, output: 20_000n }],
    });

    // 1000 input tokens do not exceed the 1000 boundary: 1000 × 2500 + 200 × 10000.
    expect(priceUsageBillableNanoUsd(tiered, oneStep(USAGE))._unsafeUnwrap()).toBe(4_500_000n);
  });

  it('rejects negative observed token counts', () => {
    const result = priceUsageBillableNanoUsd(
      TOKEN_PRICING,
      oneStep({ inputTokens: 0, outputTokens: -1 })
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects fractional observed input tokens', () => {
    const result = priceUsageBillableNanoUsd(
      TOKEN_PRICING,
      oneStep({ inputTokens: 0.5, outputTokens: 0 })
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('does not add reasoning tokens on top of the output leg (a subset already in outputTokens)', () => {
    const withReasoning = priceUsageBillableNanoUsd(
      TOKEN_PRICING,
      oneStep({ ...USAGE, reasoningTokens: 50 })
    );
    const withoutReasoning = priceUsageBillableNanoUsd(TOKEN_PRICING, oneStep(USAGE));

    // outputTokens (200) already includes the 50 reasoning tokens, so the
    // output leg prices at 200 × 10000, never 250 × — 1000 × 2500 + 200 × 10000.
    expect(withReasoning._unsafeUnwrap()).toBe(4_500_000n);
    // Reporting the reasoning breakdown must not change the price.
    expect(withReasoning._unsafeUnwrap()).toBe(withoutReasoning._unsafeUnwrap());
  });

  it('ignores cached input tokens (a subset already counted at the full input rate)', () => {
    const result = priceUsageBillableNanoUsd(
      TOKEN_PRICING,
      oneStep({ ...USAGE, cachedInputTokens: 400 })
    );

    expect(result._unsafeUnwrap()).toBe(4_500_000n);
  });

  it('surfaces a price with no per-token rate as a validation error', () => {
    const result = priceUsageBillableNanoUsd(IMAGE_PRICING, oneStep(USAGE));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(result._unsafeUnwrapErr().message).toBe('model pricing is not a token price');
  });
});

describe('mediaCallUsageFor', () => {
  it('prices an image call per output image, defaulting n to one', () => {
    expect(mediaCallUsageFor('image', {})._unsafeUnwrap()).toEqual({
      kind: 'media',
      rateKey: 'perImage',
      units: 1,
    });
  });

  it('accepts an explicit n of one as the single-artifact call', () => {
    expect(mediaCallUsageFor('image', { n: 1 })._unsafeUnwrap()).toEqual({
      kind: 'media',
      rateKey: 'perImage',
      units: 1,
    });
  });

  it('refuses a multi-image request (one generation call produces one artifact)', () => {
    const result = mediaCallUsageFor('image', { n: 3 });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(result._unsafeUnwrapErr().message).toContain("'n'");
  });

  it('rejects a non-positive image count', () => {
    expect(mediaCallUsageFor('image', { n: 0 })._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a fractional image count', () => {
    expect(mediaCallUsageFor('image', { n: 1.5 })._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a non-numeric image count', () => {
    expect(mediaCallUsageFor('image', { n: '2' })._unsafeUnwrapErr().code).toBe('validation');
  });

  it('prices a video call per second at the requested resolution', () => {
    expect(
      mediaCallUsageFor('video', { resolution: '720p', durationSeconds: 8 })._unsafeUnwrap()
    ).toEqual({
      kind: 'media',
      rateKey: 'perSecondByResolution',
      dimensionKey: '720p',
      units: 8,
    });
  });

  it('accepts a video call with an explicit n of one', () => {
    expect(
      mediaCallUsageFor('video', { resolution: '720p', durationSeconds: 8, n: 1 })._unsafeUnwrap()
    ).toEqual({
      kind: 'media',
      rateKey: 'perSecondByResolution',
      dimensionKey: '720p',
      units: 8,
    });
  });

  it('refuses a multi-video request (one generation call produces one artifact)', () => {
    const result = mediaCallUsageFor('video', { resolution: '720p', durationSeconds: 8, n: 2 });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(result._unsafeUnwrapErr().message).toContain("'n'");
  });

  it('rejects a video call without a resolution', () => {
    expect(mediaCallUsageFor('video', { durationSeconds: 8 })._unsafeUnwrapErr().code).toBe(
      'validation'
    );
  });

  it('rejects a video call with an empty resolution', () => {
    expect(
      mediaCallUsageFor('video', { resolution: '', durationSeconds: 8 })._unsafeUnwrapErr().code
    ).toBe('validation');
  });

  it('carries the UNSUPPORTED_RESOLUTION wire code on a missing resolution', () => {
    expect(mediaCallUsageFor('video', { durationSeconds: 8 })._unsafeUnwrapErr().wireCode).toBe(
      ERROR_CODES.UNSUPPORTED_RESOLUTION
    );
  });

  it('rejects a video call without a duration', () => {
    expect(mediaCallUsageFor('video', { resolution: '720p' })._unsafeUnwrapErr().code).toBe(
      'validation'
    );
  });

  it('carries the UNSUPPORTED_DURATION wire code on a missing duration', () => {
    expect(mediaCallUsageFor('video', { resolution: '720p' })._unsafeUnwrapErr().wireCode).toBe(
      ERROR_CODES.UNSUPPORTED_DURATION
    );
  });

  it('rejects a fractional video duration', () => {
    expect(
      mediaCallUsageFor('video', { resolution: '720p', durationSeconds: 2.5 })._unsafeUnwrapErr()
        .code
    ).toBe('validation');
  });

  it('rejects a non-media call-shape family', () => {
    expect(mediaCallUsageFor('language', {})._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects an unclassifiable (undefined) family', () => {
    expect(mediaCallUsageFor(undefined, {})._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('priceMediaBillableNanoUsd', () => {
  it('prices an image call at the flat per-image billable catalog rate, charged as-is', () => {
    const result = priceMediaBillableNanoUsd(
      perImagePricingFixture({ anchor: 40_000_000n, dearest: 40_000_000n }),
      'image',
      {}
    );

    expect(result._unsafeUnwrap()).toBe(40_000_000n);
  });

  it('refuses a multi-image call instead of pricing n artifacts', () => {
    const result = priceMediaBillableNanoUsd(
      perImagePricingFixture({ anchor: 40_000_000n, dearest: 40_000_000n }),
      'image',
      { n: 2 }
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('prices a video call from the per-resolution billable matrix', () => {
    const result = priceMediaBillableNanoUsd(
      perSecondPricingFixture({
        anchor: { '720p': 98_800_000n },
        dearest: { '720p': 98_800_000n },
      }),
      'video',
      { resolution: '720p', durationSeconds: 4 }
    );

    expect(result._unsafeUnwrap()).toBe(395_200_000n);
  });

  it('fails closed on a resolution absent from the pricing matrix', () => {
    const result = priceMediaBillableNanoUsd(
      perSecondPricingFixture({
        anchor: { '720p': 98_800_000n },
        dearest: { '720p': 98_800_000n },
      }),
      'video',
      { resolution: '4k', durationSeconds: 4 }
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails closed on an image call against a token price', () => {
    expect(priceMediaBillableNanoUsd(TOKEN_PRICING, 'image', {})._unsafeUnwrapErr().code).toBe(
      'validation'
    );
  });

  it("fails closed on the inherited-key resolution '__proto__' (never a throw)", () => {
    const result = priceMediaBillableNanoUsd(
      perSecondPricingFixture({
        anchor: { '720p': 98_800_000n },
        dearest: { '720p': 98_800_000n },
      }),
      'video',
      { resolution: '__proto__', durationSeconds: 4 }
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it("fails closed on the inherited-key resolution 'constructor' (never a throw)", () => {
    const result = priceMediaBillableNanoUsd(
      perSecondPricingFixture({
        anchor: { '720p': 98_800_000n },
        dearest: { '720p': 98_800_000n },
      }),
      'video',
      { resolution: 'constructor', durationSeconds: 4 }
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});
