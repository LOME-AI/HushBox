import { pgTable, boolean, check, integer, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Distinct visitors who clicked into the product in an hour, under no campaign
 * at all — the marginal across the campaign-keyed rows of
 * `growth_hourly_events`, which is not recoverable from them: a count of
 * distinct people is not additive across a dimension, so one visitor arriving
 * under two tags is one person here and a member of each of those rows.
 *
 * Hour only, like the event family it is the marginal of: the counting store
 * holds an hour set for it and no day set, and a day row summed from hours
 * would count one person once per hour they clicked in.
 *
 * `overflow` marks a bucket whose Redis set hit its member ceiling, so a reader
 * can say `100,000+` rather than report the ceiling as the truth. Rows are kept
 * forever: there is no retention job for any growth table.
 */
export const growthHourlyProductEntry = pgTable(
  'growth_hourly_product_entry',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    visitors: integer('visitors').notNull(),
    overflow: boolean('overflow').notNull().default(false),
  },
  (table) => [
    unique('growth_hourly_product_entry_hour_unique').on(table.hour),
    // Truncated in UTC explicitly: the two-argument `date_trunc` would truncate
    // in the session time zone.
    check(
      'growth_hourly_product_entry_hour_utc',
      sql`${table.hour} = date_trunc('hour', ${table.hour}, 'UTC')`
    ),
    check('growth_hourly_product_entry_visitors_non_negative', sql`${table.visitors} >= 0`),
  ]
);
