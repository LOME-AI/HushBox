import { describe, expect, it } from 'vitest';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { toCsv, WHOLE_READ } from './csv.js';
import { dayOf } from './growth-window.js';
import {
  figuresOutsideSelection,
  headlineColumns,
  headlineFigures,
  headlineFileWeeks,
  headlineWeeks,
  NO_LADDER_ROW_REASON,
  NO_MARGINAL_ROW_REASON,
  weekOnWeekChange,
} from './headline-figures.js';
import type { HeadlineFigure, UnscopedMarginals } from './headline-figures.js';
import type { GrowthFunnelWeekWire } from '@hushbox/shared';

const WEEK_START = TEST_DAY_START - 3 * DAY_MS;

function week(over: Partial<GrowthFunnelWeekWire>): GrowthFunnelWeekWire {
  return {
    week: isoAt(WEEK_START),
    campaign: 'hn-launch',
    visitorsDailySummed: 1000,
    visitorsOverflow: false,
    productEntryClicksHourlySummed: 100,
    productEntryClicksOverflow: false,
    started: 90,
    startedOverflow: false,
    finished: 40,
    verified: 30,
    activated: 20,
    returnedWeek1: 10,
    firstPaid: 5,
    revenueNanoUsd: '0',
    ...over,
  };
}

const TWO_CAMPAIGNS = [
  week({
    campaign: 'hn-launch',
    visitorsDailySummed: 1000,
    productEntryClicksHourlySummed: 100,
    finished: 40,
    firstPaid: 5,
  }),
  week({
    campaign: 'bing-brand',
    visitorsDailySummed: 300,
    productEntryClicksHourlySummed: 20,
    finished: 8,
    firstPaid: 1,
  }),
];

/** Three campaigns, so a selection of two is neither one of them nor all of them. */
const THREE_CAMPAIGNS = [
  week({ campaign: 'hn-launch', finished: 41, firstPaid: 6 }),
  week({ campaign: 'x-thread', finished: 1, firstPaid: 0 }),
  week({ campaign: 'direct', finished: 25, firstPaid: 3 }),
];

/**
 * One week under two campaigns, where the same person saw both and reached the
 * product under both. Each campaign's row counts that person, so adding the rows
 * counts them twice; the campaign-free marginal beneath counts them once.
 */
const ONE_PERSON_TWO_CAMPAIGNS = [
  week({
    campaign: 'hn-launch',
    visitorsDailySummed: 1,
    productEntryClicksHourlySummed: 1,
    finished: 1,
    firstPaid: 0,
  }),
  week({
    campaign: 'bing-brand',
    visitorsDailySummed: 1,
    productEntryClicksHourlySummed: 1,
    finished: 0,
    firstPaid: 0,
  }),
];

/** What the campaign-free reads answer for that same week: one person, once. */
const ONE_PERSON_MARGINALS: UnscopedMarginals = {
  visitors: { count: 1, overflow: false },
  productEntryClicks: { count: 1, overflow: false },
};

/** Reads that returned no campaign-free bucket for the week on screen. */
const NO_MARGINALS: UnscopedMarginals = { visitors: null, productEntryClicks: null };

/** The reference day is a Thursday, so its own week began three days earlier. */
const SELECTED = isoAt(WEEK_START);

/** No campaign chosen, which scopes the page to every campaign at once. */
const ALL_CAMPAIGNS: readonly string[] = [];

/** The week before the selected one, which a comparison is taken against. */
const BEFORE = isoAt(WEEK_START - 7 * DAY_MS);

/** Two weeks of one campaign, so the selected week has a week before it. */
const TWO_WEEKS = [week({ week: BEFORE, finished: 30 }), week({ week: SELECTED, finished: 40 })];

describe('a leading figure names its own subject apart from its bucketing', () => {
  it('states the noun and the bucketing of a summed figure separately', () => {
    const [visitors] = headlineFigures(TWO_CAMPAIGNS, SELECTED, ['hn-launch'], NO_MARGINALS);
    expect(visitors?.noun).toBe('Visitors');
    expect(visitors?.bucketing).toBe('daily');
    expect(visitors?.label).toBe('Visitors (daily uniques, summed)');
  });

  it('leaves a figure counted from accounts with no bucketing to state', () => {
    const accounts = headlineFigures(TWO_CAMPAIGNS, SELECTED, ['hn-launch'], NO_MARGINALS)[2];
    expect(accounts?.noun).toBe('Accounts created');
    expect(accounts?.bucketing).toBeNull();
  });

  it('carries the week it was counted for, so nothing else has to be told which', () => {
    const tiles = headlineFigures(TWO_CAMPAIGNS, SELECTED, ['hn-launch'], NO_MARGINALS);
    expect(tiles.every((tile) => tile.week === SELECTED)).toBe(true);
  });
});

describe('a leading figure against the week before it', () => {
  it('states the change and the day that week began', () => {
    const accounts = headlineFigures(TWO_WEEKS, SELECTED, ['hn-launch'], NO_MARGINALS)[2];
    expect(accounts === undefined ? null : weekOnWeekChange(accounts)).toStrictEqual({
      previousDay: dayOf(new Date(BEFORE)),
      change: 10,
    });
  });

  it('states nothing where the week before holds no count of its own', () => {
    const rows = [week({ week: isoAt(WEEK_START - 14 * DAY_MS) }), week({ week: SELECTED })];
    const accounts = headlineFigures(rows, SELECTED, ['hn-launch'], NO_MARGINALS)[2];
    expect(accounts === undefined ? 'no figure' : weekOnWeekChange(accounts)).toBeNull();
  });

  // A ceiling bounds a count from one side, so the difference between two such
  // counts is unbounded in both directions: a stated change would be a figure
  // neither count supports.
  it('states nothing where a ceiling cut the week on screen', () => {
    const rows = [week({ week: BEFORE }), week({ week: SELECTED, visitorsOverflow: true })];
    const [visitors] = headlineFigures(rows, SELECTED, ['hn-launch'], NO_MARGINALS);
    expect(visitors === undefined ? 'no figure' : weekOnWeekChange(visitors)).toBeNull();
  });

  it('states nothing where a ceiling cut the week before', () => {
    const rows = [week({ week: BEFORE, visitorsOverflow: true }), week({ week: SELECTED })];
    const [visitors] = headlineFigures(rows, SELECTED, ['hn-launch'], NO_MARGINALS);
    expect(visitors === undefined ? 'no figure' : weekOnWeekChange(visitors)).toBeNull();
  });

  it('states nothing for a figure the page withheld, there being nothing to compare', () => {
    const [visitors] = headlineFigures(TWO_WEEKS, SELECTED, ALL_CAMPAIGNS, NO_MARGINALS);
    expect(visitors === undefined ? 'no figure' : weekOnWeekChange(visitors)).toBeNull();
  });
});

describe('headlineFigures with one campaign selected', () => {
  it('states all four figures', () => {
    const tiles = headlineFigures(TWO_CAMPAIGNS, SELECTED, ['hn-launch'], NO_MARGINALS);
    expect(tiles.map((tile) => tile.value)).toEqual([1000, 100, 40, 5]);
  });

  it('names the four figures the dashboard leads with', () => {
    const tiles = headlineFigures(TWO_CAMPAIGNS, SELECTED, ['hn-launch'], NO_MARGINALS);
    expect(tiles.map((tile) => tile.label)).toEqual([
      'Visitors (daily uniques, summed)',
      'Product entry clicks (hourly uniques, summed)',
      'Accounts created',
      'First payments',
    ]);
  });

  it('reads only the selected campaign', () => {
    const tiles = headlineFigures(TWO_CAMPAIGNS, SELECTED, ['bing-brand'], NO_MARGINALS);
    expect(tiles[0]?.value).toBe(300);
  });

  it('leaves no figure marked unavailable', () => {
    const tiles = headlineFigures(TWO_CAMPAIGNS, SELECTED, ['hn-launch'], NO_MARGINALS);
    expect(tiles.every((tile) => tile.unavailableReason === null)).toBe(true);
  });

  it('reads the campaign its ladder row counted rather than the marginal beneath it', () => {
    const tiles = headlineFigures(ONE_PERSON_TWO_CAMPAIGNS, SELECTED, ['hn-launch'], {
      visitors: { count: 999, overflow: false },
      productEntryClicks: null,
    });
    expect(tiles[0]?.value).toBe(1);
  });
});

describe('headlineFigures and the ceiling flag', () => {
  it('marks a figure a floor when a row it added had reached its ceiling', () => {
    const rows = [
      week({ campaign: 'hn-launch', visitorsOverflow: true }),
      week({ campaign: 'hn-launch', visitorsOverflow: false }),
    ];
    const tiles = headlineFigures(rows, SELECTED, ['hn-launch'], NO_MARGINALS);
    expect(tiles[0]?.overflow).toBe(true);
  });

  it('leaves a figure unmarked when every row it added counted inside its ceiling', () => {
    const tiles = headlineFigures(TWO_CAMPAIGNS, SELECTED, ['hn-launch'], NO_MARGINALS);
    expect(tiles[0]?.overflow).toBe(false);
  });

  it('carries no flag at all on a figure counted from accounts', () => {
    const tiles = headlineFigures(TWO_CAMPAIGNS, SELECTED, ['hn-launch'], NO_MARGINALS);
    expect(tiles[2]?.overflow).toBeNull();
    expect(tiles[3]?.overflow).toBeNull();
  });

  it('marks the week’s own point on the trend the same way', () => {
    const rows = [week({ campaign: 'hn-launch', visitorsOverflow: true })];
    const tiles = headlineFigures(rows, SELECTED, ['hn-launch'], NO_MARGINALS);
    expect(tiles[0]?.spark.map((point) => point.overflow)).toEqual([true]);
  });

  it('carries the marginal’s own flag onto an unscoped figure', () => {
    const tiles = headlineFigures(TWO_CAMPAIGNS, SELECTED, ALL_CAMPAIGNS, {
      visitors: { count: 100_000, overflow: true },
      productEntryClicks: { count: 12, overflow: false },
    });
    expect(tiles[0]?.overflow).toBe(true);
    expect(tiles[1]?.overflow).toBe(false);
  });
});

describe('headlineFigures across all campaigns', () => {
  it('sums the account figures, which each account contributes to exactly once', () => {
    const tiles = headlineFigures(TWO_CAMPAIGNS, SELECTED, ALL_CAMPAIGNS, ONE_PERSON_MARGINALS);
    expect(tiles[2]?.value).toBe(48);
    expect(tiles[3]?.value).toBe(6);
  });

  it('counts a visitor who saw two campaigns once, where adding the campaigns counts two', () => {
    const unscoped = headlineFigures(
      ONE_PERSON_TWO_CAMPAIGNS,
      SELECTED,
      ALL_CAMPAIGNS,
      ONE_PERSON_MARGINALS
    );
    const perCampaign = ['hn-launch', 'bing-brand'].map(
      (tag) => headlineFigures(ONE_PERSON_TWO_CAMPAIGNS, SELECTED, [tag], NO_MARGINALS)[0]?.value
    );
    expect(unscoped[0]?.value).toBe(1);
    expect(perCampaign).toEqual([1, 1]);
  });

  it('counts an entrant who clicked under two campaigns once, where adding them counts two', () => {
    const unscoped = headlineFigures(
      ONE_PERSON_TWO_CAMPAIGNS,
      SELECTED,
      ALL_CAMPAIGNS,
      ONE_PERSON_MARGINALS
    );
    const perCampaign = ['hn-launch', 'bing-brand'].map(
      (tag) => headlineFigures(ONE_PERSON_TWO_CAMPAIGNS, SELECTED, [tag], NO_MARGINALS)[1]?.value
    );
    expect(unscoped[1]?.value).toBe(1);
    expect(perCampaign).toEqual([1, 1]);
  });

  it('attaches no reason to either figure it read from a marginal', () => {
    const tiles = headlineFigures(TWO_CAMPAIGNS, SELECTED, ALL_CAMPAIGNS, ONE_PERSON_MARGINALS);
    expect(tiles[0]?.unavailableReason).toBeNull();
    expect(tiles[1]?.unavailableReason).toBeNull();
  });

  it('leaves the account figures available', () => {
    const tiles = headlineFigures(TWO_CAMPAIGNS, SELECTED, ALL_CAMPAIGNS, ONE_PERSON_MARGINALS);
    expect(tiles[2]?.unavailableReason).toBeNull();
    expect(tiles[3]?.unavailableReason).toBeNull();
  });

  it('states no figure where the campaign-free read holds no bucket for the week', () => {
    const tiles = headlineFigures(TWO_CAMPAIGNS, SELECTED, ALL_CAMPAIGNS, NO_MARGINALS);
    expect(tiles[0]?.value).toBeNull();
    expect(tiles[1]?.value).toBeNull();
  });

  it('says the campaign-free read held no row rather than the ladder reason', () => {
    const tiles = headlineFigures(TWO_CAMPAIGNS, SELECTED, ALL_CAMPAIGNS, NO_MARGINALS);
    expect(tiles[0]?.unavailableReason).toBe(NO_MARGINAL_ROW_REASON);
    expect(tiles[1]?.unavailableReason).toBe(NO_MARGINAL_ROW_REASON);
  });

  it('states a marginal of zero as zero, which is a measurement rather than an absence', () => {
    const tiles = headlineFigures(TWO_CAMPAIGNS, SELECTED, ALL_CAMPAIGNS, {
      visitors: { count: 0, overflow: false },
      productEntryClicks: { count: 0, overflow: false },
    });
    expect(tiles[0]?.value).toBe(0);
    expect(tiles[0]?.unavailableReason).toBeNull();
  });

  it('states the figure even where the ladder holds no row for the week at all', () => {
    const tiles = headlineFigures([], SELECTED, ALL_CAMPAIGNS, ONE_PERSON_MARGINALS);
    expect(tiles[0]?.value).toBe(1);
  });
});

describe('headlineFigures with several campaigns selected', () => {
  it('adds the account figures over exactly the campaigns selected', () => {
    const tiles = headlineFigures(
      THREE_CAMPAIGNS,
      SELECTED,
      ['hn-launch', 'x-thread'],
      ONE_PERSON_MARGINALS
    );
    expect(tiles[2]?.value).toBe(42);
  });

  it('leaves an unselected campaign out of the account figures', () => {
    const tiles = headlineFigures(
      THREE_CAMPAIGNS,
      SELECTED,
      ['hn-launch', 'x-thread'],
      ONE_PERSON_MARGINALS
    );
    expect(tiles[3]?.value).toBe(6);
  });

  it('plots the trend over the selected campaigns rather than every campaign', () => {
    const tiles = headlineFigures(
      THREE_CAMPAIGNS,
      SELECTED,
      ['hn-launch', 'x-thread'],
      ONE_PERSON_MARGINALS
    );
    expect(tiles[2]?.spark.map((point) => point.value)).toEqual([42]);
  });

  it('reads the anonymous figures from the marginal, which two campaigns cannot be added over', () => {
    const tiles = headlineFigures(
      THREE_CAMPAIGNS,
      SELECTED,
      ['hn-launch', 'x-thread'],
      ONE_PERSON_MARGINALS
    );
    expect(tiles[0]?.value).toBe(1);
    expect(tiles[0]?.unavailableReason).toBeNull();
  });
});

describe('headlineFigures where the ladder holds no row for the selection', () => {
  it('states no account figure for a week the ladder has no row for', () => {
    const tiles = headlineFigures(
      TWO_CAMPAIGNS,
      isoAt(WEEK_START + 7 * DAY_MS),
      ['hn-launch'],
      NO_MARGINALS
    );
    expect(tiles[2]?.value).toBeNull();
  });

  it('says the ladder held no row rather than giving the marginal’s reason', () => {
    const tiles = headlineFigures(
      TWO_CAMPAIGNS,
      isoAt(WEEK_START + 7 * DAY_MS),
      ['hn-launch'],
      NO_MARGINALS
    );
    expect(tiles[2]?.unavailableReason).toBe(NO_LADDER_ROW_REASON);
  });

  it('states no anonymous figure either while one campaign is selected', () => {
    const tiles = headlineFigures(
      TWO_CAMPAIGNS,
      isoAt(WEEK_START + 7 * DAY_MS),
      ['hn-launch'],
      NO_MARGINALS
    );
    expect(tiles[0]?.value).toBeNull();
    expect(tiles[0]?.unavailableReason).toBe(NO_LADDER_ROW_REASON);
  });

  it('reports the campaign the selection excludes as no row rather than as zero', () => {
    const tiles = headlineFigures(TWO_CAMPAIGNS, SELECTED, ['never-ran'], NO_MARGINALS);
    expect(tiles[2]?.value).toBeNull();
    expect(tiles[2]?.unavailableReason).toBe(NO_LADDER_ROW_REASON);
  });
});

describe('headlineFigures where the ladder counted nobody', () => {
  it('states a row of zero as zero, which is a measurement rather than an absence', () => {
    const tiles = headlineFigures(
      [week({ campaign: 'hn-launch', finished: 0, firstPaid: 0 })],
      SELECTED,
      ['hn-launch'],
      NO_MARGINALS
    );
    expect(tiles[2]?.value).toBe(0);
  });

  it('marks a counted zero available, so the tile draws the figure', () => {
    const tiles = headlineFigures(
      [week({ campaign: 'hn-launch', finished: 0, firstPaid: 0 })],
      SELECTED,
      ['hn-launch'],
      NO_MARGINALS
    );
    expect(tiles[2]?.unavailableReason).toBeNull();
  });
});

describe('headlineFigures sparklines', () => {
  it('plots one point per week present, oldest first', () => {
    const weeks = [
      week({ campaign: 'hn-launch', week: isoAt(WEEK_START - 7 * DAY_MS), finished: 10 }),
      week({ campaign: 'hn-launch', week: isoAt(WEEK_START), finished: 40 }),
    ];
    const tiles = headlineFigures(weeks, SELECTED, ['hn-launch'], NO_MARGINALS);
    expect(tiles[2]?.spark.map((point) => point.value)).toEqual([10, 40]);
  });

  it('draws no sparkline for a figure it will not state', () => {
    const tiles = headlineFigures(TWO_CAMPAIGNS, SELECTED, ALL_CAMPAIGNS, NO_MARGINALS);
    expect(tiles[0]?.spark).toEqual([]);
  });

  it('holds the week on screen alone on a figure read from a marginal, so no line is drawn', () => {
    const weeks = [
      week({ campaign: 'hn-launch', week: isoAt(WEEK_START - 7 * DAY_MS) }),
      week({ campaign: 'hn-launch', week: isoAt(WEEK_START) }),
    ];
    const tiles = headlineFigures(weeks, SELECTED, ALL_CAMPAIGNS, ONE_PERSON_MARGINALS);
    expect(tiles[0]?.spark).toEqual([{ week: SELECTED, value: 1, overflow: false }]);
  });
});

describe('the weeks a file of the leading figures has rows for', () => {
  it('writes every week the ladder rows behind it carry', () => {
    const earlier = isoAt(WEEK_START - 7 * DAY_MS);
    const rows = [week({ week: earlier }), week({ week: isoAt(WEEK_START) })];
    const figures = headlineFigures(rows, SELECTED, ['hn-launch'], NO_MARGINALS);
    expect(headlineFileWeeks(rows, figures)).toEqual([earlier, isoAt(WEEK_START)]);
  });

  it('adds the week a marginal figure was read for, which the ladder may hold no row for', () => {
    const earlier = isoAt(WEEK_START - 7 * DAY_MS);
    const rows = [week({ week: earlier })];
    const figures = headlineFigures(rows, SELECTED, ALL_CAMPAIGNS, ONE_PERSON_MARGINALS);
    expect(headlineFileWeeks(rows, figures)).toEqual([earlier, SELECTED]);
  });

  it('writes a week the ladder and a figure both carry exactly once', () => {
    const rows = [week({ week: isoAt(WEEK_START) })];
    const figures = headlineFigures(rows, SELECTED, ALL_CAMPAIGNS, ONE_PERSON_MARGINALS);
    expect(headlineFileWeeks(rows, figures)).toEqual([SELECTED]);
  });
});

describe('the leading figures as a file', () => {
  it('writes a ceiling column beside a figure whose weeks carry a reading', () => {
    const figures = headlineFigures(
      [week({ visitorsDailySummed: 100_000, visitorsOverflow: true })],
      SELECTED,
      ['hn-launch'],
      NO_MARGINALS
    );
    const csv = toCsv({
      name: 'growth-headline',
      extent: WHOLE_READ,
      rows: headlineWeeks(figures),
      columns: headlineColumns(figures),
    });
    expect(csv).toBe(
      'growth-headline: the read behind this export answered in one page. ' +
        'No campaign selection narrowed these rows.\n' +
        'Week,"Visitors (daily uniques, summed)",' +
        '"Visitors (daily uniques, summed): Ceiling reached",' +
        '"Product entry clicks (hourly uniques, summed)",' +
        '"Product entry clicks (hourly uniques, summed): Ceiling reached",' +
        'Accounts created,First payments\n' +
        `${SELECTED},100000,true,100,false,40,5`
    );
  });

  it('writes a marginal figure under the same name its per-campaign twin carries', () => {
    const figures = headlineFigures(
      ONE_PERSON_TWO_CAMPAIGNS,
      SELECTED,
      ALL_CAMPAIGNS,
      ONE_PERSON_MARGINALS
    );
    const csv = toCsv({
      name: 'growth-headline',
      extent: WHOLE_READ,
      rows: headlineFileWeeks(ONE_PERSON_TWO_CAMPAIGNS, figures),
      columns: headlineColumns(figures),
    });
    expect(csv).toBe(
      'growth-headline: the read behind this export answered in one page. ' +
        'No campaign selection narrowed these rows.\n' +
        'Week,"Visitors (daily uniques, summed)",' +
        '"Visitors (daily uniques, summed): Ceiling reached",' +
        '"Product entry clicks (hourly uniques, summed)",' +
        '"Product entry clicks (hourly uniques, summed): Ceiling reached",' +
        'Accounts created,First payments\n' +
        `${SELECTED},1,false,1,false,1,0`
    );
  });
});

describe('the leading figures as a file, where a figure it is handed is short of a week', () => {
  it('leaves both the count and its ceiling field empty rather than writing a nought', () => {
    const later = isoAt(WEEK_START + 7 * DAY_MS);
    /**
     * Built here rather than returned by {@link headlineFigures}, which reaches
     * this pair only from a ladder and a marginal together. It is the shape the
     * page writes whenever no single campaign is selected over a ladder carrying
     * several weeks: a figure read from a marginal holds its point in the week on
     * screen alone, so its column is empty in every other row of the union the
     * export is handed. {@link toCsv} evaluates every column at every week it is
     * given, including a week the figure behind a column holds no point in; what
     * that column writes there is what this case pins.
     */
    const figures: readonly HeadlineFigure[] = [
      {
        label: 'Visitors (daily uniques, summed)',
        noun: 'Visitors',
        bucketing: 'daily',
        week: SELECTED,
        value: 12,
        unavailableReason: null,
        overflow: false,
        spark: [{ week: SELECTED, value: 12, overflow: false }],
      },
      {
        label: 'Accounts created',
        noun: 'Accounts created',
        bucketing: null,
        week: SELECTED,
        value: 3,
        unavailableReason: null,
        overflow: null,
        spark: [
          { week: SELECTED, value: 3, overflow: null },
          { week: later, value: 4, overflow: null },
        ],
      },
    ];
    const csv = toCsv({
      name: 'growth-headline',
      extent: WHOLE_READ,
      rows: headlineWeeks(figures),
      columns: headlineColumns(figures),
    });
    expect(csv).toBe(
      'growth-headline: the read behind this export answered in one page. ' +
        'No campaign selection narrowed these rows.\n' +
        'Week,"Visitors (daily uniques, summed)",' +
        '"Visitors (daily uniques, summed): Ceiling reached",Accounts created\n' +
        `${SELECTED},12,false,3\n` +
        `${later},,,4`
    );
  });
});

describe('what the headline figure type admits', () => {
  it('refuses a point on a figure it withheld, so a figure carrying a trend is one it stated', () => {
    // @ts-expect-error -- a withheld figure's trend is the empty tuple; if it ever admits a point, the unused directive fails typecheck
    const withheldCarryingAPoint: HeadlineFigure = {
      label: 'Visitors (daily uniques, summed)',
      noun: 'Visitors',
      bucketing: 'daily',
      week: SELECTED,
      value: null,
      unavailableReason: NO_MARGINAL_ROW_REASON,
      overflow: null,
      spark: [{ week: SELECTED, value: 12, overflow: null }],
    };
    expect(withheldCarryingAPoint.value).toBeNull();
  });
});

describe('which leading figures a campaign selection reaches', () => {
  it('names the anonymous figures where the selection names several campaigns', () => {
    expect(figuresOutsideSelection(['hn-launch', 'x-thread'])).toStrictEqual([
      'Visitors (daily uniques, summed)',
      'Product entry clicks (hourly uniques, summed)',
    ]);
  });

  it('names none where the selection names the single campaign every figure follows', () => {
    expect(figuresOutsideSelection(['hn-launch'])).toStrictEqual([]);
  });

  it('names none where nothing is selected, there being no narrowing to be outside of', () => {
    expect(figuresOutsideSelection([])).toStrictEqual([]);
  });
});

describe('what a withheld figure says in place of a number', () => {
  it('states an absent whole-site row as no figure to state rather than a count of none', () => {
    expect(NO_MARGINAL_ROW_REASON).toBe(
      'No whole-site row for this week, so there is no figure to state, not a count of none.'
    );
  });

  it('states an absent ladder row as no figure to state rather than a count of none', () => {
    expect(NO_LADDER_ROW_REASON).toBe(
      'No ladder row for this week under the campaigns selected, so there is no figure to state, not a count of none.'
    );
  });
});
