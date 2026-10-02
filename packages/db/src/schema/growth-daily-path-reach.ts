import { pgTable, boolean, check, date, integer, text, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { GROWTH_PATH_MAX_LENGTH, GROWTH_PATH_PATTERN } from '@hushbox/shared';

/**
 * Distinct visitors who landed on one page and reached another the same day.
 * Daily by construction: the landing page is a per-visitor fact recorded once
 * per day, so an hourly row would attribute a journey to an hour its landing
 * never happened in. The counterpart Redis key is day-keyed for the same
 * reason, and there is no hour-grain variant of this table.
 */
export const growthDailyPathReach = pgTable(
  'growth_daily_path_reach',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    day: date('day').notNull(),
    landingPath: text('landing_path').notNull(),
    reachedPath: text('reached_path').notNull(),
    visitors: integer('visitors').notNull(),
    overflow: boolean('overflow').notNull().default(false),
  },
  (table) => [
    unique('growth_daily_path_reach_day_landing_reached_unique').on(
      table.day,
      table.landingPath,
      table.reachedPath
    ),
    check(
      'growth_daily_path_reach_landing_path_format',
      sql`${table.landingPath} ~ '${sql.raw(GROWTH_PATH_PATTERN)}' and length(${table.landingPath}) <= ${sql.raw(String(GROWTH_PATH_MAX_LENGTH))}`
    ),
    check(
      'growth_daily_path_reach_reached_path_format',
      sql`${table.reachedPath} ~ '${sql.raw(GROWTH_PATH_PATTERN)}' and length(${table.reachedPath}) <= ${sql.raw(String(GROWTH_PATH_MAX_LENGTH))}`
    ),
    check('growth_daily_path_reach_visitors_non_negative', sql`${table.visitors} >= 0`),
  ]
);
