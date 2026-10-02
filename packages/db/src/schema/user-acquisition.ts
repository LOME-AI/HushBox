import { pgTable, check, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { campaigns } from './campaigns';
import { devicePlatformEnum, growthChannelEnum, growthSelfReportContextEnum } from './enums';
import { users } from './users';

/**
 * Where one account came from: the campaign tag its signup link carried, the
 * platform it was created on, and — if the account holder ever answers the
 * optional question — the channel they name and when they named it.
 *
 * The row goes with the account, which is what makes "deleted with your
 * account" true by construction rather than by a deletion step anyone has to
 * remember. It holds no landing path and no referrer host: recording either
 * would mean the signup page reading its own path and `document.referrer`, and
 * it carries no creation timestamp because the account row's own is written in
 * the same transaction.
 */
export const userAcquisition = pgTable(
  'user_acquisition',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    campaign: text('campaign')
      .notNull()
      .references(() => campaigns.tag),
    platform: devicePlatformEnum('platform').notNull(),
    selfReportedChannel: growthChannelEnum('self_reported_channel'),
    selfReportedContext: growthSelfReportContextEnum('self_reported_context'),
    selfReportedAt: timestamp('self_reported_at', { withTimezone: true }),
    // The last moment the question was skipped, not a set: the two contexts are
    // ordered in time, so `first_payment` already says both were skipped.
    selfReportSkipped: growthSelfReportContextEnum('self_report_skipped'),
  },
  (table) => [
    index('user_acquisition_campaign_idx').on(table.campaign),
    check(
      'user_acquisition_self_report_complete',
      sql`(${table.selfReportedChannel} is null) = (${table.selfReportedContext} is null)
        and (${table.selfReportedChannel} is null) = (${table.selfReportedAt} is null)`
    ),
  ]
);
