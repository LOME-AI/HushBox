import { describe, expect, it } from 'vitest';

import { nanoUSD } from '../money/nano-usd.ts';
import { perImagePricingFixture, tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import { toolLoopBound } from '../tool-loop.ts';
import { costAt, mediaCallCurve, priceSteps, textCallCurve, tiersAt } from './curve.ts';
import { billedNanoUsd, holdOverrunLegs, parseChargeKey } from './hold-overrun.ts';
import { costPartsAt } from './reservation.ts';
import type { ToolLoopBound } from '../tool-loop.ts';
import type { CallQuantities, StepTokens } from './curve.ts';
import type { BilledCharge } from './hold-overrun.ts';
import type { ReservedCall, RunReservation } from './reservation.ts';

/**
 * A tier above 100 prompt tokens at twice the base input rate. A reserve reads
 * the ceilings, five quarters rounded up: 13 / 25 at base, 25 / 38 above.
 */
const tiered = tokenPricingFixture({
  input: 10n,
  output: 20n,
  tiers: [{ abovePromptTokens: 100, input: 20n, output: 30n }],
});

/** A two-step loop whose second step re-sends the first step's output and nothing else. */
const twoStepLoop: ToolLoopBound = {
  ...toolLoopBound(['webSearch'], 1),
  resultTokens: 0,
  overheadTokens: 0,
};

/** A text call reserved through the core, exactly as the estimator reserves one. */
function reservedTextCall(
  nodeId: string,
  quantities: CallQuantities,
  wireCapTokens: number
): ReservedCall {
  const curve = textCallCurve(tiered, 'reserve', quantities, wireCapTokens);
  const parts = costPartsAt(curve, wireCapTokens);
  return {
    nodeId,
    modelId: 'text-model',
    pricing: tiered,
    quantities,
    steps: quantities.loop?.steps ?? 1,
    wireCapTokens,
    stepTiers: tiersAt(curve, wireCapTokens),
    ...parts,
    heldNanoUsd: costAt(curve, wireCapTokens),
  };
}

/** A 50-token prompt, one step, a 10-token cap: base tier, input bound 50. */
const ANSWER = reservedTextCall(
  'answer',
  { promptTokens: 50, persists: false, newMessageChars: 0 },
  10
);

/**
 * A run reserving `calls`. The total defaults far above any bill here, so a
 * case about one leg is not also a bill above its hold; the `unattributed`
 * cases name the total they mean.
 */
function reservationOf(calls: readonly ReservedCall[], totalNanoUsd = 1_000_000n): RunReservation {
  return { totalNanoUsd: nanoUSD(totalNanoUsd), calls };
}

/** A non-estimated text charge billed at exactly the ceiling of what it observed. */
function textCharge(steps: readonly StepTokens[], extra: Partial<BilledCharge> = {}): BilledCharge {
  return {
    key: 'answer',
    modelId: 'text-model',
    billableCostNanoUsd: priceSteps(tiered, 'reserve', steps).nanoUsd,
    isEstimated: false,
    observed: { stepUsages: steps, toolFeeNanoUsd: 0n },
    ...extra,
  };
}

describe('holdOverrunLegs — input-above-estimate', () => {
  it('names a step whose observed input passes its reserved input bound', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER]), [
      textCharge([{ inputTokens: 51, outputTokens: 10 }]),
    ]);

    expect(legs).toEqual(['input-above-estimate']);
  });

  it('names nothing for a step whose observed input equals its bound', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER]), [
      textCharge([{ inputTokens: 50, outputTokens: 10 }]),
    ]);

    expect(legs).toEqual([]);
  });

  it('measures each step against that step’s own bound', () => {
    // Step 2's bound re-sends step 1's capped output: 50 + 10 = 60.
    const looped = reservedTextCall(
      'answer',
      { promptTokens: 50, loop: twoStepLoop, persists: false, newMessageChars: 0 },
      10
    );

    const within = holdOverrunLegs(reservationOf([looped]), [
      textCharge([
        { inputTokens: 50, outputTokens: 10 },
        { inputTokens: 60, outputTokens: 10 },
      ]),
    ]);
    const past = holdOverrunLegs(reservationOf([looped]), [
      textCharge([
        { inputTokens: 50, outputTokens: 10 },
        { inputTokens: 61, outputTokens: 10 },
      ]),
    ]);

    expect(within).toEqual([]);
    expect(past).toEqual(['input-above-estimate']);
  });
});

describe('holdOverrunLegs — tier-crossed', () => {
  it('names a step whose observed input resolves a tier above the one it was reserved at', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER]), [
      textCharge([{ inputTokens: 101, outputTokens: 10 }]),
    ]);

    expect(legs).toEqual(['input-above-estimate', 'tier-crossed']);
  });

  it('stays silent for a step past its bound but inside its reserved tier', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER]), [
      textCharge([{ inputTokens: 100, outputTokens: 10 }]),
    ]);

    expect(legs).not.toContain('tier-crossed');
  });
});

describe('holdOverrunLegs — output-above-wire-cap', () => {
  it('names a step whose observed output passes the wire cap', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER]), [
      textCharge([{ inputTokens: 50, outputTokens: 11 }]),
    ]);

    expect(legs).toEqual(['output-above-wire-cap']);
  });
});

describe('holdOverrunLegs — rate-above-ceiling', () => {
  const STEPS = [{ inputTokens: 50, outputTokens: 10 }] as const;
  const CEILING = priceSteps(tiered, 'reserve', STEPS).nanoUsd;

  it('names a provider amount above the observed usage priced at the ceiling', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER]), [
      textCharge(STEPS, { billableCostNanoUsd: CEILING + 1n }),
    ]);

    expect(legs).toEqual(['rate-above-ceiling']);
  });

  it('leaves the tool fees out of the provider amount', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER]), [
      textCharge(STEPS, {
        billableCostNanoUsd: CEILING + 7n,
        observed: { stepUsages: STEPS, toolFeeNanoUsd: 7n },
      }),
    ]);

    expect(legs).toEqual([]);
  });

  it('stays silent on an estimated charge', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER]), [
      textCharge(STEPS, { billableCostNanoUsd: CEILING + 1n, isEstimated: true }),
    ]);

    expect(legs).toEqual([]);
  });

  it('stays silent on a charge that observed no per-step usage', () => {
    const unobserved: BilledCharge = {
      key: 'answer',
      modelId: 'text-model',
      billableCostNanoUsd: CEILING + 1n,
      isEstimated: false,
    };

    expect(holdOverrunLegs(reservationOf([ANSWER]), [unobserved])).toEqual([]);
  });

  it('prices each step at its own tier, so a loop step past a tier billed at that tier’s ceiling stays silent', () => {
    // Step 2 re-sends step 1's 60-token output: 50 + 60 = 110 crosses the tier,
    // and the reserve held it there.
    const looped = reservedTextCall(
      'answer',
      { promptTokens: 50, loop: twoStepLoop, persists: false, newMessageChars: 0 },
      60
    );
    const steps = [
      { inputTokens: 50, outputTokens: 60 },
      { inputTokens: 110, outputTokens: 60 },
    ];

    const legs = holdOverrunLegs(reservationOf([looped]), [textCharge(steps)]);

    expect(looped.stepTiers).toEqual([0, 1]);
    expect(legs).toEqual([]);
  });

  it('names a loop step billed above its own tier’s ceiling', () => {
    const looped = reservedTextCall(
      'answer',
      { promptTokens: 50, loop: twoStepLoop, persists: false, newMessageChars: 0 },
      60
    );
    const steps = [
      { inputTokens: 50, outputTokens: 60 },
      { inputTokens: 110, outputTokens: 60 },
    ];
    const atTier = priceSteps(tiered, 'reserve', steps).nanoUsd;

    const legs = holdOverrunLegs(reservationOf([looped]), [
      textCharge(steps, { billableCostNanoUsd: atTier + 1n }),
    ]);

    expect(legs).toEqual(['rate-above-ceiling']);
  });

  describe('for media', () => {
    const image = perImagePricingFixture({ anchor: 40n, dearest: 50n });
    const IMAGE: ReservedCall = {
      nodeId: 'image',
      modelId: 'image-model',
      pricing: image,
      quantities: { promptTokens: 0, persists: false, newMessageChars: 0 },
      steps: 1,
      wireCapTokens: 0,
      stepTiers: [],
      providerNanoUsd: costAt(mediaCallCurve(image, 'reserve', { images: 2 }), 0),
      storageNanoUsd: nanoUSD(0n),
      heldNanoUsd: costAt(mediaCallCurve(image, 'reserve', { images: 2 }), 0),
    };
    const imageCharge = (billable: bigint): BilledCharge => ({
      key: 'image',
      modelId: 'image-model',
      billableCostNanoUsd: billable,
      isEstimated: false,
    });

    it('names a provider amount above the reserved provider amount', () => {
      expect(holdOverrunLegs(reservationOf([IMAGE]), [imageCharge(101n)])).toEqual([
        'rate-above-ceiling',
      ]);
    });

    it('stays silent at the reserved provider amount', () => {
      expect(holdOverrunLegs(reservationOf([IMAGE]), [imageCharge(100n)])).toEqual([]);
    });
  });
});

describe('holdOverrunLegs — storage-above-allowance', () => {
  const STORED = reservedTextCall(
    'answer',
    { promptTokens: 50, persists: true, newMessageChars: 10 },
    10
  );
  const STEPS = [{ inputTokens: 50, outputTokens: 10 }] as const;

  it('names a run whose storage fees pass the storage it reserved', () => {
    const legs = holdOverrunLegs(reservationOf([STORED]), [
      textCharge(STEPS, { storageFeeNanoUsd: STORED.storageNanoUsd + 1n }),
    ]);

    expect(legs).toEqual(['storage-above-allowance']);
  });

  it('stays silent at the storage it reserved', () => {
    const legs = holdOverrunLegs(reservationOf([STORED]), [
      textCharge(STEPS, { storageFeeNanoUsd: STORED.storageNanoUsd }),
    ]);

    expect(legs).toEqual([]);
  });

  it('compares across the whole run, so a call whose own reservation carries no storage stays silent', () => {
    // The run's storage rides its first persisting call; a later sibling reserves none.
    const sibling: ReservedCall = { ...STORED, nodeId: 'sibling', storageNanoUsd: nanoUSD(0n) };
    const half = STORED.storageNanoUsd / 2n;

    const legs = holdOverrunLegs(reservationOf([STORED, sibling]), [
      textCharge(STEPS, { storageFeeNanoUsd: half }),
      textCharge(STEPS, { key: 'sibling', storageFeeNanoUsd: half }),
    ]);

    expect(legs).toEqual([]);
  });

  it('sums the storage every call of the run reserved', () => {
    // Two persisting siblings each reserve their own output storage.
    const sibling: ReservedCall = { ...STORED, nodeId: 'sibling' };
    const run = reservationOf([STORED, sibling]);
    const both = 2n * STORED.storageNanoUsd;

    const within = holdOverrunLegs(run, [
      textCharge(STEPS, { storageFeeNanoUsd: both - 1n }),
      textCharge(STEPS, { key: 'sibling', storageFeeNanoUsd: 1n }),
    ]);
    const past = holdOverrunLegs(run, [
      textCharge(STEPS, { storageFeeNanoUsd: both }),
      textCharge(STEPS, { key: 'sibling', storageFeeNanoUsd: 1n }),
    ]);

    expect(within).toEqual([]);
    expect(past).toEqual(['storage-above-allowance']);
  });

  it('reads the total as the reserved storage when the run reserved no call', () => {
    const inputOnly: RunReservation = { totalNanoUsd: nanoUSD(26_400n), calls: [] };
    const charge = (fee: bigint): BilledCharge => ({
      key: 'answer',
      modelId: 'text-model',
      billableCostNanoUsd: 0n,
      isEstimated: false,
      storageFeeNanoUsd: fee,
    });

    expect(holdOverrunLegs(inputOnly, [charge(26_400n)])).toEqual([]);
    expect(holdOverrunLegs(inputOnly, [charge(26_401n)])).toEqual(['storage-above-allowance']);
  });
});

describe('holdOverrunLegs — unattributed', () => {
  it('names a bill above its hold that no other leg explains', () => {
    // The charge names no reserved call, so no per-call leg can read it.
    const stranger = textCharge([{ inputTokens: 50, outputTokens: 10 }], {
      key: 'elsewhere',
      billableCostNanoUsd: ANSWER.heldNanoUsd + 1n,
    });

    expect(holdOverrunLegs(reservationOf([ANSWER], ANSWER.heldNanoUsd), [stranger])).toEqual([
      'unattributed',
    ]);
  });

  it('stays silent on a bill at its hold', () => {
    const stranger = textCharge([{ inputTokens: 50, outputTokens: 10 }], {
      key: 'elsewhere',
      billableCostNanoUsd: ANSWER.heldNanoUsd,
    });

    expect(holdOverrunLegs(reservationOf([ANSWER], ANSWER.heldNanoUsd), [stranger])).toEqual([]);
  });

  it('is left out when another leg names the overrun', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER], ANSWER.heldNanoUsd), [
      textCharge([{ inputTokens: 50, outputTokens: 11 }], {
        billableCostNanoUsd: ANSWER.heldNanoUsd + 1n,
      }),
    ]);

    expect(legs).toEqual(['output-above-wire-cap']);
  });
});

describe('holdOverrunLegs — reading a charge against its call', () => {
  it('reads a fan-out branch’s charge against its node’s call', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER]), [
      textCharge([{ inputTokens: 51, outputTokens: 10 }], { key: 'answer#1' }),
    ]);

    expect(legs).toEqual(['input-above-estimate']);
  });

  it('refuses a reserved call that lacks a tier for one of its steps', () => {
    expect(() =>
      holdOverrunLegs(reservationOf([{ ...ANSWER, stepTiers: [] }]), [
        textCharge([{ inputTokens: 50, outputTokens: 10 }]),
      ])
    ).toThrow(RangeError);
  });

  it('reads a charge against the node’s call with the most steps when several match', () => {
    const looped = reservedTextCall(
      'answer',
      { promptTokens: 50, loop: twoStepLoop, persists: false, newMessageChars: 0 },
      10
    );
    // Step 2 sends 60, inside the looped call's step-2 bound and past the
    // one-step call's only bound.
    const steps = [
      { inputTokens: 50, outputTokens: 10 },
      { inputTokens: 60, outputTokens: 10 },
    ];

    expect(holdOverrunLegs(reservationOf([ANSWER, looped]), [textCharge(steps)])).toEqual([]);
    expect(holdOverrunLegs(reservationOf([looped, ANSWER]), [textCharge(steps)])).toEqual([]);
  });

  it('reads an unreserved model’s charge against the node’s call with the most steps', () => {
    const looped = reservedTextCall(
      'answer',
      { promptTokens: 50, loop: twoStepLoop, persists: false, newMessageChars: 0 },
      10
    );
    // A one-step call reserved first; step 2 sends 60, inside the looped call's
    // step-2 bound and past the one-step call's only bound.
    const steps = [
      { inputTokens: 50, outputTokens: 10 },
      { inputTokens: 60, outputTokens: 10 },
    ];

    const legs = holdOverrunLegs(reservationOf([ANSWER, looped]), [
      textCharge(steps, { modelId: 'cheaper-model' }),
    ]);

    expect(legs).toEqual([]);
  });

  it('reads a step past the reserved count against the last reserved step', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER]), [
      textCharge([
        { inputTokens: 50, outputTokens: 10 },
        { inputTokens: 51, outputTokens: 10 },
      ]),
    ]);

    expect(legs).toEqual(['input-above-estimate']);
  });

  it('lists several legs once each, sorted', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER]), [
      textCharge([{ inputTokens: 101, outputTokens: 11 }]),
      textCharge([{ inputTokens: 101, outputTokens: 11 }], { key: 'answer#1' }),
    ]);

    expect(legs).toEqual(['input-above-estimate', 'output-above-wire-cap', 'tier-crossed']);
  });
});

describe('holdOverrunLegs — a long-context reply above its hold', () => {
  /** Sonnet 4.5's anchor: dearer rates once a request passes 200,000 prompt tokens. */
  const sonnet = tokenPricingFixture({
    input: 3450n,
    output: 17_250n,
    tiers: [{ abovePromptTokens: 200_000, input: 6900n, output: 25_875n }],
  });
  const OBSERVED = [{ inputTokens: 205_000, outputTokens: 64_000 }] as const;

  it('prices the observed step at its tier’s ceiling: 3,838,141,000 nano', () => {
    // 205,000 × 8,625 + 64,000 × 32,344: five quarters of 6,900 / 25,875 rounded up.
    expect(priceSteps(sonnet, 'reserve', OBSERVED).nanoUsd).toBe(3_838_141_000n);
  });

  it('names the input estimate and the crossed tier, and not the rate, for $2.67 of inline cost billed at 3,070,500,000 nano', () => {
    const quantities = { promptTokens: 190_000, persists: true, newMessageChars: 88 };
    const curve = textCallCurve(sonnet, 'reserve', quantities, 64_000);
    const call: ReservedCall = {
      nodeId: 'answer',
      modelId: 'sonnet',
      pricing: sonnet,
      quantities,
      steps: 1,
      wireCapTokens: 64_000,
      stepTiers: tiersAt(curve, 64_000),
      ...costPartsAt(curve, 64_000),
      heldNanoUsd: costAt(curve, 64_000),
    };

    const legs = holdOverrunLegs(reservationOf([call], call.heldNanoUsd), [
      {
        key: 'answer',
        modelId: 'sonnet',
        billableCostNanoUsd: 3_070_500_000n,
        isEstimated: false,
        storageFeeNanoUsd: 96_026_400n,
        observed: { stepUsages: OBSERVED, toolFeeNanoUsd: 0n },
      },
    ]);

    expect(legs).toEqual(['input-above-estimate', 'tier-crossed']);
  });
});

describe('holdOverrunLegs — a Smart Model candidate the hold did not reserve', () => {
  /** A cheaper candidate's charge: the slot reserved only its dearest candidate, `text-model`. */
  function candidateCharge(
    steps: readonly StepTokens[],
    extra: Partial<BilledCharge> = {}
  ): BilledCharge {
    return textCharge(steps, { modelId: 'cheaper-model', ...extra });
  }

  it('names dense input against the node’s reserved input bound', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER]), [
      candidateCharge([{ inputTokens: 51, outputTokens: 10 }]),
    ]);

    expect(legs).toEqual(['input-above-estimate']);
  });

  it('names output past the node’s wire cap', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER]), [
      candidateCharge([{ inputTokens: 50, outputTokens: 11 }]),
    ]);

    expect(legs).toEqual(['output-above-wire-cap']);
  });

  it('names no tier crossing, since the reserved tiers are another model’s', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER]), [
      candidateCharge([{ inputTokens: 101, outputTokens: 10 }]),
    ]);

    expect(legs).toEqual(['input-above-estimate']);
  });

  it('names nothing within the node’s bounds, however its rate compares with another model’s ceiling', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER]), [
      candidateCharge([{ inputTokens: 50, outputTokens: 10 }], { billableCostNanoUsd: 999_999n }),
    ]);

    expect(legs).toEqual([]);
  });

  it('leaves a bill above its hold within the node’s bounds unattributed', () => {
    const legs = holdOverrunLegs(reservationOf([ANSWER], ANSWER.heldNanoUsd), [
      candidateCharge([{ inputTokens: 50, outputTokens: 10 }], {
        billableCostNanoUsd: ANSWER.heldNanoUsd + 1n,
      }),
    ]);

    expect(legs).toEqual(['unattributed']);
  });
});

describe('parseChargeKey', () => {
  it('reads a node’s own charge as that node, with no parent', () => {
    expect(parseChargeKey('answer')).toEqual({ nodeId: 'answer' });
  });

  it('reads a fan-out branch as its node, under the node', () => {
    expect(parseChargeKey('answer#1')).toEqual({ nodeId: 'answer', parentKey: 'answer' });
  });

  it('reads an auxiliary generation on a branch as its node, under the branch', () => {
    expect(parseChargeKey('answer#1#classifier')).toEqual({
      nodeId: 'answer',
      parentKey: 'answer#1',
    });
  });
});

describe('billedNanoUsd', () => {
  it('sums every charge’s billable cost and storage fee', () => {
    expect(
      billedNanoUsd([
        textCharge([], { billableCostNanoUsd: 5n, storageFeeNanoUsd: 2n }),
        textCharge([], { billableCostNanoUsd: 3n }),
      ])
    ).toBe(10n);
  });
});
