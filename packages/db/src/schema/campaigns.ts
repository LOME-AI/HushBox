import { pgTable, check, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { GROWTH_CAMPAIGN_LABEL_MAX_LENGTH, GROWTH_CAMPAIGN_TAG_PATTERN } from '@hushbox/shared';

import { growthCampaignStatusEnum } from './enums';

/**
 * The campaign tags every growth row references. A tag is a label shared by
 * every clicker, never a per-person identifier, and it is archived rather than
 * deleted: growth rows are kept forever and their FK still has to resolve.
 *
 * The tag pattern and the label bound are interpolated from the single shared
 * source rather than retyped: the beacon validates an inbound tag against that
 * same string and the minting operation validates a label against that same
 * bound, so a drift would admit input one layer accepts and the other refuses.
 */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    tag: text('tag').notNull().unique(),
    label: text('label').notNull(),
    status: growthCampaignStatusEnum('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('campaigns_tag_format', sql`${table.tag} ~ '${sql.raw(GROWTH_CAMPAIGN_TAG_PATTERN)}'`),
    check(
      'campaigns_label_length',
      sql`length(${table.label}) <= ${sql.raw(String(GROWTH_CAMPAIGN_LABEL_MAX_LENGTH))}`
    ),
  ]
);
