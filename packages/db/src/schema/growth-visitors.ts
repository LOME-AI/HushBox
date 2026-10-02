import { pgTable, boolean, check, integer, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { growthGrainEnum } from './enums';

/**
 * Unique visitors per bucket, the marginal with no dimension. One table per
 * Redis key family: set cardinalities are not additive across dimensions, so a
 * distinct count over a cross product cannot be derived from the counts of its
 * projections, and every family gets its own exact marginal.
 *
 * Hour rows and day rows share the table because a visitor active in two hours
 * is a member of two hourly sets — hours cannot be summed into a day, so both
 * grains are counted at write time. The bucket check is what makes the grain
 * and the timestamp agree, and it truncates in UTC explicitly: the two-argument
 * `date_trunc` would truncate in the session time zone.
 *
 * `overflow` marks a bucket whose Redis set hit its member ceiling, so a
 * reader can say `100,000+` rather than report the ceiling as the truth.
 * Rows are kept forever: there is no retention job for any growth table.
 */
export const growthVisitors = pgTable(
  'growth_visitors',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    grain: growthGrainEnum('grain').notNull(),
    bucket: timestamp('bucket', { withTimezone: true }).notNull(),
    visitors: integer('visitors').notNull(),
    overflow: boolean('overflow').notNull().default(false),
  },
  (table) => [
    unique('growth_visitors_grain_bucket_unique').on(table.grain, table.bucket),
    check(
      'growth_visitors_bucket_grain',
      sql`${table.bucket} = date_trunc(${table.grain}::text, ${table.bucket}, 'UTC')`
    ),
    check('growth_visitors_visitors_non_negative', sql`${table.visitors} >= 0`),
  ]
);
