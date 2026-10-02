import { describe, expect, it } from 'vitest';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { dataEdgeNote, newestGrowthDay } from './data-edge.js';
import type { GrowthFreshnessWire } from '@hushbox/shared';

/** The Monday of the week the reference day falls in, which is a Thursday. */
const WEEK_START = TEST_DAY_START - 3 * DAY_MS;
const WEEK_START_DAY = isoAt(WEEK_START).slice(0, 10);
const REFERENCE_DAY = isoAt(TEST_DAY_START).slice(0, 10);
const PREVIOUS_WEEK_DAY = isoAt(WEEK_START - 7 * DAY_MS).slice(0, 10);

/** What the freshness read answers with, with every set silent unless named. */
function freshness(sets: Partial<GrowthFreshnessWire>): GrowthFreshnessWire {
  return { funnel: null, sources: null, marketing: null, events: null, ...sets };
}

describe('newestGrowthDay', () => {
  it('answers no day when every data set holds nothing', () => {
    expect(newestGrowthDay(freshness({}))).toBeNull();
  });

  it('answers the day a data set runs through', () => {
    expect(
      newestGrowthDay(freshness({ marketing: { grain: 'day', runsThrough: REFERENCE_DAY } }))
    ).toEqual({
      grain: 'day',
      runsThrough: REFERENCE_DAY,
    });
  });

  it('answers the day a week-grouped data set opens its newest week on', () => {
    expect(
      newestGrowthDay(freshness({ funnel: { grain: 'week', weekOpening: WEEK_START_DAY } }))
    ).toEqual({
      grain: 'week',
      weekOpening: WEEK_START_DAY,
    });
  });

  it('answers the newest of the days its sets hold, wherever that set sits', () => {
    expect(
      newestGrowthDay(
        freshness({
          funnel: { grain: 'week', weekOpening: WEEK_START_DAY },
          events: { grain: 'day', runsThrough: PREVIOUS_WEEK_DAY },
        })
      )
    ).toEqual({ grain: 'week', weekOpening: WEEK_START_DAY });
  });

  it('answers the day the data runs through where a week opens on that same day', () => {
    expect(
      newestGrowthDay(
        freshness({
          funnel: { grain: 'week', weekOpening: WEEK_START_DAY },
          marketing: { grain: 'day', runsThrough: WEEK_START_DAY },
        })
      )
    ).toEqual({ grain: 'day', runsThrough: WEEK_START_DAY });
  });
});

describe('dataEdgeNote', () => {
  it('says no data set holds a row when there is no newest day', () => {
    expect(dataEdgeNote(null, WEEK_START_DAY)).toBe(
      'No growth data set holds a row yet, so there is no newest day to state.'
    );
  });

  it('states the day the data runs through when that day reaches the week selected', () => {
    expect(dataEdgeNote({ grain: 'day', runsThrough: REFERENCE_DAY }, WEEK_START_DAY)).toBe(
      `Data runs through ${REFERENCE_DAY}.`
    );
  });

  it('names the week a week-grouped set opens rather than a day its data runs through', () => {
    expect(dataEdgeNote({ grain: 'week', weekOpening: WEEK_START_DAY }, WEEK_START_DAY)).toBe(
      `The newest data is in the week beginning ${WEEK_START_DAY}.`
    );
  });

  it('says an empty panel is old data when the day the data runs through falls before the week selected', () => {
    expect(dataEdgeNote({ grain: 'day', runsThrough: PREVIOUS_WEEK_DAY }, WEEK_START_DAY)).toBe(
      `Data runs through ${PREVIOUS_WEEK_DAY}, before the week selected: no growth data reaches that week, so a week-scoped panel below is empty for want of data rather than for want of traffic.`
    );
  });

  it('says an empty panel is old data when the newest week opens before the week selected', () => {
    expect(dataEdgeNote({ grain: 'week', weekOpening: PREVIOUS_WEEK_DAY }, WEEK_START_DAY)).toBe(
      `The newest data is in the week beginning ${PREVIOUS_WEEK_DAY}, before the week selected: no growth data reaches that week, so a week-scoped panel below is empty for want of data rather than for want of traffic.`
    );
  });
});
