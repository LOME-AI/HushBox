import {
  pgTable,
  boolean,
  check,
  integer,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { growthDeviceEnum, growthGrainEnum } from './enums';

/**
 * Distinct visitors per country, US state and device family per bucket. The
 * region is the only sub-country dimension that exists anywhere in the system,
 * and it is kept only for the United States — hence the check pairing the two
 * columns, which makes "a region under any other country" unrepresentable
 * rather than merely unwritten.
 *
 * Both location columns admit the empty string, which is what an unknown,
 * anonymised or non-ISO country resolves to at the beacon; storing `''` rather
 * than null keeps them inside the unique tuple, since null never equals null.
 */
export const growthGeo = pgTable(
  'growth_geo',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    grain: growthGrainEnum('grain').notNull(),
    bucket: timestamp('bucket', { withTimezone: true }).notNull(),
    country: text('country').notNull().default(''),
    region: text('region').notNull().default(''),
    device: growthDeviceEnum('device').notNull(),
    visitors: integer('visitors').notNull(),
    overflow: boolean('overflow').notNull().default(false),
  },
  (table) => [
    unique('growth_geo_grain_bucket_country_region_device_unique').on(
      table.grain,
      table.bucket,
      table.country,
      table.region,
      table.device
    ),
    check(
      'growth_geo_bucket_grain',
      sql`${table.bucket} = date_trunc(${table.grain}::text, ${table.bucket}, 'UTC')`
    ),
    check(
      'growth_geo_country_format',
      sql`${table.country} ~ '^[A-Z]{2}$' or ${table.country} = ''`
    ),
    check('growth_geo_region_format', sql`${table.region} ~ '^[A-Z]{2}$' or ${table.region} = ''`),
    check('growth_geo_region_requires_us', sql`${table.region} = '' or ${table.country} = 'US'`),
    check('growth_geo_visitors_non_negative', sql`${table.visitors} >= 0`),
  ]
);
