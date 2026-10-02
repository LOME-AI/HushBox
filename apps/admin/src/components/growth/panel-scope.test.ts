import { describe, expect, it } from 'vitest';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { campaignNarrowedExcept, panelScopeChips, panelScopeNote } from './panel-scope.js';
import type { CampaignScope, PanelScope } from './panel-scope.js';

const NARROWS: CampaignScope = { kind: 'narrowed' };

/** Two days an operator could name, neither of them the day the clock stands on. */
const RANGE_START = isoAt(TEST_DAY_START - 13 * DAY_MS).slice(0, 10);
const RANGE_END = isoAt(TEST_DAY_START - 7 * DAY_MS).slice(0, 10);

describe('panelScopeNote', () => {
  it('states nothing when both controls reach the panel', () => {
    expect(panelScopeNote({ campaigns: NARROWS, window: { kind: 'selected-week' } })).toBeNull();
  });

  it('says the counts carry no campaign where the read has no such dimension', () => {
    expect(
      panelScopeNote({
        campaigns: { kind: 'every-campaign', reason: 'no-campaign-dimension' },
        window: { kind: 'selected-week' },
      })
    ).toBe('Counts every campaign, not the selection above: these counts carry no campaign.');
  });

  it('asks for a single campaign where the read takes one at a time', () => {
    expect(
      panelScopeNote({
        campaigns: { kind: 'every-campaign', reason: 'one-at-a-time' },
        window: { kind: 'selected-week' },
      })
    ).toBe(
      'Counts every campaign, not the selection above: this read narrows to one campaign at a time. Select a single campaign to scope it.'
    );
  });

  it('says the data edge carries no campaign where the panel states a day rather than counts', () => {
    expect(
      panelScopeNote({
        campaigns: { kind: 'every-campaign', reason: 'edge-carries-no-campaign' },
        window: { kind: 'selected-week' },
      })
    ).toBe(
      'Covers every campaign, not the selection above: the edge of the data carries no campaign.'
    );
  });

  it('names the figures a selection reaches and the ones it does not', () => {
    expect(
      panelScopeNote({
        campaigns: campaignNarrowedExcept('one-at-a-time', ['Visitors (daily uniques, summed)']),
        window: { kind: 'selected-week' },
      })
    ).toBe(
      'The selection above reaches every figure here but Visitors (daily uniques, summed), which count every campaign: a count of distinct visitors narrows to one campaign at a time. Select a single campaign to scope them.'
    );
  });

  it('names each figure a selection leaves out where it leaves out more than one', () => {
    expect(
      panelScopeNote({
        campaigns: campaignNarrowedExcept('one-at-a-time', [
          'Visitors (daily uniques, summed)',
          'Product entry clicks (hourly uniques, summed)',
        ]),
        window: { kind: 'selected-week' },
      })
    ).toContain(
      'but Visitors (daily uniques, summed) and Product entry clicks (hourly uniques, summed), which count every campaign'
    );
  });

  it('states nothing where the selection reaches every figure the panel carries', () => {
    expect(
      panelScopeNote({
        campaigns: campaignNarrowedExcept('one-at-a-time', []),
        window: { kind: 'selected-week' },
      })
    ).toBeNull();
  });

  it('names the campaign column where the rows carry one the read does not narrow by', () => {
    expect(
      panelScopeNote({
        campaigns: { kind: 'every-campaign', reason: 'not-narrowed' },
        window: { kind: 'selected-week' },
      })
    ).toBe(
      'Counts every campaign, not the selection above: the campaign column says which, and this read is not narrowed by the selection.'
    );
  });

  it('says the roster is not what the selection scopes', () => {
    expect(
      panelScopeNote({
        campaigns: { kind: 'every-campaign', reason: 'is-the-list' },
        window: { kind: 'selected-week' },
      })
    ).toBe(
      'Lists every campaign, not the selection above: the selection scopes the panels, not this list.'
    );
  });

  it('names a span counted in weeks', () => {
    expect(
      panelScopeNote({ campaigns: NARROWS, window: { kind: 'recent-weeks', weeks: 12 } })
    ).toBe('Covers the last 12 weeks, not the week selected above.');
  });

  it('names a span counted in days', () => {
    expect(panelScopeNote({ campaigns: NARROWS, window: { kind: 'recent-days', days: 90 } })).toBe(
      'Covers the last 90 days, not the week selected above.'
    );
  });

  it('names the first and last day of a range an operator set', () => {
    expect(
      panelScopeNote({
        campaigns: NARROWS,
        window: { kind: 'day-range', startDay: RANGE_START, endDay: RANGE_END },
      })
    ).toBe(`Covers ${RANGE_START} to ${RANGE_END}, the range set above.`);
  });

  it('says a panel with no window of its own is not limited to the selected week', () => {
    expect(panelScopeNote({ campaigns: NARROWS, window: { kind: 'unwindowed' } })).toBe(
      'Not limited to the week selected above.'
    );
  });

  it('states both halves when neither control reaches the panel', () => {
    expect(
      panelScopeNote({
        campaigns: { kind: 'every-campaign', reason: 'no-campaign-dimension' },
        window: { kind: 'recent-days', days: 90 },
      })
    ).toBe(
      'Counts every campaign, not the selection above: these counts carry no campaign. Covers the last 90 days, not the week selected above.'
    );
  });
});

describe('panelScopeChips', () => {
  it('states no chip where both controls reach the panel', () => {
    expect(
      panelScopeChips({ campaigns: NARROWS, window: { kind: 'selected-week' } })
    ).toStrictEqual([]);
  });

  it('shows what the campaigns cover, with the whole clause behind it', () => {
    expect(
      panelScopeChips({
        campaigns: { kind: 'every-campaign', reason: 'no-campaign-dimension' },
        window: { kind: 'selected-week' },
      })
    ).toStrictEqual([
      {
        subject: 'Every campaign',
        clause: 'Counts every campaign, not the selection above: these counts carry no campaign.',
      },
    ]);
  });

  it('shows a read that takes one campaign at a time as the limit it is', () => {
    expect(
      panelScopeChips({
        campaigns: { kind: 'every-campaign', reason: 'one-at-a-time' },
        window: { kind: 'selected-week' },
      })[0]?.subject
    ).toBe('One campaign at a time');
  });

  it('names the figures a selection does not reach in the chip itself', () => {
    expect(
      panelScopeChips({
        campaigns: campaignNarrowedExcept('one-at-a-time', [
          'Visitors (daily uniques, summed)',
          'Product entry clicks (hourly uniques, summed)',
        ]),
        window: { kind: 'selected-week' },
      })[0]?.subject
    ).toBe(
      'Every campaign: Visitors (daily uniques, summed) and Product entry clicks (hourly uniques, summed)'
    );
  });

  it('names the span a panel covers where the week picker does not reach it', () => {
    expect(
      panelScopeChips({ campaigns: NARROWS, window: { kind: 'recent-days', days: 90 } })
    ).toStrictEqual([
      {
        subject: 'Last 90 days',
        clause: 'Covers the last 90 days, not the week selected above.',
      },
    ]);
  });

  it('names a span counted in weeks', () => {
    expect(
      panelScopeChips({ campaigns: NARROWS, window: { kind: 'recent-weeks', weeks: 12 } })[0]
        ?.subject
    ).toBe('Last 12 weeks');
  });

  it('names both days of a range an operator set', () => {
    expect(
      panelScopeChips({
        campaigns: NARROWS,
        window: { kind: 'day-range', startDay: RANGE_START, endDay: RANGE_END },
      })[0]?.subject
    ).toBe(`${RANGE_START} to ${RANGE_END}`);
  });

  it('states a panel with no window of its own as covering every week', () => {
    expect(
      panelScopeChips({ campaigns: NARROWS, window: { kind: 'unwindowed' } })[0]?.subject
    ).toBe('Every week');
  });

  it('states one chip per control that does not reach the panel', () => {
    expect(
      panelScopeChips({
        campaigns: { kind: 'every-campaign', reason: 'no-campaign-dimension' },
        window: { kind: 'recent-days', days: 90 },
      }).map((chip) => chip.subject)
    ).toStrictEqual(['Every campaign', 'Last 90 days']);
  });

  it('carries exactly the clauses the panel states, so neither can drift from the other', () => {
    const scope: PanelScope = {
      campaigns: { kind: 'every-campaign', reason: 'is-the-list' },
      window: { kind: 'unwindowed' },
    };
    expect(
      panelScopeChips(scope)
        .map((chip) => chip.clause)
        .join(' ')
    ).toBe(panelScopeNote(scope));
  });
});
