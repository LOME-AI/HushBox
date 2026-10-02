import { describe, expect, it } from 'vitest';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { buildFunnelLadder, biggestDropOf, formatVisitorCount } from './funnel-math.js';
import type { GrowthFunnelWeekWire } from '@hushbox/shared';

function weekRow(overrides: Partial<GrowthFunnelWeekWire> = {}): GrowthFunnelWeekWire {
  return {
    week: isoAt(TEST_DAY_START),
    campaign: 'hn-launch',
    visitorsDailySummed: 1284,
    visitorsOverflow: false,
    productEntryClicksHourlySummed: 143,
    productEntryClicksOverflow: false,
    started: 97,
    startedOverflow: false,
    finished: 41,
    verified: 36,
    activated: 29,
    returnedWeek1: 17,
    firstPaid: 6,
    revenueNanoUsd: '184000000000',
    ...overrides,
  };
}

describe('buildFunnelLadder', () => {
  it('returns the eight ladder steps in descending order', () => {
    const steps = buildFunnelLadder(weekRow());
    expect(steps.map((step) => step.label)).toEqual([
      'Visited',
      'Clicked into the product',
      'Started registration',
      'Account created',
      'Email verified',
      'Sent a message',
      'Returned week 1',
      'First payment',
    ]);
  });

  it('states which bucketing produced each step that sums per-bucket counts', () => {
    const steps = buildFunnelLadder(weekRow());
    expect(steps.map((step) => [step.label, step.bucketing])).toEqual([
      ['Visited', 'daily'],
      ['Clicked into the product', 'hourly'],
      ['Started registration', 'hourly'],
      ['Account created', null],
      ['Email verified', null],
      ['Sent a message', null],
      ['Returned week 1', null],
      ['First payment', null],
    ]);
  });

  it('marks every step with no account identity behind it, and no other', () => {
    const steps = buildFunnelLadder(weekRow());
    expect(steps.map((step) => step.anonymous)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('marks a step a floor where the week says a bucket behind it hit its ceiling', () => {
    const steps = buildFunnelLadder(weekRow({ visitorsOverflow: true }));
    expect(steps.map((step) => [step.label, step.overflow])).toEqual([
      ['Visited', true],
      ['Clicked into the product', false],
      ['Started registration', false],
      ['Account created', null],
      ['Email verified', null],
      ['Sent a message', null],
      ['Returned week 1', null],
      ['First payment', null],
    ]);
  });

  it('marks the started step a floor where the week says an hour behind it hit its ceiling', () => {
    const steps = buildFunnelLadder(weekRow({ startedOverflow: true }));
    expect(steps.find((step) => step.label === 'Started registration')?.overflow).toBe(true);
  });

  it('carries no flag at all for a step whose table records none', () => {
    const steps = buildFunnelLadder(weekRow({ startedOverflow: true }));
    expect(steps.find((step) => step.label === 'Account created')?.overflow).toBeNull();
  });

  it('leaves the first step without a step rate', () => {
    expect(buildFunnelLadder(weekRow())[0]?.stepRate).toBeNull();
  });

  it('divides each step by the one above it for the step rate', () => {
    // 41 accounts created out of 97 started.
    expect(buildFunnelLadder(weekRow())[3]?.stepRate).toBeCloseTo(41 / 97);
  });

  it('divides each step by the first step for the cumulative rate', () => {
    expect(buildFunnelLadder(weekRow())[3]?.cumulativeRate).toBeCloseTo(41 / 1284);
  });

  it('gives the first step a cumulative rate of one', () => {
    expect(buildFunnelLadder(weekRow())[0]?.cumulativeRate).toBe(1);
  });

  it('reports no step rate rather than infinity when the step above counted nobody', () => {
    const steps = buildFunnelLadder(weekRow({ started: 0, finished: 5 }));
    expect(steps[3]?.stepRate).toBeNull();
  });

  it('reports no cumulative rate rather than infinity when the top step counted nobody', () => {
    const steps = buildFunnelLadder(weekRow({ visitorsDailySummed: 0 }));
    expect(steps[3]?.cumulativeRate).toBeNull();
  });

  it('carries each step count through unchanged', () => {
    expect(buildFunnelLadder(weekRow()).map((step) => step.count)).toEqual([
      1284, 143, 97, 41, 36, 29, 17, 6,
    ]);
  });

  it('scales each bar against the widest step rather than the viewport', () => {
    const steps = buildFunnelLadder(weekRow());
    expect(steps[0]?.widthRatio).toBe(1);
    expect(steps[7]?.widthRatio).toBeCloseTo(6 / 1284);
  });

  it('gives every bar a zero width when the widest step counted nobody', () => {
    const steps = buildFunnelLadder(
      weekRow({
        visitorsDailySummed: 0,
        productEntryClicksHourlySummed: 0,
        started: 0,
        finished: 0,
        verified: 0,
        activated: 0,
        returnedWeek1: 0,
        firstPaid: 0,
      })
    );
    expect(steps.every((step) => step.widthRatio === 0)).toBe(true);
  });
});

describe('a rate built from a count a ceiling cut', () => {
  it('marks a step rate whose own count hit its ceiling', () => {
    const steps = buildFunnelLadder(weekRow({ startedOverflow: true }));
    expect(steps[2]?.stepRateCapped).toBe(true);
  });

  it('marks a step rate whose denominator hit its ceiling', () => {
    const steps = buildFunnelLadder(weekRow({ visitorsOverflow: true }));
    expect(steps[1]?.stepRateCapped).toBe(true);
  });

  it('leaves a step rate unmarked where neither count it divides hit a ceiling', () => {
    const steps = buildFunnelLadder(weekRow({ visitorsOverflow: true }));
    expect(steps[3]?.stepRateCapped).toBe(false);
  });

  it('marks every cumulative rate below the top where the top hit its ceiling', () => {
    const steps = buildFunnelLadder(weekRow({ visitorsOverflow: true }));
    expect(steps.map((step) => step.cumulativeRateCapped)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('leaves the top step\u2019s own cumulative rate unmarked, it being one either way', () => {
    const steps = buildFunnelLadder(weekRow({ visitorsOverflow: true }));
    expect(steps[0]?.cumulativeRateCapped).toBe(false);
  });

  it('marks only its own cumulative rate where a step below the top hit its ceiling', () => {
    const steps = buildFunnelLadder(weekRow({ startedOverflow: true }));
    expect(steps.map((step) => step.cumulativeRateCapped)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('leaves the top step unmarked, there being no step rate to mark', () => {
    const steps = buildFunnelLadder(weekRow({ visitorsOverflow: true }));
    expect(steps[0]?.stepRateCapped).toBe(false);
  });

  it('leaves a rate its empty denominator never produced unmarked', () => {
    const steps = buildFunnelLadder(weekRow({ started: 0, startedOverflow: true }));
    expect(steps[3]?.stepRateCapped).toBe(false);
  });

  it('marks no rate at all in a week that reached no ceiling', () => {
    const steps = buildFunnelLadder(weekRow());
    expect(steps.map((step) => [step.stepRateCapped, step.cumulativeRateCapped])).toEqual(
      steps.map(() => [false, false])
    );
  });
});

describe('biggestDropOf', () => {
  it('names the pair of steps with the lowest step rate', () => {
    const drop = biggestDropOf(buildFunnelLadder(weekRow()));
    expect(drop).toEqual({
      from: 'Visited',
      to: 'Clicked into the product',
      rate: 143 / 1284,
      rateCapped: false,
      comparisonCapped: false,
    });
  });

  it('ignores steps whose rate could not be computed', () => {
    const drop = biggestDropOf(buildFunnelLadder(weekRow({ visitorsDailySummed: 0 })));
    expect(drop?.from).not.toBe('Visited');
  });

  it('returns nothing when no step has a rate', () => {
    const ladder = buildFunnelLadder(weekRow()).slice(0, 1);
    expect(biggestDropOf(ladder)).toBeNull();
  });
});

describe('biggestDropOf where a ceiling cut a count', () => {
  it('marks the drop it names where a count that rate divides hit a ceiling', () => {
    const drop = biggestDropOf(buildFunnelLadder(weekRow({ visitorsOverflow: true })));
    expect(drop?.rateCapped).toBe(true);
  });

  it('leaves the drop it names unmarked where that rate\u2019s own counts were whole', () => {
    const drop = biggestDropOf(buildFunnelLadder(weekRow({ startedOverflow: true })));
    expect(drop?.rateCapped).toBe(false);
  });

  it('reports that a capped rate was ranked in the comparison that chose the drop', () => {
    const drop = biggestDropOf(buildFunnelLadder(weekRow({ startedOverflow: true })));
    expect(drop?.comparisonCapped).toBe(true);
  });

  it('reports no capped rate in the comparison for a week that reached no ceiling', () => {
    const drop = biggestDropOf(buildFunnelLadder(weekRow()));
    expect(drop?.comparisonCapped).toBe(false);
  });
});

describe('formatVisitorCount', () => {
  it('groups a plain count with thousands separators', () => {
    expect(formatVisitorCount(1284, false)).toBe('1,284');
  });

  it('marks an overflowed count as a floor the ceiling cut off', () => {
    expect(formatVisitorCount(100_000, true)).toBe('100,000+');
  });

  it('states a count with no flag behind it plainly, claiming no ceiling either way', () => {
    expect(formatVisitorCount(1284, null)).toBe('1,284');
  });
});
