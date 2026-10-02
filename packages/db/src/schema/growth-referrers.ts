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
  GROWTH_HOST_MAX_LENGTH,
  GROWTH_HOST_PATTERN,
  GROWTH_PATH_MAX_LENGTH,
  GROWTH_PATH_PATTERN,
} from '@hushbox/shared';

import { growthGrainEnum } from './enums';

/**
 * Distinct visitors per referring host per landing page per bucket. The host
 * pattern admits no `:` and no `/`, which is how a referrer arriving as a full
 * URL is refused rather than stored; it also admits the value `other`, the
 * fold every host past the family's per-bucket dimension ceiling becomes, so an
 * attacker-chosen host cannot mint unbounded rows.
 */
export const growthReferrers = pgTable(
  'growth_referrers',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    grain: growthGrainEnum('grain').notNull(),
    bucket: timestamp('bucket', { withTimezone: true }).notNull(),
    path: text('path').notNull(),
    referrerHost: text('referrer_host').notNull(),
    visitors: integer('visitors').notNull(),
    overflow: boolean('overflow').notNull().default(false),
  },
  (table) => [
    unique('growth_referrers_grain_bucket_path_host_unique').on(
      table.grain,
      table.bucket,
      table.path,
      table.referrerHost
    ),
    index('growth_referrers_host_bucket_idx').on(table.referrerHost, table.bucket),
    check(
      'growth_referrers_bucket_grain',
      sql`${table.bucket} = date_trunc(${table.grain}::text, ${table.bucket}, 'UTC')`
    ),
    check(
      'growth_referrers_path_format',
      sql`${table.path} ~ '${sql.raw(GROWTH_PATH_PATTERN)}' and length(${table.path}) <= ${sql.raw(String(GROWTH_PATH_MAX_LENGTH))}`
    ),
    check(
      'growth_referrers_host_format',
      sql`${table.referrerHost} ~ '${sql.raw(GROWTH_HOST_PATTERN)}' and length(${table.referrerHost}) <= ${sql.raw(String(GROWTH_HOST_MAX_LENGTH))}`
    ),
    check('growth_referrers_visitors_non_negative', sql`${table.visitors} >= 0`),
  ]
);
