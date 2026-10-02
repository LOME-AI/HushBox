import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-instants';
import {
  GROWTH_TEST_LANES,
  GROWTH_TEST_LANE_DAYS,
  growthTestDays,
  type GrowthTestLane,
} from './growth-test-days.js';

/**
 * How far back a seeded day may sit for a template built a while ago to still
 * cover it: the seed writes ninety days ending on the day it ran
 * (`GROWTH_SEED_DAYS`, in the seed's own plan module), so a day this far back
 * is inside that span for any template built within the same number of days.
 */
const DEEPEST_SEEDED_DAY_BACK = 45;

/** An instant partway through the run day, so day truncation has something to do. */
const RUN_INSTANT = new Date(TEST_DAY_START + 13 * HOUR_MS);

/** Every day one lane can hand out, as milliseconds. */
function everyDayOf(lane: GrowthTestLane, now: Date): Set<number> {
  const { clean, seeded } = growthTestDays(lane, now);
  const days = new Set([seeded.getTime()]);
  for (let index = 0; index < GROWTH_TEST_LANE_DAYS; index += 1) days.add(clean(index).getTime());
  return days;
}

/** Every lane against every other, both ways round. */
function everyOrderedPair(): readonly (readonly [GrowthTestLane, GrowthTestLane])[] {
  return GROWTH_TEST_LANES.flatMap((lane) =>
    GROWTH_TEST_LANES.filter((other) => other !== lane).map(
      (other) => [lane, other] as readonly [GrowthTestLane, GrowthTestLane]
    )
  );
}

describe('growthTestDays', () => {
  it('places every clean day after the run day', () => {
    for (const lane of GROWTH_TEST_LANES) {
      const { clean } = growthTestDays(lane, RUN_INSTANT);
      expect(clean(0).getTime()).toBeGreaterThan(TEST_DAY_START);
    }
  });

  it('places the seeded day before the run day', () => {
    for (const lane of GROWTH_TEST_LANES) {
      const { seeded } = growthTestDays(lane, RUN_INSTANT);
      expect(seeded.getTime()).toBeLessThan(TEST_DAY_START);
    }
  });

  it('places the seeded day near enough the run day for an older template to cover it', () => {
    for (const lane of GROWTH_TEST_LANES) {
      const { seeded } = growthTestDays(lane, RUN_INSTANT);
      expect((TEST_DAY_START - seeded.getTime()) / DAY_MS).toBeLessThanOrEqual(
        DEEPEST_SEEDED_DAY_BACK
      );
    }
  });

  it('gives no two lanes a day in common', () => {
    for (const [lane, other] of everyOrderedPair()) {
      const days = everyDayOf(lane, RUN_INSTANT);
      const otherDays = everyDayOf(other, RUN_INSTANT);
      expect([...days].filter((day) => otherDays.has(day))).toEqual([]);
    }
  });

  it('keeps lanes apart when they disagree about which UTC day it is', () => {
    const aDayLater = new Date(RUN_INSTANT.getTime() + DAY_MS);
    for (const [lane, other] of everyOrderedPair()) {
      const ahead = everyDayOf(lane, aDayLater);
      const behind = everyDayOf(other, RUN_INSTANT);
      expect([...ahead].filter((day) => behind.has(day))).toEqual([]);
    }
  });

  it('refuses an index before its lane’s own days', () => {
    const { clean } = growthTestDays('rollup', RUN_INSTANT);
    expect(() => clean(-1)).toThrow('is not one of them');
  });

  it('refuses an index past its lane’s own days', () => {
    const { clean } = growthTestDays('rollup', RUN_INSTANT);
    expect(() => clean(GROWTH_TEST_LANE_DAYS)).toThrow('is not one of them');
  });

  it('answers midnight of a UTC day for every day it places', () => {
    const { clean, seeded } = growthTestDays('seed-door', RUN_INSTANT);
    for (const day of [clean(0), clean(GROWTH_TEST_LANE_DAYS - 1), seeded]) {
      expect(day.getTime() % DAY_MS).toBe(0);
    }
  });

  it('refuses a seeded day holding none of the template’s own rows', () => {
    const { requireSeededRows } = growthTestDays('rollup', RUN_INSTANT);
    expect(() => {
      requireSeededRows(0);
    }).toThrow('holds none of the clone template');
  });

  it('accepts a seeded day another writer already has rows in', () => {
    const { requireSeededRows } = growthTestDays('rollup', RUN_INSTANT);
    expect(() => {
      requireSeededRows(1);
    }).not.toThrow();
  });

  it('names the remedy in the refusal', () => {
    const { requireSeededRows } = growthTestDays('seed-door', RUN_INSTANT);
    expect(() => {
      requireSeededRows(0);
    }).toThrow('pnpm db:reset');
  });

  it('answers the same days for two instants inside one UTC day', () => {
    const later = new Date(TEST_DAY_START + 23 * HOUR_MS);
    const first = growthTestDays('seed-door', RUN_INSTANT);
    const second = growthTestDays('seed-door', later);
    expect([second.clean(7), second.seeded]).toEqual([first.clean(7), first.seeded]);
  });
});
