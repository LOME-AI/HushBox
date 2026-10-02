import {
  pgTable,
  boolean,
  check,
  index,
  integer,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  GROWTH_EVENT_NAME_MAX_LENGTH,
  GROWTH_EVENT_NAME_PATTERN,
  GROWTH_PATH_MAX_LENGTH,
  GROWTH_PATH_PATTERN,
} from '@hushbox/shared';

import { campaigns } from './campaigns';

/**
 * Distinct visitors who fired a named event, per campaign and page, per hour.
 * The name is text under a pattern rather than an enum because it is derived
 * from the marketing page's own markup at build time and validated against the
 * per-page name set the build emits: the closed set exists, but it is a build
 * artefact, not a schema migration.
 *
 * Hour only. There is no day-grain row here because the events panel reads a
 * time series, and a daily unique per event is summed from hours in the read
 * with the summation labelled — no set exists that could fill a day row
 * exactly.
 */
export const growthHourlyEvents = pgTable(
  'growth_hourly_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    campaign: text('campaign')
      .notNull()
      .references(() => campaigns.tag),
    eventName: text('event_name').notNull(),
    path: text('path').notNull(),
    visitors: integer('visitors').notNull(),
    overflow: boolean('overflow').notNull().default(false),
  },
  (table) => [
    unique('growth_hourly_events_hour_campaign_event_path_unique').on(
      table.hour,
      table.campaign,
      table.eventName,
      table.path
    ),
    // eslint-disable-next-line no-secrets/no-secrets -- the table's own name plus the column and the index suffix, not a credential
    index('growth_hourly_events_campaign_idx').on(table.campaign),
    check(
      'growth_hourly_events_hour_utc',
      sql`${table.hour} = date_trunc('hour', ${table.hour}, 'UTC')`
    ),
    check(
      'growth_hourly_events_event_name_format',
      sql`${table.eventName} ~ '${sql.raw(GROWTH_EVENT_NAME_PATTERN)}' and length(${table.eventName}) <= ${sql.raw(String(GROWTH_EVENT_NAME_MAX_LENGTH))}`
    ),
    check(
      'growth_hourly_events_path_format',
      sql`${table.path} ~ '${sql.raw(GROWTH_PATH_PATTERN)}' and length(${table.path}) <= ${sql.raw(String(GROWTH_PATH_MAX_LENGTH))}`
    ),
    check('growth_hourly_events_visitors_non_negative', sql`${table.visitors} >= 0`),
  ]
);
