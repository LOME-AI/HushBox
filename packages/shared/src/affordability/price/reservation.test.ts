import { describe, expect, it } from 'vitest';

import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import { toolLoopBound } from '../tool-loop.ts';
import { costAt, textCallCurve } from './curve.ts';
import { costPartsAt, lineItemsAt } from './reservation.ts';
import type { ToolLoopBound } from '../tool-loop.ts';

/**
 * A tier above 1,000 prompt tokens at twice the base rates. A reserve reads
 * their ceilings, five quarters rounded up: 13 / 125 at base, 25 / 250 above.
 */
const tiered = tokenPricingFixture({
  input: 10n,
  output: 100n,
  tiers: [{ abovePromptTokens: 1000, input: 20n, output: 200n }],
});

/** A two-step loop whose second step re-sends the first step's output: it crosses the tier at 501 output tokens. */
const loop: ToolLoopBound = {
  ...toolLoopBound(['webSearch'], 1),
  resultTokens: 0,
  overheadTokens: 0,
};

describe('lineItemsAt', () => {
  it('reads the regime below a tier crossing', () => {
    const curve = textCallCurve(
      tiered,
      'reserve',
      { promptTokens: 500, loop, persists: false, newMessageChars: 0 },
      2000
    );

    const input = lineItemsAt(curve, 500).find((item) => item.label === 'text-input-tokens');
    expect(input?.fixedNano).toBe(500n * 13n + 500n * 13n);
  });

  it('reads the regime past a tier crossing', () => {
    const curve = textCallCurve(
      tiered,
      'reserve',
      { promptTokens: 500, loop, persists: false, newMessageChars: 0 },
      2000
    );

    const input = lineItemsAt(curve, 501).find((item) => item.label === 'text-input-tokens');
    expect(input?.fixedNano).toBe(500n * 13n + 500n * 25n);
  });

  it('refuses an output count above the curve’s cap', () => {
    const curve = textCallCurve(
      tiered,
      'reserve',
      { promptTokens: 1, persists: false, newMessageChars: 0 },
      10
    );

    expect(() => lineItemsAt(curve, 11)).toThrow(RangeError);
  });
});

describe('costPartsAt', () => {
  it('splits a persisting call’s cost into its provider and storage parts', () => {
    const pricing = tokenPricingFixture({ input: 10n, output: 100n });
    const curve = textCallCurve(
      pricing,
      'reserve',
      { promptTokens: 7, persists: true, newMessageChars: 3 },
      50
    );

    const parts = costPartsAt(curve, 50);
    expect(parts.providerNanoUsd).toBe(7n * 13n + 50n * 125n);
    expect(parts.providerNanoUsd + parts.storageNanoUsd).toBe(costAt(curve, 50));
  });

  it('reserves no storage part for a call that does not persist', () => {
    const pricing = tokenPricingFixture({ input: 10n, output: 100n });
    const curve = textCallCurve(
      pricing,
      'reserve',
      { promptTokens: 7, persists: false, newMessageChars: 0 },
      50
    );

    expect(costPartsAt(curve, 50).storageNanoUsd).toBe(0n);
  });
});
