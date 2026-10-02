import { describe, expect, it } from 'vitest';
import { toolLoopBound } from '../tool-loop.ts';
import {
  estimateRunCeilingNanoUsd,
  mediaGenerationNanoUsd,
  outputTokensOf,
  reservedCallParts,
} from './run-ceiling.ts';
import {
  perImagePricingFixture,
  perSecondPricingFixture,
  tokenPricingFixture,
} from '../../testing/pricing-fixture.ts';

const TOKEN_PRICING = tokenPricingFixture({ input: 1n, output: 2n });

const IMAGE_PRICING = perImagePricingFixture({ anchor: 100n, dearest: 100n });

const VIDEO_PRICING = perSecondPricingFixture({
  anchor: { '720p': 10n },
  dearest: { '720p': 10n },
});

const CEILING = { maxFanOutWidth: 1, maxIterations: 1 } as const;

describe('outputTokensOf', () => {
  it('returns the output token count for a token usage', () => {
    expect(outputTokensOf({ kind: 'tokens', inputTokens: 10, outputTokens: 42 })).toBe(42n);
  });

  it('returns zero for a media usage (no token output leg)', () => {
    expect(outputTokensOf({ kind: 'media', rateKey: 'perImage', units: 1 })).toBe(0n);
  });
});

describe('reservedCallParts', () => {
  it('reserves a token call’s provider cost at its output ceiling', () => {
    const result = reservedCallParts(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 100, outputTokens: 50 },
      CEILING
    );
    expect(result.ok && result.value.providerNanoUsd).toBe(100n * 1n + 50n * 2n);
  });

  it('reserves no storage for a call with no storage context', () => {
    const result = reservedCallParts(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 100, outputTokens: 50 },
      CEILING
    );
    expect(result.ok && result.value.storageNanoUsd).toBe(0n);
  });

  it('fails closed on a non-integer token count', () => {
    const result = reservedCallParts(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 1.5, outputTokens: 50 },
      CEILING
    );
    expect(result.ok).toBe(false);
  });

  it('fails closed on a negative output token count', () => {
    const result = reservedCallParts(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 100, outputTokens: -1 },
      CEILING
    );
    expect(result.ok).toBe(false);
  });

  it('fails closed on a token call against a media price', () => {
    const result = reservedCallParts(
      IMAGE_PRICING,
      { kind: 'tokens', inputTokens: 100, outputTokens: 50 },
      CEILING
    );
    expect(result.ok).toBe(false);
  });

  it('reserves a media call’s generation cost', () => {
    const result = reservedCallParts(
      IMAGE_PRICING,
      { kind: 'media', rateKey: 'perImage', units: 1 },
      CEILING
    );
    expect(result.ok && result.value.providerNanoUsd).toBe(100n);
  });

  it('reserves a media call’s stored bytes when a storage context is present', () => {
    const result = reservedCallParts(
      IMAGE_PRICING,
      { kind: 'media', rateKey: 'perImage', units: 1 },
      CEILING,
      { mediaStorageBytes: 1000 }
    );
    expect(result.ok && result.value.storageNanoUsd > 0n).toBe(true);
  });

  it('fails closed on a negative stored byte count', () => {
    const result = reservedCallParts(
      IMAGE_PRICING,
      { kind: 'media', rateKey: 'perImage', units: 1 },
      CEILING,
      { mediaStorageBytes: -1 }
    );
    expect(result.ok).toBe(false);
  });

  it('fails closed on a media call against a token price', () => {
    const result = reservedCallParts(
      TOKEN_PRICING,
      { kind: 'media', rateKey: 'perImage', units: 1 },
      CEILING
    );
    expect(result.ok).toBe(false);
  });

  it('multiplies both parts by the declared width × iterations', () => {
    const result = reservedCallParts(
      IMAGE_PRICING,
      { kind: 'media', rateKey: 'perImage', units: 1 },
      { maxFanOutWidth: 2, maxIterations: 3 },
      { mediaStorageBytes: 1000 }
    );
    const single = reservedCallParts(
      IMAGE_PRICING,
      { kind: 'media', rateKey: 'perImage', units: 1 },
      CEILING,
      { mediaStorageBytes: 1000 }
    );
    expect(result.ok && single.ok && result.value.storageNanoUsd).toBe(
      single.ok ? single.value.storageNanoUsd * 6n : undefined
    );
  });
});

describe('mediaGenerationNanoUsd', () => {
  it('prices an image at its rate times its units', () => {
    const result = mediaGenerationNanoUsd(IMAGE_PRICING, 'reserve', {
      kind: 'media',
      rateKey: 'perImage',
      units: 2,
    });
    expect(result.ok && result.value).toBe(200n);
  });

  it('prices a video at its resolution’s rate times its seconds', () => {
    const result = mediaGenerationNanoUsd(VIDEO_PRICING, 'reserve', {
      kind: 'media',
      rateKey: 'perSecondByResolution',
      dimensionKey: '720p',
      units: 6,
    });
    expect(result.ok && result.value).toBe(60n);
  });

  it('prices an image at its anchor for an estimated charge and at its dearest to reserve', () => {
    const pricing = perImagePricingFixture({ anchor: 100n, dearest: 150n });
    const usage = { kind: 'media', rateKey: 'perImage', units: 1 } as const;
    const charged = mediaGenerationNanoUsd(pricing, 'estimatedCharge', usage);
    const reserved = mediaGenerationNanoUsd(pricing, 'reserve', usage);
    expect([charged.ok && charged.value, reserved.ok && reserved.value]).toEqual([100n, 150n]);
  });

  it('fails closed on a resolution the price does not state', () => {
    const result = mediaGenerationNanoUsd(VIDEO_PRICING, 'reserve', {
      kind: 'media',
      rateKey: 'perSecondByResolution',
      dimensionKey: '4k',
      units: 6,
    });
    expect(result.ok || result.error.code).toBe('model-pricing-incomplete');
  });

  it('fails closed on a per-second call that names no resolution', () => {
    const result = mediaGenerationNanoUsd(VIDEO_PRICING, 'reserve', {
      kind: 'media',
      rateKey: 'perSecondByResolution',
      units: 6,
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a dimension key on a per-image rate', () => {
    const result = mediaGenerationNanoUsd(IMAGE_PRICING, 'reserve', {
      kind: 'media',
      rateKey: 'perImage',
      dimensionKey: '1024x1024',
      units: 1,
    });
    expect(result.ok || result.error.code).toBe('invalid-request');
  });

  it('refuses a rate key the price does not charge by', () => {
    const result = mediaGenerationNanoUsd(VIDEO_PRICING, 'reserve', {
      kind: 'media',
      rateKey: 'perImage',
      units: 6,
    });
    expect(result.ok || result.error.code).toBe('model-pricing-incomplete');
  });

  it('fails closed on a unit count that is not a positive integer', () => {
    const result = mediaGenerationNanoUsd(IMAGE_PRICING, 'reserve', {
      kind: 'media',
      rateKey: 'perImage',
      units: 0,
    });
    expect(result.ok || result.error.code).toBe('invalid-request');
  });
});

describe('estimateRunCeilingNanoUsd', () => {
  it('prices a token ceiling at the billable provider cost across the declared worst case', () => {
    const result = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000 },
      CEILING
    );
    // billable provider cost = 1000×1 + 1000×2 = 3000; rates are already
    // fee-inclusive, so no fee math applies here.
    expect(result.ok && result.value).toBe(3000n);
  });

  it('multiplies the ceiling by the declared width × iterations', () => {
    const single = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000 },
      CEILING
    );
    const scaled = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000 },
      { maxFanOutWidth: 2, maxIterations: 3 }
    );
    expect(single.ok).toBe(true);
    expect(scaled.ok).toBe(true);
    if (single.ok && scaled.ok) {
      expect(scaled.value).toBe(single.value * 6n);
    }
  });

  it('rejects a zero ceiling (a zero admission hold is a caller bug)', () => {
    // A priceable call that sends and emits nothing reduces to 0 — the
    // amount-is-zero fail-closed arm.
    const result = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 0, outputTokens: 0 },
      CEILING
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a non-positive-integer ceiling dimension on the fail-closed channel', () => {
    const result = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000 },
      { maxFanOutWidth: 0, maxIterations: 1 }
    );
    expect(result.ok).toBe(false);
  });

  it('prices a tool-carrying call over every step of its loop, never a step multiplier', () => {
    const loop = toolLoopBound(['webSearch'], 2);
    const looped = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000, toolLoop: loop },
      CEILING
    );
    // Three steps: the prompt and the output on each, the model's own output
    // re-sent 3 × 2 / 2 times, 2 results re-sent on 2 later steps each, and the
    // tool-use overhead on the 2 tool-carrying steps, at 1 nano per input token
    // and 2 per output token; then the two call fees.
    const resultTokens = BigInt(loop.resultTokens);
    expect(looped.ok && looped.value).toBe(
      3n * 1000n * 1n +
        3n * 1000n * 2n +
        3n * 1000n * 1n +
        2n * 2n * resultTokens * 1n +
        2n * BigInt(loop.overheadTokens) * 1n +
        2n * loop.callFeeNano
    );
  });

  it('adds pass-through storage to the ceiling when a storage context is present', () => {
    const withoutStorage = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000 },
      CEILING
    );
    const withStorage = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000 },
      CEILING,
      { mediaStorageBytes: 0 }
    );
    expect(withStorage.ok && withoutStorage.ok && withStorage.value > withoutStorage.value).toBe(
      true
    );
  });
});
