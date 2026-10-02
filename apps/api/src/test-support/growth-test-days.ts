/**
 * Where a growth integration test puts the days it writes to.
 *
 * Two regions, both chosen rather than drawn:
 *
 * - `clean` — days after the run day, which no growth seed can have written
 *   to. The seed names hour zero of each of the ninety UTC days ending on the
 *   day it runs, and the clone template a run reads was built before that run,
 *   so every seeded bucket is at or before the run day.
 * - `seeded` — one day inside those ninety, so a case placed there runs with
 *   another writer's rows in its own buckets on purpose. The first lane's sits
 *   forty-five days back, the middle of the freshest span a template can hold,
 *   which is the placement that survives the oldest one: the span is ninety
 *   days, so the day is inside it for any template built within the last
 *   forty-five, and each later lane's sits nearer the run day still. A case
 *   placed there holds the template to it through `requireSeededRows`, because
 *   a span that no longer reaches the day leaves the case passing on a bucket
 *   nobody else writes to — the opposite of what it was placed for.
 *
 * Both are measured from the run day, because the span they are placed against
 * is anchored to the day the seed ran rather than to any calendar date a
 * constant could name. Determinism here is relative to the run day, which is
 * the contract the seed itself makes.
 *
 * LANES. The sets a growth bucket is counted in — the visitor set, the place
 * set, each family's index set, the bucket's overflow flags — are addressed by
 * the grain and the bucket and nothing else, and the harness gives one run one
 * Redis keyspace while running its test files concurrently in it. Two files
 * sharing a day therefore read each other's members and assert on a number
 * neither of them produced, and a member naming a campaign only one of them
 * minted fails the rollup's foreign key outright. Lanes make that impossible
 * instead of unlikely, which is why the placement is one module every such file
 * imports rather than a constant each of them spells.
 */

import { DAY_MS } from '@hushbox/shared/test-instants';

/** One lane per file that takes days from here. */
export const GROWTH_TEST_LANES = ['seed-door', 'rollup', 'count-beacon', 'funnel'] as const;

export type GrowthTestLane = (typeof GROWTH_TEST_LANES)[number];

/** How many clean days one lane may take. */
export const GROWTH_TEST_LANE_DAYS = 200;

/**
 * The unused days between one lane's region and the next. Wider than any
 * disagreement two files can have about which UTC day it is, so a run that
 * crosses midnight between two files' imports still hands them disjoint days.
 */
const LANE_GAP_DAYS = 8;

/** How far past the run day the first lane's clean region starts. */
const FIRST_CLEAN_DAY = 2;

/** How far back the first lane's seeded day sits. */
const FIRST_SEEDED_DAY_BACK = 45;

/**
 * The table a caller counts rows of to satisfy
 * {@link GrowthTestDays.requireSeededRows}. Shared rather than named in each
 * caller because the check only stands against a family the seed writes on
 * every day of its span: the seed writes a row of this one for every page it
 * names on each of its ninety days, so any day inside the span holds rows,
 * while a sparser family would leave the check failing on days the seed did
 * reach. The query stays with the caller; only the family has to agree.
 */
export { growthPaths as GROWTH_SEEDED_DAY_TABLE } from '@hushbox/db';

export function growthTestDays(lane: GrowthTestLane, now: Date): GrowthTestDays {
  const laneIndex = GROWTH_TEST_LANES.indexOf(lane);
  const runDayStart = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const firstCleanDay = FIRST_CLEAN_DAY + laneIndex * (GROWTH_TEST_LANE_DAYS + LANE_GAP_DAYS);
  const seeded = new Date(
    runDayStart - (FIRST_SEEDED_DAY_BACK - laneIndex * LANE_GAP_DAYS) * DAY_MS
  );
  return {
    clean: (index) => {
      if (index < 0 || index >= GROWTH_TEST_LANE_DAYS) {
        throw new Error(
          `growthTestDays: lane "${lane}" holds ${String(GROWTH_TEST_LANE_DAYS)} days, so ${String(index)} is not one of them`
        );
      }
      return new Date(runDayStart + (firstCleanDay + index) * DAY_MS);
    },
    seeded,
    requireSeededRows: (rowsFound) => {
      if (rowsFound > 0) return;
      throw new Error(
        `growthTestDays: lane "${lane}" put a case on ${seeded.toISOString().slice(0, 10)}, which ` +
          'holds none of the clone template’s own growth rows, so the case reads a bucket nobody ' +
          'else writes to and no longer stands for the co-writer state it was placed for. The ' +
          'template is rebuilt when its migration fingerprint moves and never on a clock, so a ' +
          'checkout whose migrations have been stable long enough carries a seed whose ninety days ' +
          'end before this one. Remedy: `pnpm db:reset`, which discards the template so the next ' +
          'run seeds a fresh one.'
      );
    },
  };
}

/**
 * The days one lane offers. Not exported: it is the declared return type of
 * {@link growthTestDays} and nothing else names it.
 */
interface GrowthTestDays {
  /** A day nothing but this lane writes to, `index` days into its own region. */
  readonly clean: (index: number) => Date;
  /** This lane's one day inside the days the clone template's own seed wrote. */
  readonly seeded: Date;
  /**
   * Fails when {@link GrowthTestDays.seeded} holds none of the template's own
   * growth rows, which is the one thing a case placed there cannot detect for
   * itself: the day silently becomes a second clean one, and the case goes on
   * passing while testing something else.
   */
  readonly requireSeededRows: (rowsFound: number) => void;
}
