import { pgView, bigint, boolean, integer, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { anyOverflow } from '../growth-overflow';
import { growthHourlyFunnel } from '../growth-hourly-funnel';
import { ledgerEntries } from '../ledger-entries';
import { payments } from '../payments';
import { usageRecords } from '../usage-records';
import { userAcquisition } from '../user-acquisition';
import { users } from '../users';
import { wallets } from '../wallets';
import type { SQL } from 'drizzle-orm';

/**
 * The weekly ladder itself, as one relation: one anonymous step and the
 * identified steps below it, keyed `(week, campaign)`.
 *
 * **The ladder is cohort-by-creation-week.** Every identified column counts
 * accounts whose own creation week is `week`, wherever in time the step
 * happened — an account created in week one that first pays in week four is
 * counted in week one's `first_paid`. `started` is the exception and is
 * bucketed by the week the registration attempt happened, because no account
 * exists yet to have a creation week. The mismatch is invisible in the output,
 * so it is stated here: reading a row as one cohort's journey is right for
 * every column but `started`, which is that week's traffic, not the cohort's.
 *
 * Nothing here is copied. Every fact stays in the table that owns it and this
 * relation joins at query time, so a refund posted to the ledger changes
 * `revenue_nano_usd` on the next read and no analytics row can disagree.
 * Consequence for the reader: a past week's numbers can change after the fact.
 *
 * A hard-deleted account takes its `user_acquisition` row with it and leaves
 * `started` standing, so `finished` drifts below `started` over time.
 *
 * Exported as SQL rather than reached through {@link growthWeeklyView} because
 * `funnel_weekly` needs the same relation and the generated migration creates
 * views in name order, which would put a dependent view ahead of the one it
 * selects from. One definition, rendered into both.
 */
export function growthWeeklyLadder(): SQL {
  return sql`

    select
      coalesce(started_weeks.week, cohort_weeks.week) as week,
      coalesce(started_weeks.campaign, cohort_weeks.campaign) as campaign,
      coalesce(started_weeks.started, 0) as started,
      coalesce(started_weeks.started_overflow, false) as started_overflow,
      coalesce(cohort_weeks.finished, 0) as finished,
      coalesce(cohort_weeks.verified, 0) as verified,
      coalesce(cohort_weeks.activated, 0) as activated,
      coalesce(cohort_weeks.returned_week_1, 0) as returned_week_1,
      coalesce(cohort_weeks.first_paid, 0) as first_paid,
      coalesce(cohort_weeks.revenue_nano_usd, 0) as revenue_nano_usd
    from (
      select
        date_trunc('week', ${growthHourlyFunnel.hour}, 'UTC') as week,
        ${growthHourlyFunnel.campaign} as campaign,
        sum(${growthHourlyFunnel.registrations})::integer as started,
        ${anyOverflow(growthHourlyFunnel.overflow)} as started_overflow
      from ${growthHourlyFunnel}
      where ${growthHourlyFunnel.step} = 'started'
      group by 1, 2
    ) started_weeks
    full outer join (
      select
        date_trunc('week', ${users.createdAt}, 'UTC') as week,
        ${userAcquisition.campaign} as campaign,
        count(*)::integer as finished,
        (count(*) filter (where ${users.emailVerified}))::integer as verified,
        (count(*) filter (where account_facts.activated))::integer as activated,
        (count(*) filter (where account_facts.returned_week_1))::integer as returned_week_1,
        (count(*) filter (where account_facts.first_paid))::integer as first_paid,
        sum(account_facts.revenue_nano_usd)::bigint as revenue_nano_usd
      from ${userAcquisition}
      join ${users} on ${users.id} = ${userAcquisition.userId}
      join lateral (
        select
          exists (
            select 1 from ${usageRecords}
            where ${usageRecords.senderUserId} = ${users.id}
          ) as activated,
          exists (
            select 1 from ${usageRecords}
            where ${usageRecords.senderUserId} = ${users.id}
              and ${usageRecords.createdAt} >= ${users.createdAt} + interval '7 days'
          ) as returned_week_1,
          exists (
            select 1 from ${payments}
            where ${payments.userId} = ${users.id}
              and ${payments.status} = 'completed'
          ) as first_paid,
          (
            select coalesce(sum(${ledgerEntries.amountNanoUsd}), 0)
            from ${ledgerEntries}
            join ${wallets} on ${wallets.id} = ${ledgerEntries.walletId}
            where ${wallets.userId} = ${users.id}
              and ${wallets.type} = 'purchased'
              and ${ledgerEntries.kind} in ('deposit', 'clawback', 'refund')
          ) as revenue_nano_usd
      ) account_facts on true
      group by 1, 2
    ) cohort_weeks
      on cohort_weeks.week = started_weeks.week
     and cohort_weeks.campaign = started_weeks.campaign
  `;
}

/**
 * The weekly ladder per campaign. Definition, and the cohort-by-creation-week
 * warning that governs how a row is read: {@link growthWeeklyLadder}.
 *
 * Published on the schema barrel for drizzle-kit, which reads the barrel to
 * generate the migration that creates the view; no query selects from it.
 */
export const growthWeeklyView = pgView('growth_weekly', {
  week: timestamp('week', { withTimezone: true }).notNull(),
  campaign: text('campaign').notNull(),
  started: integer('started').notNull(),
  /** An hour this figure sums hit a set ceiling, so the sum is a lower bound. */
  startedOverflow: boolean('started_overflow').notNull(),
  finished: integer('finished').notNull(),
  verified: integer('verified').notNull(),
  activated: integer('activated').notNull(),
  returnedWeek1: integer('returned_week_1').notNull(),
  firstPaid: integer('first_paid').notNull(),
  revenueNanoUsd: bigint('revenue_nano_usd', { mode: 'bigint' }).notNull(),
}).as(growthWeeklyLadder());
