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

import { campaigns } from './campaigns';
import { growthFunnelStepEnum } from './enums';

/**
 * Registration starts per campaign per hour. The count is a cardinality of
 * caller-address identifiers, not of visitor hashes: the registration route
 * belongs to the identified half of the system and never sees a visitor hash,
 * which is the seam that keeps the anonymous half unjoinable to an account.
 *
 * `finished` is deliberately absent as a step — a completed registration is an
 * account row, so the fact has one home and is joined at read time.
 */
export const growthHourlyFunnel = pgTable(
  'growth_hourly_funnel',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    campaign: text('campaign')
      .notNull()
      .references(() => campaigns.tag),
    step: growthFunnelStepEnum('step').notNull(),
    registrations: integer('registrations').notNull(),
    overflow: boolean('overflow').notNull().default(false),
  },
  (table) => [
    unique('growth_hourly_funnel_hour_campaign_step_unique').on(
      table.hour,
      table.campaign,
      table.step
    ),
    index('growth_hourly_funnel_campaign_idx').on(table.campaign),
    check(
      'growth_hourly_funnel_hour_utc',
      sql`${table.hour} = date_trunc('hour', ${table.hour}, 'UTC')`
    ),
    check('growth_hourly_funnel_registrations_non_negative', sql`${table.registrations} >= 0`),
  ]
);
