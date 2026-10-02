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
import { GROWTH_PATH_MAX_LENGTH, GROWTH_PATH_PATTERN } from '@hushbox/shared';

import { growthGrainEnum } from './enums';

/**
 * Distinct visitors per page per bucket, and how many of them arrived on that
 * page first that day. Both counts live on one row because they come from two
 * sets keyed by the same dimensions, and the landing set is only added to when
 * the view add for the same bucket was accepted — which is what lets
 * `landings <= visitors` be a column check rather than a hope.
 *
 * The path pattern and its length bound are interpolated from the single
 * shared source the beacon validates against, so a value Redis can hold is a
 * value this column can take.
 */
export const growthPaths = pgTable(
  'growth_paths',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    grain: growthGrainEnum('grain').notNull(),
    bucket: timestamp('bucket', { withTimezone: true }).notNull(),
    path: text('path').notNull(),
    visitors: integer('visitors').notNull(),
    landings: integer('landings').notNull(),
    overflow: boolean('overflow').notNull().default(false),
  },
  (table) => [
    unique('growth_paths_grain_bucket_path_unique').on(table.grain, table.bucket, table.path),
    index('growth_paths_path_bucket_idx').on(table.path, table.bucket),
    check(
      'growth_paths_bucket_grain',
      sql`${table.bucket} = date_trunc(${table.grain}::text, ${table.bucket}, 'UTC')`
    ),
    check(
      'growth_paths_path_format',
      sql`${table.path} ~ '${sql.raw(GROWTH_PATH_PATTERN)}' and length(${table.path}) <= ${sql.raw(String(GROWTH_PATH_MAX_LENGTH))}`
    ),
    check('growth_paths_visitors_non_negative', sql`${table.visitors} >= 0`),
    check(
      'growth_paths_landings_within_visitors',
      sql`${table.landings} >= 0 and ${table.landings} <= ${table.visitors}`
    ),
  ]
);
