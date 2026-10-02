import { describe, expect, it } from 'vitest';

import { steppedCallLineItems } from '../estimate/price-request.ts';
import { evaluateManifest } from '../estimate/reducers.ts';
import {
  perImagePricingFixture,
  perSecondPricingFixture,
  tokenPricingFixture,
} from '../../testing/pricing-fixture.ts';
import { toolLoopBound } from '../tool-loop.ts';
import {
  costAt,
  largestFundedOutput,
  mediaCallCurve,
  priceAtBaseRates,
  priceSteps,
  stepInputBoundTokens,
  sumCurves,
  textCallCurve,
  tiersAt,
} from './curve.ts';
import { ceilingOf } from './schedule.ts';
import type { SteppedCall } from '../estimate/price-request.ts';
import type { ToolLoopBound } from '../tool-loop.ts';
import type { CallQuantities, CostCurve } from './curve.ts';
import type { TokenPricing } from './schedule.ts';

/**
 * A tiered model's anchor: base 3,450 / 17,250, and 6,900 / 25,875 above
 * 200,000. A reserve reads its ceiling: 4,313 / 21,563, and 8,625 / 32,344.
 */
const tiered = tokenPricingFixture({
  input: 3450n,
  output: 17_250n,
  tiers: [{ abovePromptTokens: 200_000, input: 6900n, output: 25_875n }],
});

/** Seven calls in eight steps, each result 2,000 tokens, with no tool-use overhead. */
const midLoop: ToolLoopBound = { ...toolLoopBound(['webSearch'], 7), overheadTokens: 0 };

const midSearch: CallQuantities = {
  promptTokens: 609,
  loop: midLoop,
  persists: true,
  newMessageChars: 88,
};

function flat(input: bigint, output: bigint): TokenPricing {
  return tokenPricingFixture({ input, output });
}

describe('stepInputBoundTokens', () => {
  it('bounds a single step by its prompt alone', () => {
    const single: CallQuantities = { promptTokens: 609, persists: true, newMessageChars: 0 };
    expect(stepInputBoundTokens(single, 1, 64_000)).toBe(609);
  });

  it('bounds a loop’s first step by its prompt and the tool-use overhead', () => {
    const loop = toolLoopBound(['webSearch'], 7);
    const quantities: CallQuantities = { ...midSearch, loop };
    expect(stepInputBoundTokens(quantities, 1, 64_000)).toBe(609 + loop.overheadTokens);
  });

  it('bounds a middle step by its prompt, earlier outputs, results and overhead', () => {
    const loop = toolLoopBound(['webSearch'], 7);
    const quantities: CallQuantities = { ...midSearch, loop };
    expect(stepInputBoundTokens(quantities, 3, 1000)).toBe(
      609 + 2 * 1000 + 7 * loop.resultTokens + loop.overheadTokens
    );
  });

  it('bounds the last step with no tool-use overhead', () => {
    const loop = toolLoopBound(['webSearch'], 7);
    expect(loop.overheadTokens).toBeGreaterThan(0);
    expect(stepInputBoundTokens({ ...midSearch, loop }, 8, 26_485)).toBe(
      609 + 7 * 26_485 + 7 * loop.resultTokens
    );
  });

  it('refuses a negative output ceiling', () => {
    expect(() => stepInputBoundTokens(midSearch, 2, -1)).toThrow(RangeError);
  });
});

describe('textCallCurve — a tool loop whose later steps cross a tier', () => {
  const curve = textCallCurve(tiered, 'reserve', midSearch, 200_000);

  it('prices every step at base below the first crossing', () => {
    expect(costAt(curve, 26_484)).toBe(8_573_673_048n);
    expect(tiersAt(curve, 26_484)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('prices only step 8 at the tier once its re-sent output passes 200,000 prompt tokens', () => {
    expect(costAt(curve, 26_485)).toBe(9_721_930_349n);
    expect(tiersAt(curve, 26_485)).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('differs from pricing every step at the call’s largest step tier', () => {
    const everyStepAtTier = steppedCallLineItems(
      [
        {
          stepRates: Array.from({ length: 8 }, () => ceilingOf(tiered.anchor).tiers[0]!.rates),
          toolLoop: midLoop,
        },
      ],
      609n,
      88
    );
    const perCall = evaluateManifest({ items: everyStepAtTier }, 26_485n, { scope: 'all-in' });
    expect(perCall).toBe(14_499_533_620n);
    expect(costAt(curve, 26_485)).not.toBe(perCall);
  });

  it('starts a regime exactly where each later step enters the tier', () => {
    expect(curve.regimes.map((regime) => regime.fromOutputTokens)).toEqual([
      0, 26_485, 30_899, 37_079, 46_348, 61_798, 92_696, 185_392,
    ]);
  });

  it('keeps each regime’s step tiers for the whole regime', () => {
    expect(tiersAt(curve, 30_898)).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(tiersAt(curve, 30_899)).toEqual([0, 0, 0, 0, 0, 0, 1, 1]);
    expect(tiersAt(curve, 185_392)).toEqual([0, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('clips the regime starts to the output cap', () => {
    const clipped = textCallCurve(tiered, 'reserve', midSearch, 61_798);
    expect(clipped.regimes.map((regime) => regime.fromOutputTokens)).toEqual([
      0, 26_485, 30_899, 37_079, 46_348, 61_798,
    ]);
  });

  it('drops a regime that would start one token above the cap', () => {
    const clipped = textCallCurve(tiered, 'reserve', midSearch, 61_797);
    expect(clipped.regimes.at(-1)?.fromOutputTokens).toBe(46_348);
  });

  it('starts at the tier a step already exceeds with no output at all', () => {
    const long = textCallCurve(tiered, 'reserve', { ...midSearch, promptTokens: 190_000 }, 1000);
    expect(tiersAt(long, 0)).toEqual([0, 1, 1, 1, 1, 1, 1, 1]);
    expect(long.regimes).toHaveLength(1);
  });

  it('prices a single step at the tier its prompt resolves to', () => {
    const single = textCallCurve(
      tiered,
      'display',
      { promptTokens: 200_001, persists: false, newMessageChars: 0 },
      100
    );
    expect(costAt(single, 100)).toBe(200_001n * 6900n + 100n * 25_875n);
  });

  it('records the output cap it was built for', () => {
    expect(textCallCurve(tiered, 'reserve', midSearch, 61_797).cap).toBe(61_797);
  });

  it('leaves out every storage leg of a call that does not persist', () => {
    const provider = textCallCurve(tiered, 'reserve', { ...midSearch, persists: false }, 200_000);
    expect(provider.regimes[0]?.manifest.every((item) => item.kind === 'provider')).toBe(true);
  });

  it.each([
    ['a negative prompt', { ...midSearch, promptTokens: -1 }, 100],
    ['a fractional new-message length', { ...midSearch, newMessageChars: 0.5 }, 100],
    ['a negative output cap', midSearch, -1],
  ] as const)('refuses %s', (_label, quantities, cap) => {
    expect(() => textCallCurve(tiered, 'reserve', quantities, cap)).toThrow(RangeError);
  });
});

describe('textCallCurve — a single regime prices as the stepped line items do', () => {
  const loopOfTen = toolLoopBound(['webSearch'], 10);
  const loopOfSeven = toolLoopBound(['webSearch'], 7);
  interface FlatCall {
    readonly input: bigint;
    readonly output: bigint;
    readonly loop?: ToolLoopBound;
  }
  const cases: readonly {
    readonly name: string;
    readonly promptTokens: bigint;
    readonly inputChars: number;
    readonly calls: readonly FlatCall[];
  }[] = [
    {
      name: 'one model',
      promptTokens: 100n,
      inputChars: 1000,
      calls: [{ input: 5n, output: 15n }],
    },
    {
      name: 'two models summed',
      promptTokens: 100n,
      inputChars: 1000,
      calls: [
        { input: 5n, output: 15n },
        { input: 2n, output: 8n },
      ],
    },
    {
      name: 'a zero-length prompt',
      promptTokens: 0n,
      inputChars: 0,
      calls: [{ input: 5n, output: 15n }],
    },
    {
      name: 'a ten-call tool loop',
      promptTokens: 100n,
      inputChars: 1000,
      calls: [{ input: 5n, output: 15n, loop: loopOfTen }],
    },
    {
      name: 'a seven-call tool loop',
      promptTokens: 100n,
      inputChars: 1000,
      calls: [{ input: 5n, output: 15n, loop: loopOfSeven }],
    },
    {
      name: 'a loop-free sibling beside a looping one',
      promptTokens: 100n,
      inputChars: 1000,
      calls: [
        { input: 5n, output: 15n, loop: loopOfTen },
        { input: 2n, output: 8n },
      ],
    },
  ];

  /** A flat-rate call as the stepped builder reads its reserve: the same ceiling rates at every step. */
  function steppedOf(call: FlatCall): SteppedCall {
    const steps = call.loop?.steps ?? 1;
    const held = ceilingOf(flat(call.input, call.output).anchor).base;
    return {
      stepRates: Array.from({ length: steps }, () => held),
      ...(call.loop === undefined ? {} : { toolLoop: call.loop }),
    };
  }

  function curveOf(testCase: (typeof cases)[number]): CostCurve {
    return sumCurves(
      testCase.calls.map((call, index) =>
        textCallCurve(
          flat(call.input, call.output),
          'reserve',
          {
            promptTokens: Number(testCase.promptTokens),
            ...(call.loop === undefined ? {} : { loop: call.loop }),
            persists: true,
            newMessageChars: index === 0 ? testCase.inputChars : 0,
          },
          64_000
        )
      )
    );
  }

  it.each(cases)('holds one regime for $name', (testCase) => {
    expect(curveOf(testCase).regimes).toHaveLength(1);
  });

  it.each(cases)('equals the stepped line items by amount for $name', (testCase) => {
    const items = steppedCallLineItems(
      testCase.calls.map((call) => steppedOf(call)),
      testCase.promptTokens,
      testCase.inputChars
    );
    const curve = curveOf(testCase);
    for (const outputTokens of [0, 1, 777, 64_000]) {
      expect(costAt(curve, outputTokens)).toBe(
        evaluateManifest({ items }, BigInt(outputTokens), { scope: 'all-in' })
      );
    }
  });
});

describe('sumCurves', () => {
  it('breaks the sum wherever either curve breaks', () => {
    const early = textCallCurve(tiered, 'reserve', midSearch, 200_000);
    const late = textCallCurve(tiered, 'reserve', { ...midSearch, promptTokens: 700 }, 200_000);
    const summed = sumCurves([early, late]);
    const starts = new Set([
      ...early.regimes.map((regime) => regime.fromOutputTokens),
      ...late.regimes.map((regime) => regime.fromOutputTokens),
    ]);
    expect(summed.regimes.map((regime) => regime.fromOutputTokens)).toEqual(
      [...starts].toSorted((a, b) => a - b)
    );
  });

  it('costs each output count at the sum of the curves’ costs', () => {
    const early = textCallCurve(tiered, 'reserve', midSearch, 200_000);
    const late = textCallCurve(tiered, 'reserve', { ...midSearch, promptTokens: 700 }, 200_000);
    const summed = sumCurves([early, late]);
    for (const outputTokens of [0, 26_470, 26_485, 100_000]) {
      expect(costAt(summed, outputTokens)).toBe(
        costAt(early, outputTokens) + costAt(late, outputTokens)
      );
    }
  });

  it('carries every curve’s step tiers, first curve first', () => {
    const single = textCallCurve(
      tiered,
      'reserve',
      { promptTokens: 200_001, persists: false, newMessageChars: 0 },
      30_000
    );
    const loop = textCallCurve(tiered, 'reserve', midSearch, 200_000);
    expect(tiersAt(sumCurves([single, loop]), 26_485)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('takes the smallest cap of the curves it sums', () => {
    const wide = textCallCurve(tiered, 'reserve', midSearch, 200_000);
    const narrow = textCallCurve(tiered, 'reserve', midSearch, 30_000);
    expect(sumCurves([wide, narrow]).cap).toBe(30_000);
    expect(sumCurves([narrow, wide]).cap).toBe(30_000);
  });

  it('drops a regime that starts above the smallest cap', () => {
    const wide = textCallCurve(tiered, 'reserve', midSearch, 200_000);
    const narrow = textCallCurve(flat(5n, 15n), 'reserve', midSearch, 30_000);
    expect(sumCurves([wide, narrow]).regimes.map((regime) => regime.fromOutputTokens)).toEqual([
      0, 26_485,
    ]);
  });

  it('keeps a text curve’s cap and regimes when summed with a media curve', () => {
    const text = textCallCurve(tiered, 'reserve', midSearch, 200_000);
    const image = perImagePricingFixture({ anchor: 51_750_000n, dearest: 103_500_000n });
    const summed = sumCurves([text, mediaCallCurve(image, 'reserve', { images: 1 })]);
    expect(summed.cap).toBe(200_000);
    expect(summed.regimes.map((regime) => regime.fromOutputTokens)).toEqual(
      text.regimes.map((regime) => regime.fromOutputTokens)
    );
    expect(costAt(summed, 26_485)).toBe(costAt(text, 26_485) + 103_500_000n);
  });

  it('refuses an empty set of curves', () => {
    expect(() => sumCurves([])).toThrow(RangeError);
  });
});

describe('costAt and tiersAt', () => {
  const curve = textCallCurve(flat(5n, 15n), 'reserve', midSearch, 100);

  it.each([-1, 0.5])('refuses an output count of %s', (outputTokens) => {
    expect(() => costAt(curve, outputTokens)).toThrow(RangeError);
    expect(() => tiersAt(curve, outputTokens)).toThrow(RangeError);
  });

  it('prices an output count at exactly the cap', () => {
    expect(costAt(curve, 100)).toBe(costAt(curve, 99) + (costAt(curve, 99) - costAt(curve, 98)));
  });

  it('refuses to price an output count above the cap', () => {
    expect(() => costAt(curve, 101)).toThrow(RangeError);
  });

  it('refuses to name the tiers of an output count above the cap', () => {
    expect(() => tiersAt(curve, 101)).toThrow(RangeError);
  });

  it('refuses a curve with no regime at the output count', () => {
    const shifted: CostCurve = {
      cap: 100,
      regimes: [{ ...curve.regimes[0]!, fromOutputTokens: 10 }],
    };
    expect(() => costAt(shifted, 5)).toThrow(RangeError);
  });
});

describe('largestFundedOutput', () => {
  const curve = textCallCurve(tiered, 'reserve', midSearch, 200_000);

  it('funds the last output count before the tier when the funding stops there', () => {
    expect(largestFundedOutput(curve, 8_573_673_048n)).toBe(26_484);
  });

  it('stays below a regime whose first output count the funding cannot reach', () => {
    expect(largestFundedOutput(curve, 9_721_930_348n)).toBe(26_484);
  });

  it('funds the first output count of a regime at exactly its cost', () => {
    expect(largestFundedOutput(curve, 9_721_930_349n)).toBe(26_485);
  });

  it('funds nothing when the cost at no output exceeds the funding', () => {
    expect(largestFundedOutput(curve, costAt(curve, 0) - 1n)).toBe(0);
  });

  it('equals the closed form for a single regime', () => {
    const single = textCallCurve(
      flat(5n, 15n),
      'reserve',
      { promptTokens: 609, persists: true, newMessageChars: 88 },
      1_000_000
    );
    const funding = 1_000_000_000n;
    const [regime] = single.regimes;
    const fixed = evaluateManifest({ items: regime!.manifest }, 0n, { scope: 'all-in' });
    const variable = evaluateManifest({ items: regime!.manifest }, 1n, { scope: 'all-in' }) - fixed;
    expect(largestFundedOutput(single, funding)).toBe(Number((funding - fixed) / variable));
  });

  it('funds the cap when the funding covers more than the cost at the cap', () => {
    expect(largestFundedOutput(curve, costAt(curve, 200_000) + 1_000_000_000n)).toBe(200_000);
  });

  it('funds the cap when the funding is exactly the cost at the cap', () => {
    expect(largestFundedOutput(curve, costAt(curve, 200_000))).toBe(200_000);
  });

  it('funds the cap of a one-regime curve however large the funding', () => {
    const cheap = textCallCurve(
      flat(1n, 1n),
      'reserve',
      { promptTokens: 0, persists: false, newMessageChars: 0 },
      1
    );
    expect(largestFundedOutput(cheap, 10n ** 30n)).toBe(1);
  });

  it('refuses a curve with no per-output-token rate', () => {
    const image = perImagePricingFixture({ anchor: 1n, dearest: 2n });
    expect(() => largestFundedOutput(mediaCallCurve(image, 'reserve', { images: 1 }), 10n)).toThrow(
      RangeError
    );
  });
});

describe('mediaCallCurve', () => {
  const image = perImagePricingFixture({ anchor: 51_750_000n, dearest: 103_500_000n });
  const video = perSecondPricingFixture({
    anchor: { '720p': 128_800_000n },
    dearest: { '720p': 193_200_000n },
  });

  it('prices images at the anchor for display', () => {
    expect(costAt(mediaCallCurve(image, 'display', { images: 2 }), 0)).toBe(2n * 51_750_000n);
  });

  it('reserves images at the dearest unit', () => {
    expect(costAt(mediaCallCurve(image, 'reserve', { images: 1 }), 0)).toBe(103_500_000n);
  });

  it('reserves seconds at the dearest rate of the resolution', () => {
    const curve = mediaCallCurve(video, 'reserve', { seconds: 5, resolution: '720p' });
    expect(costAt(curve, 0)).toBe(5n * 193_200_000n);
  });

  it('holds one fixed regime with no step tiers', () => {
    const curve = mediaCallCurve(video, 'estimatedCharge', { seconds: 5, resolution: '720p' });
    expect(curve.regimes).toHaveLength(1);
    expect(curve.regimes[0]?.stepTiers).toEqual([]);
  });

  it('caps a media call at the largest safe output count', () => {
    expect(mediaCallCurve(image, 'reserve', { images: 1 }).cap).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('prices a media call the same at every output count', () => {
    const curve = mediaCallCurve(image, 'reserve', { images: 1 });
    expect(costAt(curve, 1_000_000)).toBe(costAt(curve, 0));
  });

  it.each([
    ['no image count', image, {}],
    ['zero images', image, { images: 0 }],
    ['seconds on a per-image price', image, { images: 1, seconds: 3 }],
    ['a resolution on a per-image price', image, { images: 1, resolution: '720p' }],
    ['no seconds', video, { resolution: '720p' }],
    ['no resolution', video, { seconds: 5 }],
    ['an unpriced resolution', video, { seconds: 5, resolution: '4k' }],
    ['an inherited member as a resolution', video, { seconds: 5, resolution: 'constructor' }],
    ['images on a per-second price', video, { images: 1, seconds: 5, resolution: '720p' }],
  ] as const)('refuses %s', (_label, pricing, call) => {
    expect(() => mediaCallCurve(pricing, 'reserve', call)).toThrow(RangeError);
  });
});

describe('priceSteps', () => {
  it('prices each observed step at the tier its own input resolves to', () => {
    const priced = priceSteps(tiered, 'estimatedCharge', [
      { inputTokens: 200_000, outputTokens: 500 },
      { inputTokens: 200_001, outputTokens: 800 },
    ]);
    expect(priced.tiers).toEqual([0, 1]);
    expect(priced.nanoUsd).toBe(
      200_000n * 4313n + 500n * 21_563n + 200_001n * 8625n + 800n * 32_344n
    );
  });

  it('prices no steps at nothing', () => {
    expect(priceSteps(tiered, 'estimatedCharge', [])).toEqual({ nanoUsd: 0n, tiers: [] });
  });

  it('agrees with the curve’s provider cost at each step’s bound', () => {
    const provider = textCallCurve(tiered, 'reserve', { ...midSearch, persists: false }, 200_000);
    const outputTokens = 40_000;
    const steps = Array.from({ length: 8 }, (_unused, index) => ({
      inputTokens: stepInputBoundTokens(midSearch, index + 1, outputTokens),
      outputTokens,
    }));
    const fees = BigInt(midLoop.calls) * midLoop.callFeeNano;
    expect(costAt(provider, outputTokens)).toBe(
      priceSteps(tiered, 'reserve', steps).nanoUsd + fees
    );
  });

  it.each([
    { inputTokens: -1, outputTokens: 0 },
    { inputTokens: 0, outputTokens: 1.5 },
  ])('refuses an observed step of $inputTokens in, $outputTokens out', (step) => {
    expect(() => priceSteps(tiered, 'estimatedCharge', [step])).toThrow(RangeError);
  });
});

describe('priceAtBaseRates', () => {
  it('prices an input past every threshold at the base rates', () => {
    const usage = { inputTokens: 570_000, outputTokens: 1500 };
    expect(priceAtBaseRates(tiered, 'estimatedCharge', usage)).toBe(
      570_000n * 4313n + 1500n * 21_563n
    );
  });

  it('never exceeds the per-step price of the steps it sums', () => {
    const steps = [
      { inputTokens: 150_000, outputTokens: 500 },
      { inputTokens: 230_000, outputTokens: 500 },
    ];
    const summed = { inputTokens: 380_000, outputTokens: 1000 };
    expect(priceAtBaseRates(tiered, 'estimatedCharge', summed)).toBeLessThanOrEqual(
      priceSteps(tiered, 'estimatedCharge', steps).nanoUsd
    );
  });

  it.each([
    { inputTokens: -1, outputTokens: 0 },
    { inputTokens: 0, outputTokens: 1.5 },
  ])('refuses a usage of $inputTokens in, $outputTokens out', (usage) => {
    expect(() => priceAtBaseRates(tiered, 'estimatedCharge', usage)).toThrow(RangeError);
  });
});
