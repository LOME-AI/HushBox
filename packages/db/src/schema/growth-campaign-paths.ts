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

import { campaigns } from './campaigns';
import { growthGrainEnum } from './enums';

/**
 * Distinct visitors per campaign per page per bucket. The campaign column is a
 * foreign key on the tag rather than the campaign's id, because the tag is what
 * travels in the URL and what the beacon validates; the two seeded tags
 * `direct` and `unknown` are what an absent or unrecognised tag folds to, so
 * the column is never null and the join never loses a row.
 */
export const growthCampaignPaths = pgTable(
  'growth_campaign_paths',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    grain: growthGrainEnum('grain').notNull(),
    bucket: timestamp('bucket', { withTimezone: true }).notNull(),
    campaign: text('campaign')
      .notNull()
      .references(() => campaigns.tag),
    path: text('path').notNull(),
    visitors: integer('visitors').notNull(),
    overflow: boolean('overflow').notNull().default(false),
  },
  (table) => [
    unique('growth_campaign_paths_grain_bucket_campaign_path_unique').on(
      table.grain,
      table.bucket,
      table.campaign,
      table.path
    ),
    index('growth_campaign_paths_campaign_idx').on(table.campaign),
    check(
      'growth_campaign_paths_bucket_grain',
      sql`${table.bucket} = date_trunc(${table.grain}::text, ${table.bucket}, 'UTC')`
    ),
    check(
      'growth_campaign_paths_path_format',
      sql`${table.path} ~ '${sql.raw(GROWTH_PATH_PATTERN)}' and length(${table.path}) <= ${sql.raw(String(GROWTH_PATH_MAX_LENGTH))}`
    ),
    check('growth_campaign_paths_visitors_non_negative', sql`${table.visitors} >= 0`),
  ]
);
