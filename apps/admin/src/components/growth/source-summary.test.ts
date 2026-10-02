import { describe, expect, it } from 'vitest';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { CHANNEL_LABELS, sourceSummary } from './source-summary.js';
import type { GrowthSourceCountWire } from '@hushbox/shared';

function count(over: Partial<GrowthSourceCountWire>): GrowthSourceCountWire {
  return {
    userCreatedWeek: isoAt(TEST_DAY_START),
    campaign: 'direct',
    selfReportedChannel: null,
    selfReportedContext: null,
    primarySource: 'direct',
    accounts: 1,
    ...over,
  };
}

describe('CHANNEL_LABELS', () => {
  it('gives every closed-set channel a display label', () => {
    expect(CHANNEL_LABELS.friend).toBe('Friend or colleague');
    expect(CHANNEL_LABELS.article).toBe('Article or review');
  });
});

describe('sourceSummary', () => {
  it('counts the accounts that named each channel', () => {
    const summary = sourceSummary([
      count({ selfReportedChannel: 'podcast', primarySource: 'podcast', accounts: 7 }),
      count({ selfReportedChannel: 'search', primarySource: 'search', accounts: 5 }),
    ]);
    expect(summary.rows.find((row) => row.channel === 'podcast')?.answers).toBe(7);
  });

  it('adds the same channel across campaigns into one row', () => {
    const summary = sourceSummary([
      count({
        selfReportedChannel: 'podcast',
        primarySource: 'podcast',
        campaign: 'direct',
        accounts: 7,
      }),
      count({
        selfReportedChannel: 'podcast',
        primarySource: 'podcast',
        campaign: 'hn-launch',
        accounts: 2,
      }),
    ]);
    expect(summary.rows.find((row) => row.channel === 'podcast')?.answers).toBe(9);
  });

  it('keeps the campaign split beside the total', () => {
    const summary = sourceSummary([
      count({
        selfReportedChannel: 'podcast',
        primarySource: 'podcast',
        campaign: 'direct',
        accounts: 7,
      }),
      count({
        selfReportedChannel: 'podcast',
        primarySource: 'podcast',
        campaign: 'hn-launch',
        accounts: 2,
      }),
    ]);
    expect(summary.rows.find((row) => row.channel === 'podcast')?.byCampaign).toEqual([
      { campaign: 'direct', accounts: 7 },
      { campaign: 'hn-launch', accounts: 2 },
    ]);
  });

  it('sorts the answered channels largest first', () => {
    const summary = sourceSummary([
      count({ selfReportedChannel: 'search', primarySource: 'search', accounts: 2 }),
      count({ selfReportedChannel: 'podcast', primarySource: 'podcast', accounts: 9 }),
    ]);
    expect(summary.rows.map((row) => row.channel)).toEqual(['podcast', 'search']);
  });

  it('collects the accounts that named nothing into their own row', () => {
    const summary = sourceSummary([
      count({ selfReportedChannel: 'podcast', primarySource: 'podcast', accounts: 9 }),
      count({ selfReportedChannel: null, primarySource: 'hn-launch', accounts: 17 }),
    ]);
    const unanswered = summary.rows.find((row) => row.channel === null);
    expect(unanswered?.answers).toBe(17);
  });

  it('puts the unanswered row last however large it is', () => {
    const summary = sourceSummary([
      count({ selfReportedChannel: 'podcast', primarySource: 'podcast', accounts: 9 }),
      count({ selfReportedChannel: null, primarySource: 'hn-launch', accounts: 17 }),
    ]);
    expect(summary.rows.at(-1)?.channel).toBeNull();
  });

  it('totals the accounts whose primary source is each channel', () => {
    const summary = sourceSummary([
      count({ selfReportedChannel: 'podcast', primarySource: 'podcast', accounts: 9 }),
    ]);
    expect(summary.rows.find((row) => row.channel === 'podcast')?.primarySourceTotal).toBe(9);
  });

  it('states no primary-source total for the unanswered row, which falls back to its campaign', () => {
    const summary = sourceSummary([
      count({ selfReportedChannel: null, primarySource: 'hn-launch', accounts: 17 }),
    ]);
    expect(summary.rows.find((row) => row.channel === null)?.primarySourceTotal).toBeNull();
  });

  it('reports how many of the accounts answered', () => {
    const summary = sourceSummary([
      count({ selfReportedChannel: 'podcast', primarySource: 'podcast', accounts: 9 }),
      count({ selfReportedChannel: null, primarySource: 'direct', accounts: 17 }),
    ]);
    expect(summary.answered).toBe(9);
    expect(summary.accounts).toBe(26);
  });

  it('reports no answered rate rather than a division by zero when there are no accounts', () => {
    expect(sourceSummary([]).answeredRate).toBeNull();
  });

  it('reports the answered rate as a fraction of all accounts', () => {
    const summary = sourceSummary([
      count({ selfReportedChannel: 'podcast', primarySource: 'podcast', accounts: 1 }),
      count({ selfReportedChannel: null, primarySource: 'direct', accounts: 3 }),
    ]);
    expect(summary.answeredRate).toBe(0.25);
  });
});

describe('sourceSummary when an answer and its primary source disagree', () => {
  it('reports no primary-source accounts rather than an undefined figure', () => {
    const summary = sourceSummary([
      count({ selfReportedChannel: 'podcast', primarySource: 'hn-launch', accounts: 3 }),
    ]);
    expect(summary.rows.find((row) => row.channel === 'podcast')?.primarySourceTotal).toBe(0);
  });
});
