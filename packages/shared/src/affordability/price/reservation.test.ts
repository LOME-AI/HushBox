import { describe, expect, it } from 'vitest';

import { perImagePricingFixture, tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import { toolLoopBound } from '../tool-loop.ts';
import { costAt, textCallCurve } from './curve.ts';
import {
  callCeilingRates,
  callInputUpperBoundTokens,
  costPartsAt,
  lineItemsAt,
  reservedCallFor,
  reservedStepRates,
} from './reservation.ts';
import type { ToolLoopBound } from '../tool-loop.ts';
import type { CallQuantities } from './curve.ts';
import type { ReservedCall } from './reservation.ts';

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

/** A reserved call at the curve's regime for `outputTokens`, with every other field fixed. */
function reservedCallAt(quantities: CallQuantities, outputTokens: number): ReservedCall {
  const curve = textCallCurve(tiered, 'reserve', quantities, outputTokens);
  const regime = curve.regimes.findLast((entry) => entry.fromOutputTokens <= outputTokens);
  if (regime === undefined) throw new Error('the curve has a regime from 0');
  return {
    nodeId: 'node',
    modelId: 'vendor/model',
    pricing: tiered,
    quantities,
    steps: quantities.loop?.steps ?? 1,
    wireCapTokens: outputTokens,
    stepTiers: regime.stepTiers,
    providerNanoUsd: costPartsAt(curve, outputTokens).providerNanoUsd,
    storageNanoUsd: costPartsAt(curve, outputTokens).storageNanoUsd,
    heldNanoUsd: costAt(curve, outputTokens),
  };
}

describe('reservedCallFor', () => {
  const oneStep = reservedCallAt({ promptTokens: 7, persists: false, newMessageChars: 0 }, 50);
  const looped = reservedCallAt({ promptTokens: 7, loop, persists: false, newMessageChars: 0 }, 50);

  it('picks the node’s call with the most steps', () => {
    const answer = { ...looped, nodeId: 'answer' };

    expect(reservedCallFor([{ ...oneStep, nodeId: 'answer' }, answer], 'answer')).toBe(answer);
  });

  it('picks the node’s answer call over its routing classifier reserved first', () => {
    const classifier: ReservedCall = {
      ...oneStep,
      nodeId: 'answer',
      modelId: 'classifier',
      routingClassifier: true,
    };
    const candidate = { ...oneStep, nodeId: 'answer', modelId: 'candidate' };

    expect(reservedCallFor([classifier, candidate], 'answer')).toBe(candidate);
  });

  it('finds no call for a node the hold reserved only a routing classifier for', () => {
    const classifier: ReservedCall = { ...oneStep, nodeId: 'answer', routingClassifier: true };

    expect(reservedCallFor([classifier], 'answer')).toBeUndefined();
  });

  it('keeps the first of calls with equally many steps', () => {
    const first = { ...oneStep, nodeId: 'answer', modelId: 'first' };
    const second = { ...oneStep, nodeId: 'answer', modelId: 'second' };

    expect(reservedCallFor([first, second], 'answer')).toBe(first);
  });

  it('picks among the node’s calls for the named model only', () => {
    const classifier = { ...oneStep, nodeId: 'answer', modelId: 'classifier' };
    const candidate = { ...looped, nodeId: 'answer', modelId: 'candidate' };

    expect(reservedCallFor([classifier, candidate], 'answer', 'classifier')).toBe(classifier);
  });

  it('finds no call for a node the hold reserved nothing for', () => {
    expect(reservedCallFor([{ ...oneStep, nodeId: 'other' }], 'answer')).toBeUndefined();
  });
});

describe('reservedStepRates', () => {
  it('reads each step’s ceiling at the tier its own input bound reached', () => {
    const call = reservedCallAt(
      { promptTokens: 500, loop, persists: false, newMessageChars: 0 },
      501
    );

    expect(reservedStepRates(call)).toEqual([
      { input: 13n, output: 125n },
      { input: 25n, output: 250n },
    ]);
  });

  it('reads no token rates for a media call', () => {
    const call = reservedCallAt({ promptTokens: 7, persists: false, newMessageChars: 0 }, 50);

    expect(
      reservedStepRates({
        ...call,
        pricing: perImagePricingFixture({ anchor: 40_000n, dearest: 90_000n }),
        wireCapTokens: 0,
        stepTiers: [],
      })
    ).toEqual([]);
  });

  it('reads one base ceiling for a single-step call below every tier', () => {
    const call = reservedCallAt({ promptTokens: 7, persists: false, newMessageChars: 0 }, 50);

    expect(reservedStepRates(call)).toEqual([{ input: 13n, output: 125n }]);
  });
});

describe('callInputUpperBoundTokens', () => {
  it('bounds a single-step call by its prompt bytes alone', () => {
    const call = reservedCallAt({ promptTokens: 7, persists: false, newMessageChars: 0 }, 50);

    expect(callInputUpperBoundTokens(call, 1234)).toBe(1234);
  });

  it('adds the loop’s re-sent output, results and overhead at its largest step', () => {
    const resent: ToolLoopBound = { ...loop, resultTokens: 40, overheadTokens: 9 };
    const call = reservedCallAt(
      { promptTokens: 7, loop: resent, persists: false, newMessageChars: 0 },
      600
    );

    // Step 1 re-sends the overhead only (1,009); step 2 re-sends step 1's 600
    // output tokens and one call's 40 result tokens (1,640).
    expect(callInputUpperBoundTokens(call, 1000)).toBe(1640);
  });

  it('counts the overhead a first step re-sends when it outweighs every later step', () => {
    const resent: ToolLoopBound = { ...loop, resultTokens: 0, overheadTokens: 900 };
    const call = reservedCallAt(
      { promptTokens: 7, loop: resent, persists: false, newMessageChars: 0 },
      10
    );

    expect(callInputUpperBoundTokens(call, 1000)).toBe(1900);
  });
});

describe('callCeilingRates', () => {
  /**
   * Sonnet 4.5's anchor, its own tier above 200,000 below its 1,000,000
   * context: ceilings 4,313 / 21,563 at base and 8,625 / 32,344 above.
   */
  const ownTier = tokenPricingFixture({
    input: 3450n,
    output: 17_250n,
    anchorContextTokens: 1_000_000,
    tiers: [{ abovePromptTokens: 200_000, input: 6900n, output: 25_875n }],
  });

  /**
   * GPT-5.4's anchor, 400,000 tokens of context, beside a 1,050,000-token
   * segment folded in above it: ceilings 288 / 1,798 at base and 7,188 /
   * 32,344 in the segment.
   */
  const segmented = tokenPricingFixture({
    input: 230n,
    output: 1438n,
    anchorContextTokens: 400_000,
    tiers: [{ abovePromptTokens: 400_000, input: 5750n, output: 25_875n }],
  });

  it('reserves the anchor’s own dearest tier for a short prompt', () => {
    expect(callCeilingRates(ownTier, 10)).toEqual({ input: 8625n, output: 32_344n });
  });

  it('reserves the anchor’s own dearest tier for a prompt past it', () => {
    expect(callCeilingRates(ownTier, 900_000)).toEqual({ input: 8625n, output: 32_344n });
  });

  it('leaves a segment out of a short prompt’s ceiling', () => {
    expect(callCeilingRates(segmented, 1000)).toEqual({ input: 288n, output: 1798n });
  });

  it('leaves a segment out of a prompt bounded at exactly the anchor’s context', () => {
    expect(callCeilingRates(segmented, 400_000)).toEqual({ input: 288n, output: 1798n });
  });

  it('reserves the segment for a prompt bounded past the anchor’s context', () => {
    expect(callCeilingRates(segmented, 400_001)).toEqual({ input: 7188n, output: 32_344n });
  });
});
