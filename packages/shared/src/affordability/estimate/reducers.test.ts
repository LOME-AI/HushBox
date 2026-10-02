import { describe, expect, it } from 'vitest';

import { MINIMUM_OUTPUT_TOKENS } from '../constants.ts';
import { affordability, evaluateManifest, manifestParts, reservationCeiling } from './reducers.ts';
import type { Manifest } from './types.ts';

// All rates are BILLABLE (fees baked at catalog ingestion) — the reducers are
// pure sums over provider and storage subtotals and never apply fee math.
const baseManifest: Manifest = {
  items: [
    { label: 'text-input-tokens', fixedNano: 500n, kind: 'provider' },
    { label: 'input-storage', fixedNano: 300_000n, kind: 'storage' },
    { label: 'text-output-tokens', variableOutputRateNano: 15n, kind: 'provider' },
    { label: 'output-storage', variableOutputRateNano: 1200n, kind: 'storage' },
  ],
};

describe('evaluateManifest', () => {
  it('folds only the provider line items under the provider-only scope', () => {
    // fixed = 500 (text-input); variable = 15 (text-output); storage excluded.
    expect(evaluateManifest(baseManifest, 1000n, { scope: 'provider-only' })).toBe(
      500n + 1000n * 15n
    );
  });

  it('folds every line item (storage included) under the all-in scope', () => {
    // fixed = 500 + 300000; variable = 15 + 1200.
    expect(evaluateManifest(baseManifest, 1000n, { scope: 'all-in' })).toBe(
      300_500n + 1000n * 1215n
    );
  });
});

describe('manifestParts', () => {
  it('splits a manifest into its fixed total and its per-output-token rate', () => {
    expect(manifestParts(baseManifest)).toEqual({
      fixedNano: 500n + 300_000n,
      variableRateNano: 15n + 1200n,
    });
  });

  it('prices every output count as the fixed total plus that many tokens at the rate', () => {
    const { fixedNano, variableRateNano } = manifestParts(baseManifest);
    for (const outputTokens of [0n, 1n, 1000n]) {
      expect(fixedNano + outputTokens * variableRateNano).toBe(
        evaluateManifest(baseManifest, outputTokens, { scope: 'all-in' })
      );
    }
  });
});

describe('evaluateManifest under the fixed-only scope', () => {
  const fixedManifest: Manifest = {
    items: [
      { label: 'media-generation', fixedNano: 500n, kind: 'provider' },
      { label: 'media-storage', fixedNano: 300_000n, kind: 'storage' },
    ],
  };

  it('refuses a line item priced per output token', () => {
    // Folding this manifest at zero output tokens through a tolerant scope
    // answers 500n — the 15n/token leg silently reads as free.
    expect(() => evaluateManifest(baseManifest, 0n, { scope: 'fixed-only' })).toThrow(
      /text-output-tokens/
    );
    expect(() => evaluateManifest(baseManifest, 0n, { scope: 'fixed-only' })).toThrow(RangeError);
  });

  it('sums the fixed legs of provider and storage items alike', () => {
    expect(evaluateManifest(fixedManifest, 0n, { scope: 'fixed-only' })).toBe(500n + 300_000n);
  });

  it('answers the same total at any output-token count', () => {
    expect(evaluateManifest(fixedManifest, 10_000n, { scope: 'fixed-only' })).toBe(
      evaluateManifest(fixedManifest, 0n, { scope: 'fixed-only' })
    );
  });

  it('accepts a declared zero per-output-token rate', () => {
    // A declared rate of 0n prices output at nothing, which is an answer, so it
    // folds like any fixed item. The two refused shapes are a NONZERO rate and
    // an item that declares no cost leg at all — never a merely absent rate.
    const manifest: Manifest = {
      items: [
        { label: 'free-output', fixedNano: 7n, variableOutputRateNano: 0n, kind: 'provider' },
      ],
    };
    expect(evaluateManifest(manifest, 99n, { scope: 'fixed-only' })).toBe(7n);
  });

  it('contributes nothing for an item whose only declared leg is a zero rate', () => {
    const manifest: Manifest = {
      items: [{ label: 'free-output', variableOutputRateNano: 0n, kind: 'provider' }],
    };
    expect(evaluateManifest(manifest, 99n, { scope: 'fixed-only' })).toBe(0n);
  });

  it('refuses an item that declares no cost leg at all', () => {
    const manifest: Manifest = { items: [{ label: 'media-storage', kind: 'storage' }] };
    expect(() => evaluateManifest(manifest, 0n, { scope: 'fixed-only' })).toThrow(RangeError);
  });
});

describe('reservationCeiling', () => {
  it('sums fixed + ceiling×variable across provider and storage items with no fee math', () => {
    const total = reservationCeiling(baseManifest, {
      outputTokenCeiling: 1000n,
      fanOutWidth: 1,
      maxIterations: 1,
    });
    // provider subtotal = 500 + 1000×15 = 15_500 (already billable)
    // storage subtotal = 300_000 + 1000×1200 = 1_500_000
    expect(total).toBe(15_500n + 1_500_000n);
  });

  it('multiplies the per-node ceiling by width × iterations', () => {
    const total = reservationCeiling(baseManifest, {
      outputTokenCeiling: 1000n,
      fanOutWidth: 2,
      maxIterations: 3,
    });
    expect(total).toBe((15_500n + 1_500_000n) * 6n);
  });

  it('reserves at least the all-in bill for every output count up to the ceiling', () => {
    // The over-reserve invariant: the reservation is ≥ what settlement could
    // charge for the same manifest at any actual output ≤ the declared ceiling
    // (settlement charges billable amounts; the manifest is already billable).
    const ceiling = 1000n;
    const reserved = reservationCeiling(baseManifest, {
      outputTokenCeiling: ceiling,
      fanOutWidth: 1,
      maxIterations: 1,
    });
    for (const actualOutput of [0n, 1n, 500n, 999n, ceiling]) {
      const billable = evaluateManifest(baseManifest, actualOutput, { scope: 'all-in' });
      expect(reserved >= billable).toBe(true);
    }
  });

  it('rejects a non-positive or non-integer multiplier', () => {
    const ceiling = { outputTokenCeiling: 1000n, fanOutWidth: 1, maxIterations: 1 };
    expect(() => reservationCeiling(baseManifest, { ...ceiling, fanOutWidth: 0 })).toThrow(
      RangeError
    );
    expect(() => reservationCeiling(baseManifest, { ...ceiling, fanOutWidth: 1.5 })).toThrow(
      RangeError
    );
    expect(() => reservationCeiling(baseManifest, { ...ceiling, maxIterations: -1 })).toThrow(
      RangeError
    );
  });

  it('rejects a negative output-token ceiling', () => {
    expect(() =>
      reservationCeiling(baseManifest, {
        outputTokenCeiling: -1n,
        fanOutWidth: 1,
        maxIterations: 1,
      })
    ).toThrow(RangeError);
  });
});

describe('affordability', () => {
  // totalFixed = 500 + 300000 = 300500
  // effectiveVarRate = 15 + 1200 = 1215
  // minCost = 300500 + 1000×1215 = 1_515_500
  const minCost = 300_500n + BigInt(MINIMUM_OUTPUT_TOKENS) * 1215n;

  it('reports the minimum cost gated on MINIMUM_OUTPUT_TOKENS', () => {
    const result = affordability(baseManifest, 0n);
    expect(result.minCostNano).toBe(minCost);
  });

  it('can send at exactly the minimum cost, yielding MINIMUM_OUTPUT_TOKENS', () => {
    const result = affordability(baseManifest, minCost);
    expect(result.canSend).toBe(true);
    expect(result.maxOutputTokens).toBe(BigInt(MINIMUM_OUTPUT_TOKENS));
    expect(result.denialReason).toBeUndefined();
  });

  it('denies one nano below the minimum cost', () => {
    const result = affordability(baseManifest, minCost - 1n);
    expect(result.canSend).toBe(false);
    expect(result.maxOutputTokens).toBe(0n);
    expect(result.denialReason).toBe('insufficient_balance');
  });

  it('solves max output tokens as floor((balance − fixed)/variableRate)', () => {
    const balance = 300_500n + 5000n * 1215n;
    const result = affordability(baseManifest, balance);
    expect(result.maxOutputTokens).toBe(5000n);
  });

  it('floors a partial token that the balance cannot fully cover', () => {
    // 4999 tokens' worth + a fractional remainder that must floor down.
    const balance = 300_500n + 5000n * 1215n - 1n;
    const result = affordability(baseManifest, balance);
    expect(result.maxOutputTokens).toBe(4999n);
  });

  it('denies a zero balance', () => {
    const result = affordability(baseManifest, 0n);
    expect(result.canSend).toBe(false);
    expect(result.maxOutputTokens).toBe(0n);
    expect(result.denialReason).toBe('insufficient_balance');
  });

  it('denies a negative balance', () => {
    const result = affordability(baseManifest, -1_000_000n);
    expect(result.canSend).toBe(false);
    expect(result.maxOutputTokens).toBe(0n);
  });

  it('fails closed on a manifest with no variable output rate', () => {
    const manifest: Manifest = {
      items: [{ label: 'text-input-tokens', fixedNano: 500n, kind: 'provider' }],
    };
    expect(() => affordability(manifest, 1_000_000n)).toThrow(RangeError);
  });
});
