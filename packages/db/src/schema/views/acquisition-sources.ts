import { pgView, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { userAcquisition } from '../user-acquisition';
import { users } from '../users';

/**
 * One row per account: where its signup link said it came from, and what the
 * account holder said when asked. `primary_source` prefers the person's own
 * answer over the software's, because the two disagree often and the person is
 * the one who knows.
 *
 * No identifier is projected — no account id, no email, no username — so the
 * relation says how many accounts named each source and nothing about which
 * account named it. Counts come from aggregating these rows.
 */
export const acquisitionSourcesView = pgView('acquisition_sources', {
  userCreatedWeek: timestamp('user_created_week', { withTimezone: true }).notNull(),
  campaign: text('campaign').notNull(),
  selfReportedChannel: text('self_reported_channel'),
  selfReportedContext: text('self_reported_context'),
  primarySource: text('primary_source').notNull(),
}).as(
  sql`
    select
      date_trunc('week', ${users.createdAt}, 'UTC') as user_created_week,
      ${userAcquisition.campaign} as campaign,
      ${userAcquisition.selfReportedChannel}::text as self_reported_channel,
      ${userAcquisition.selfReportedContext}::text as self_reported_context,
      coalesce(${userAcquisition.selfReportedChannel}::text, ${userAcquisition.campaign}) as primary_source
    from ${userAcquisition}
    join ${users} on ${users.id} = ${userAcquisition.userId}
  `
);
