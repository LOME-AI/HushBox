import { pgView, boolean, integer, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { GROWTH_PRODUCT_ENTRY_FAMILY } from '@hushbox/shared';

import { growthCampaignPaths } from '../growth-campaign-paths';
import { growthGeo } from '../growth-geo';
import { growthHourlyProductEntry } from '../growth-hourly-product-entry';
import { growthPaths } from '../growth-paths';
import { growthReferrers } from '../growth-referrers';
import { growthVisitors } from '../growth-visitors';
import type { SQL } from 'drizzle-orm';

/**
 * The columns both marketing views carry, in select order. Every family fills
 * the dimensions it owns and leaves the rest null, which is what lets one
 * relation carry marginals without a cross-family join: joining two
 * families would sum uniques across dimensions, and a distinct count over a
 * cross product is not derivable from the counts of its projections.
 *
 * Shared by both views: a view builds its own column instances from these
 * builders, so the two do not alias each other.
 */
const marketingColumns = {
  bucket: timestamp('bucket', { withTimezone: true }).notNull(),
  family: text('family').notNull(),
  path: text('path'),
  referrerHost: text('referrer_host'),
  campaign: text('campaign'),
  country: text('country'),
  region: text('region'),
  device: text('device'),
  visitors: integer('visitors').notNull(),
  landings: integer('landings'),
  overflow: boolean('overflow').notNull(),
};

/** A SQL literal for a value fixed at build time. A view definition admits no bind parameter, so the value is written into the text. */
function literal(value: string): SQL {
  return sql.raw(`'${value}'`);
}

/**
 * The grain-bearing families at one grain, unioned into the long shape above.
 * `union all`, not `union`: the families are disjoint by construction, and
 * de-duplicating across them would drop a row whose dimensions happened to
 * render alike.
 */
function marketingFamilies(grain: 'hour' | 'day'): SQL {
  const g = literal(grain);
  return sql`
    select
      ${growthVisitors.bucket} as bucket,
      ${literal('total')}::text as family,
      null::text as path,
      null::text as referrer_host,
      null::text as campaign,
      null::text as country,
      null::text as region,
      null::text as device,
      ${growthVisitors.visitors} as visitors,
      null::integer as landings,
      ${growthVisitors.overflow} as overflow
    from ${growthVisitors}
    where ${growthVisitors.grain} = ${g}
    union all
    select
      ${growthPaths.bucket},
      ${literal('path')}::text,
      ${growthPaths.path},
      null::text,
      null::text,
      null::text,
      null::text,
      null::text,
      ${growthPaths.visitors},
      ${growthPaths.landings},
      ${growthPaths.overflow}
    from ${growthPaths}
    where ${growthPaths.grain} = ${g}
    union all
    select
      ${growthReferrers.bucket},
      ${literal('referrer')}::text,
      ${growthReferrers.path},
      ${growthReferrers.referrerHost},
      null::text,
      null::text,
      null::text,
      null::text,
      ${growthReferrers.visitors},
      null::integer,
      ${growthReferrers.overflow}
    from ${growthReferrers}
    where ${growthReferrers.grain} = ${g}
    union all
    select
      ${growthCampaignPaths.bucket},
      ${literal('campaign')}::text,
      ${growthCampaignPaths.path},
      null::text,
      ${growthCampaignPaths.campaign},
      null::text,
      null::text,
      null::text,
      ${growthCampaignPaths.visitors},
      null::integer,
      ${growthCampaignPaths.overflow}
    from ${growthCampaignPaths}
    where ${growthCampaignPaths.grain} = ${g}
    union all
    select
      ${growthGeo.bucket},
      ${literal('geo')}::text,
      null::text,
      null::text,
      null::text,
      ${growthGeo.country},
      ${growthGeo.region},
      ${growthGeo.device}::text,
      ${growthGeo.visitors},
      null::integer,
      ${growthGeo.overflow}
    from ${growthGeo}
    where ${growthGeo.grain} = ${g}
  `;
}

/**
 * Who entered the product in an hour, under no campaign — the one family with
 * no day twin, because nothing counts entrants per day: a day figure summed
 * from hours would count one person once per hour they clicked in. The daily
 * view therefore carries no row of this family rather than a zero, since a zero
 * would report a measurement nobody took.
 */
function productEntryFamily(): SQL {
  return sql`
    union all
    select
      ${growthHourlyProductEntry.hour},
      ${literal(GROWTH_PRODUCT_ENTRY_FAMILY)}::text,
      null::text,
      null::text,
      null::text,
      null::text,
      null::text,
      null::text,
      ${growthHourlyProductEntry.visitors},
      null::integer,
      ${growthHourlyProductEntry.overflow}
    from ${growthHourlyProductEntry}
  `;
}

/**
 * Every hourly marketing marginal in one relation. Anonymous throughout: the
 * grain tables it reads hold counts under dimensions and never an identifier,
 * so no row here can be joined to an account.
 */
export const marketingHourlyView = pgView('marketing_hourly', marketingColumns).as(
  sql`${marketingFamilies('hour')}${productEntryFamily()}`
);

/**
 * The daily twin. A day row is its own set cardinality, never a sum of its
 * hours: a visitor active at nine and again at two is a member of two hourly
 * sets, so the rollup counts both grains at write time instead.
 */
export const marketingDailyView = pgView('marketing_daily', marketingColumns).as(
  marketingFamilies('day')
);
