/**
 * How far the growth data reaches, and what a panel showing nothing means
 * given that.
 *
 * A week-scoped panel is empty in two unrelated situations: the week measured
 * nothing, or the data stops before the week. They look identical on screen.
 * That is the same confusion the panel scope notes exist to remove, one step
 * further in — there between a control and the read it reaches, here between a
 * window and the data inside it.
 *
 * The figure comes from the read that answers over whole data sets rather than
 * from the rows the page's panels hold, and that is the point of it: a figure
 * taken from windowed rows moves when an operator narrows the window, which
 * measures the window rather than the data, and the operator cannot tell which
 * of the two readings they are holding.
 */

import type { GrowthFreshnessWire, GrowthNewestDayWire } from '@hushbox/shared';

/**
 * What the page can state about the edge of its data, by what the read behind
 * it has done: still in flight, failed with a code, or answered with the
 * sentence {@link dataEdgeNote} writes.
 *
 * The three are kept apart because a refusal drawn as the sentence would say
 * the data stops before the week selected while the truth is that the read
 * never answered, in the one line whose whole purpose is to tell those two
 * apart.
 */
export type DataEdgeStatus =
  | { readonly state: 'pending' }
  | { readonly state: 'failed'; readonly code: string }
  | { readonly state: 'answered'; readonly note: string };

/**
 * The day a set's newest value names, whichever kind of day it is. Taking the
 * day alone is sound for ordering the sets against each other and against the
 * week picker; what the day *means* stays on the value, never on this.
 */
function dayNamed(newest: GrowthNewestDayWire): string {
  return newest.grain === 'week' ? newest.weekOpening : newest.runsThrough;
}

/**
 * The newest day the growth data reaches, still carrying the grain that says
 * what kind of day it is, or null where no set holds a row.
 *
 * Where a week opens on the day another set runs through, the day-grained
 * value wins: both are true of that day, and only the day-grained one states a
 * day the data is known to have run to.
 */
export function newestGrowthDay(freshness: GrowthFreshnessWire): GrowthNewestDayWire | null {
  let newest: GrowthNewestDayWire | null = null;
  for (const set of [freshness.funnel, freshness.sources, freshness.marketing, freshness.events]) {
    if (set === null) continue;
    if (newest === null) {
      newest = set;
      continue;
    }
    const day = dayNamed(set);
    const held = dayNamed(newest);
    // Day strings sort chronologically, being fixed-width and most-significant
    // first, so the newest is simply the largest.
    if (day > held || (day === held && set.grain === 'day')) newest = set;
  }
  return newest;
}

/**
 * What the page states about the edge of its data, against the week its
 * week-scoped panels cover.
 *
 * Stated in both cases rather than only where the data is behind. A line that
 * appeared only on old data would make its own absence the healthy signal, and
 * a reader cannot tell an absent line from one that never renders here; stating
 * the day plainly is a fact rather than an alarm, so a dashboard with nothing
 * wrong asks nothing of the operator reading it.
 *
 * The week picker and a week-grouped set's opening day sit on one grid of
 * Mondays — the views bucket weeks with Postgres `date_trunc('week', …, 'UTC')`
 * and the picker in `apps/admin/src/components/growth/growth-window.ts` picks
 * the same Monday — so an opening day earlier than the week selected names a
 * whole week that ends before that week begins.
 */
export function dataEdgeNote(newest: GrowthNewestDayWire | null, selectedWeekDay: string): string {
  if (newest === null)
    return 'No growth data set holds a row yet, so there is no newest day to state.';
  const edge =
    newest.grain === 'week'
      ? `The newest data is in the week beginning ${newest.weekOpening}`
      : `Data runs through ${newest.runsThrough}`;
  if (dayNamed(newest) >= selectedWeekDay) return `${edge}.`;
  return `${edge}, before the week selected: no growth data reaches that week, so a week-scoped panel below is empty for want of data rather than for want of traffic.`;
}
