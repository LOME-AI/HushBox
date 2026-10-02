import { pgView, bigint, boolean, integer, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { PRODUCT_ENTRY_ROUTES, productEntryEventNames } from '@hushbox/shared';

import { anyOverflow } from '../growth-overflow';
import { growthCampaignPaths } from '../growth-campaign-paths';
import { growthHourlyEvents } from '../growth-hourly-events';
import { growthWeeklyLadder } from './growth-weekly';

/**
 * The `in` list of the entry step's event names. Quoting is safe without
 * escaping because every name has already passed the event-name pattern, which
 * admits no quote — and an unquotable name is what the derivation refuses.
 */
const ENTRY_EVENT_NAMES = sql.raw(
  productEntryEventNames(PRODUCT_ENTRY_ROUTES)
    .map((name) => `'${name}'`)
    .join(', ')
);

/**
 * The ladder per campaign per week: the steps counted from anonymous sets above
 * the ones counted from accounts, plus the revenue the cohort brought in.
 * Which steps are which: `ANONYMOUS_STEP_NOTE` in
 * `packages/shared/src/growth/funnel-steps.ts`.
 *
 * **The ladder is cohort-by-creation-week.** `finished` and everything below
 * it count accounts whose creation week is `week`; every step above them is
 * bucketed by the week its own events happened. A row is therefore not one
 * cohort's journey end to end, and the column names say which columns are
 * which.
 *
 * **A step whose bucket holds more than one row is a weekly sum of bucket
 * maxima, never a weekly unique, and it sums across no dimension** —
 * `BUCKET_MAXIMUM_NOTE` in `packages/shared/src/growth/funnel-steps.ts`, plus
 * the reason a dimension cannot be summed over: a distinct count over a cross
 * product cannot be derived from the counts of its projections. The maximum is
 * the busiest row for that campaign in the day, or in the hour among the rows
 * the step admits. Such a step carries the ceiling flag of every row it
 * aggregated, through {@link anyOverflow}, so a figure a ceiling cut off is not
 * reported as a total. The reduction sits inside the filter that chooses those
 * rows, so a ceiling hit by a row the step never counts marks nothing.
 *
 * **The entry step counts every destination that means entering the product**,
 * which is what `PRODUCT_ENTRY_ROUTES` names and this view derives its filter
 * from. Because the step is computed here rather than stored, the list a
 * replaced view carries governs the weeks already recorded as well as the ones
 * to come.
 */
export const funnelWeeklyView = pgView('funnel_weekly', {
  week: timestamp('week', { withTimezone: true }).notNull(),
  campaign: text('campaign').notNull(),
  visitorsDailySummed: integer('visitors_daily_summed').notNull(),
  /** A day this figure sums hit a set ceiling, so the sum is a lower bound. */
  visitorsOverflow: boolean('visitors_overflow').notNull(),
  productEntryClicksHourlySummed: integer('product_entry_clicks_hourly_summed').notNull(),
  /** An hour this figure sums hit a set ceiling, so the sum is a lower bound. */
  productEntryClicksOverflow: boolean('product_entry_clicks_overflow').notNull(),
  started: integer('started').notNull(),
  /** An hour this figure sums hit a set ceiling, so the sum is a lower bound. */
  startedOverflow: boolean('started_overflow').notNull(),
  finished: integer('finished').notNull(),
  verified: integer('verified').notNull(),
  activated: integer('activated').notNull(),
  returnedWeek1: integer('returned_week_1').notNull(),
  firstPaid: integer('first_paid').notNull(),
  revenueNanoUsd: bigint('revenue_nano_usd', { mode: 'bigint' }).notNull(),
}).as(
  sql`
    select
      coalesce(anonymous.week, ladder.week) as week,
      coalesce(anonymous.campaign, ladder.campaign) as campaign,
      coalesce(anonymous.visitors_daily_summed, 0) as visitors_daily_summed,
      coalesce(anonymous.visitors_overflow, false) as visitors_overflow,
      coalesce(anonymous.product_entry_clicks_hourly_summed, 0) as product_entry_clicks_hourly_summed,
      coalesce(anonymous.product_entry_clicks_overflow, false) as product_entry_clicks_overflow,
      coalesce(ladder.started, 0) as started,
      coalesce(ladder.started_overflow, false) as started_overflow,
      coalesce(ladder.finished, 0) as finished,
      coalesce(ladder.verified, 0) as verified,
      coalesce(ladder.activated, 0) as activated,
      coalesce(ladder.returned_week_1, 0) as returned_week_1,
      coalesce(ladder.first_paid, 0) as first_paid,
      coalesce(ladder.revenue_nano_usd, 0) as revenue_nano_usd
    from (
      select
        coalesce(campaign_visitors.week, entry_clicks.week) as week,
        coalesce(campaign_visitors.campaign, entry_clicks.campaign) as campaign,
        coalesce(campaign_visitors.total, 0) as visitors_daily_summed,
        coalesce(campaign_visitors.overflow, false) as visitors_overflow,
        coalesce(entry_clicks.total, 0) as product_entry_clicks_hourly_summed,
        coalesce(entry_clicks.overflow, false) as product_entry_clicks_overflow
      from (
        select
          date_trunc('week', campaign_days.bucket, 'UTC') as week,
          campaign_days.campaign as campaign,
          sum(campaign_days.busiest_page)::integer as total,
          ${anyOverflow(sql.raw('campaign_days.day_overflow'))} as overflow
        from (
          select
            ${growthCampaignPaths.bucket} as bucket,
            ${growthCampaignPaths.campaign} as campaign,
            max(${growthCampaignPaths.visitors}) as busiest_page,
            ${anyOverflow(growthCampaignPaths.overflow)} as day_overflow
          from ${growthCampaignPaths}
          where ${growthCampaignPaths.grain} = 'day'
          group by 1, 2
        ) campaign_days
        group by 1, 2
      ) campaign_visitors
      full outer join (
        select
          date_trunc('week', entry_hours.hour, 'UTC') as week,
          entry_hours.campaign as campaign,
          sum(entry_hours.busiest_row)::integer as total,
          ${anyOverflow(sql.raw('entry_hours.hour_overflow'))} as overflow
        from (
          select
            ${growthHourlyEvents.hour} as hour,
            ${growthHourlyEvents.campaign} as campaign,
            max(${growthHourlyEvents.visitors}) as busiest_row,
            ${anyOverflow(growthHourlyEvents.overflow)} as hour_overflow
          from ${growthHourlyEvents}
          where ${growthHourlyEvents.eventName} in (${ENTRY_EVENT_NAMES})
          group by 1, 2
        ) entry_hours
        group by 1, 2
      ) entry_clicks
        on entry_clicks.week = campaign_visitors.week
       and entry_clicks.campaign = campaign_visitors.campaign
    ) anonymous
    full outer join (${growthWeeklyLadder()}) ladder
      on ladder.week = anonymous.week
     and ladder.campaign = anonymous.campaign
  `
);
