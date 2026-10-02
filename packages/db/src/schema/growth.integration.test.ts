import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import { HOUR_MS, MINUTE_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';
import { refusalConstraint } from './__tests__/shape-helpers';
import {
  campaigns,
  growthCampaignPaths,
  growthDailyPathReach,
  growthGeo,
  growthHourlyEvents,
  growthHourlyFunnel,
  growthPaths,
  growthReferrers,
  growthVisitors,
} from './index';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle'
);

const DAY_BUCKET = new Date(TEST_DAY_START);
const HOUR_BUCKET = new Date(TEST_DAY_START + 13 * HOUR_MS);
const OTHER_HOUR_BUCKET = new Date(TEST_DAY_START + 14 * HOUR_MS);
const UNTRUNCATED = new Date(TEST_DAY_START + 13 * HOUR_MS + MINUTE_MS);
const DAY = isoAt(TEST_DAY_START).slice(0, 10);

/**
 * Dimensions reserved for the tests that prove a unique tuple refuses a
 * duplicate. Each such test inserts its own precursor row, so it passes run
 * alone; the values are distinct from every other test's so the two inserts it
 * makes are the only rows in play.
 */
const DUPLICATE_VISITORS_BUCKET = new Date(TEST_DAY_START + 15 * HOUR_MS);
const DUPLICATE_FUNNEL_HOUR = new Date(TEST_DAY_START + 16 * HOUR_MS);
const DUPLICATE_TAG = 'duplicate-tag';

/** The tag the foreign-key guard mints and deletes, so no seeded row is ever the subject. */
const FK_GUARD_TAG = 'fk-guard';

const TOO_LONG_PATH = `/${'a'.repeat(200)}`;
const TOO_LONG_HOST = `${'a'.repeat(250)}.example.com`;
const TOO_LONG_EVENT_NAME = 'a'.repeat(81);

let db: Database;

beforeAll(async () => {
  db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  await db.delete(growthCampaignPaths);
  await db.delete(growthHourlyEvents);
  await db.delete(growthHourlyFunnel);
  await db.delete(growthVisitors);
  await db.delete(growthPaths);
  await db.delete(growthReferrers);
  await db.delete(growthGeo);
  await db.delete(growthDailyPathReach);
  await db
    .delete(campaigns)
    .where(inArray(campaigns.tag, ['seeded-check', DUPLICATE_TAG, FK_GUARD_TAG]));
  await db.$client.end();
});

describe('campaigns', () => {
  it('ships the two fallback tags the migration seeds', async () => {
    const rows = await db
      .select({ tag: campaigns.tag, status: campaigns.status })
      .from(campaigns)
      .where(inArray(campaigns.tag, ['direct', 'unknown']));
    expect(rows.toSorted((a, b) => a.tag.localeCompare(b.tag))).toEqual([
      { tag: 'direct', status: 'active' },
      { tag: 'unknown', status: 'active' },
    ]);
  });

  it('accepts a tag matching the shared campaign-tag pattern', async () => {
    const [row] = await db
      .insert(campaigns)
      .values({ tag: 'seeded-check', label: 'Seeded check', status: 'active' })
      .returning({ tag: campaigns.tag });
    expect(row?.tag).toBe('seeded-check');
  });

  it('refuses a tag the shared pattern rejects', async () => {
    const refusal = await refusalConstraint(
      db.insert(campaigns).values({ tag: 'Spring_2026', label: 'Spring', status: 'active' })
    );
    expect(refusal).toBe('campaigns_tag_format');
  });

  it('refuses a tag one character past the shared pattern bound', async () => {
    const refusal = await refusalConstraint(
      db.insert(campaigns).values({ tag: 'a'.repeat(41), label: 'Long', status: 'active' })
    );
    expect(refusal).toBe('campaigns_tag_format');
  });

  it('refuses a label one character past its bound', async () => {
    const refusal = await refusalConstraint(
      db.insert(campaigns).values({ tag: 'long-label', label: 'a'.repeat(101), status: 'active' })
    );
    expect(refusal).toBe('campaigns_label_length');
  });

  it('refuses a second row claiming a tag already taken', async () => {
    const row = {
      tag: DUPLICATE_TAG,
      label: 'Duplicate tag',
      status: 'active',
    } satisfies typeof campaigns.$inferInsert;
    await db.insert(campaigns).values(row);

    const refusal = await refusalConstraint(db.insert(campaigns).values(row));
    expect(refusal).toBe('campaigns_tag_unique');
  });
});

describe('growth_visitors', () => {
  it('holds an hour row and a day row for the same traffic', async () => {
    const rows = await db
      .insert(growthVisitors)
      .values([
        { grain: 'hour', bucket: HOUR_BUCKET, visitors: 7 },
        { grain: 'day', bucket: DAY_BUCKET, visitors: 5 },
      ])
      .returning({ grain: growthVisitors.grain, visitors: growthVisitors.visitors });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.grain).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'day',
      'hour',
    ]);
  });

  it('defaults a fresh row to no overflow', async () => {
    const [row] = await db
      .insert(growthVisitors)
      .values({ grain: 'hour', bucket: OTHER_HOUR_BUCKET, visitors: 1 })
      .returning({ overflow: growthVisitors.overflow });
    expect(row?.overflow).toBe(false);
  });

  it('refuses a day-grain bucket carrying an hour', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthVisitors).values({ grain: 'day', bucket: HOUR_BUCKET, visitors: 1 })
    );
    expect(refusal).toBe('growth_visitors_bucket_grain');
  });

  it('refuses an hour-grain bucket carrying a minute', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthVisitors).values({ grain: 'hour', bucket: UNTRUNCATED, visitors: 1 })
    );
    expect(refusal).toBe('growth_visitors_bucket_grain');
  });

  it('truncates the bucket in UTC whatever the session time zone says', async () => {
    const refusal = await refusalConstraint(
      db.transaction(async (tx) => {
        await tx.execute(sql`set local time zone 'America/New_York'`);
        await tx
          .insert(growthVisitors)
          .values({ grain: 'day', bucket: new Date(TEST_DAY_START + 5 * HOUR_MS), visitors: 1 });
      })
    );
    expect(refusal).toBe('growth_visitors_bucket_grain');
  });

  it('refuses a negative visitor count', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthVisitors).values({ grain: 'day', bucket: DAY_BUCKET, visitors: -1 })
    );
    expect(refusal).toBe('growth_visitors_visitors_non_negative');
  });

  it('refuses a second row for a grain and bucket already counted', async () => {
    const row = {
      grain: 'hour',
      bucket: DUPLICATE_VISITORS_BUCKET,
      visitors: 9,
    } satisfies typeof growthVisitors.$inferInsert;
    await db.insert(growthVisitors).values(row);

    const refusal = await refusalConstraint(db.insert(growthVisitors).values(row));
    expect(refusal).toBe('growth_visitors_grain_bucket_unique');
  });
});

describe('growth_paths', () => {
  it('counts views and landings on one row', async () => {
    const [row] = await db
      .insert(growthPaths)
      .values({ grain: 'hour', bucket: HOUR_BUCKET, path: '/welcome', visitors: 4, landings: 3 })
      .returning({ visitors: growthPaths.visitors, landings: growthPaths.landings });
    expect(row).toEqual({ visitors: 4, landings: 3 });
  });

  it('admits the path every page past the dimension ceiling folds into', async () => {
    const [row] = await db
      .insert(growthPaths)
      .values({ grain: 'hour', bucket: HOUR_BUCKET, path: '/other', visitors: 1, landings: 0 })
      .returning({ path: growthPaths.path });
    expect(row?.path).toBe('/other');
  });

  it('refuses a path the shared pattern rejects', async () => {
    const refusal = await refusalConstraint(
      db
        .insert(growthPaths)
        .values({ grain: 'hour', bucket: HOUR_BUCKET, path: '/Welcome', visitors: 1, landings: 0 })
    );
    expect(refusal).toBe('growth_paths_path_format');
  });

  it('refuses a path one character past its length bound', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthPaths).values({
        grain: 'hour',
        bucket: HOUR_BUCKET,
        path: TOO_LONG_PATH,
        visitors: 1,
        landings: 0,
      })
    );
    expect(refusal).toBe('growth_paths_path_format');
  });

  it('refuses more landings than the visitors of the same row', async () => {
    const refusal = await refusalConstraint(
      db
        .insert(growthPaths)
        .values({ grain: 'hour', bucket: HOUR_BUCKET, path: '/pricing', visitors: 2, landings: 3 })
    );
    expect(refusal).toBe('growth_paths_landings_within_visitors');
  });

  it('refuses a negative landing count', async () => {
    const refusal = await refusalConstraint(
      db
        .insert(growthPaths)
        .values({ grain: 'hour', bucket: HOUR_BUCKET, path: '/pricing', visitors: 2, landings: -1 })
    );
    expect(refusal).toBe('growth_paths_landings_within_visitors');
  });

  // `landings >= 0 and landings <= visitors` already implies `visitors >= 0`,
  // so no row violates the visitor bound alone and which of the two Postgres
  // names is its own choice. The declared bound stays because it is the one
  // that survives if the landings column ever moves off this table.
  it('refuses a negative visitor count', async () => {
    const refusal = await refusalConstraint(
      db
        .insert(growthPaths)
        .values({ grain: 'hour', bucket: HOUR_BUCKET, path: '/pricing', visitors: -1, landings: 0 })
    );
    expect([
      'growth_paths_visitors_non_negative',
      'growth_paths_landings_within_visitors',
    ]).toContain(refusal);
  });

  it('refuses a bucket that is not its own grain truncated in UTC', async () => {
    const refusal = await refusalConstraint(
      db
        .insert(growthPaths)
        .values({ grain: 'day', bucket: HOUR_BUCKET, path: '/welcome', visitors: 1, landings: 0 })
    );
    expect(refusal).toBe('growth_paths_bucket_grain');
  });

  it('refuses a second row for a grain, bucket and path already counted', async () => {
    const row = {
      grain: 'hour',
      bucket: HOUR_BUCKET,
      path: '/duplicate-page',
      visitors: 9,
      landings: 0,
    } satisfies typeof growthPaths.$inferInsert;
    await db.insert(growthPaths).values(row);

    const refusal = await refusalConstraint(db.insert(growthPaths).values(row));
    expect(refusal).toBe('growth_paths_grain_bucket_path_unique');
  });
});

describe('growth_referrers', () => {
  it('counts distinct visitors per referring host per page', async () => {
    const [row] = await db
      .insert(growthReferrers)
      .values({
        grain: 'hour',
        bucket: HOUR_BUCKET,
        path: '/welcome',
        referrerHost: 'news.example.com',
        visitors: 2,
      })
      .returning({ referrerHost: growthReferrers.referrerHost });
    expect(row?.referrerHost).toBe('news.example.com');
  });

  it('admits the host every referrer past the dimension ceiling folds into', async () => {
    const [row] = await db
      .insert(growthReferrers)
      .values({
        grain: 'hour',
        bucket: HOUR_BUCKET,
        path: '/welcome',
        referrerHost: 'other',
        visitors: 1,
      })
      .returning({ referrerHost: growthReferrers.referrerHost });
    expect(row?.referrerHost).toBe('other');
  });

  it('refuses a referrer arriving as a full URL rather than a hostname', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthReferrers).values({
        grain: 'hour',
        bucket: HOUR_BUCKET,
        path: '/welcome',
        referrerHost: 'https://news.example.com',
        visitors: 1,
      })
    );
    expect(refusal).toBe('growth_referrers_host_format');
  });

  it('refuses a hostname past the DNS length bound', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthReferrers).values({
        grain: 'hour',
        bucket: HOUR_BUCKET,
        path: '/welcome',
        referrerHost: TOO_LONG_HOST,
        visitors: 1,
      })
    );
    expect(refusal).toBe('growth_referrers_host_format');
  });

  it('refuses a path the shared pattern rejects', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthReferrers).values({
        grain: 'hour',
        bucket: HOUR_BUCKET,
        path: 'welcome',
        referrerHost: 'news.example.com',
        visitors: 1,
      })
    );
    expect(refusal).toBe('growth_referrers_path_format');
  });

  it('refuses a negative visitor count', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthReferrers).values({
        grain: 'hour',
        bucket: HOUR_BUCKET,
        path: '/welcome',
        referrerHost: 'news.example.com',
        visitors: -1,
      })
    );
    expect(refusal).toBe('growth_referrers_visitors_non_negative');
  });

  it('refuses a bucket that is not its own grain truncated in UTC', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthReferrers).values({
        grain: 'day',
        bucket: HOUR_BUCKET,
        path: '/welcome',
        referrerHost: 'news.example.com',
        visitors: 1,
      })
    );
    expect(refusal).toBe('growth_referrers_bucket_grain');
  });

  it('refuses a second row for a grain, bucket, path and host already counted', async () => {
    const row = {
      grain: 'hour',
      bucket: HOUR_BUCKET,
      path: '/welcome',
      referrerHost: 'duplicate.example.com',
      visitors: 9,
    } satisfies typeof growthReferrers.$inferInsert;
    await db.insert(growthReferrers).values(row);

    const refusal = await refusalConstraint(db.insert(growthReferrers).values(row));
    expect(refusal).toBe('growth_referrers_grain_bucket_path_host_unique');
  });
});

describe('growth_campaign_paths', () => {
  it('counts distinct visitors per campaign per page', async () => {
    const [row] = await db
      .insert(growthCampaignPaths)
      .values({
        grain: 'hour',
        bucket: HOUR_BUCKET,
        campaign: 'direct',
        path: '/welcome',
        visitors: 3,
      })
      .returning({ campaign: growthCampaignPaths.campaign });
    expect(row?.campaign).toBe('direct');
  });

  it('refuses a campaign tag no campaigns row claims', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthCampaignPaths).values({
        grain: 'hour',
        bucket: HOUR_BUCKET,
        campaign: 'never-minted',
        path: '/welcome',
        visitors: 1,
      })
    );
    expect(refusal).toBe('growth_campaign_paths_campaign_campaigns_tag_fk');
  });

  it('refuses a path the shared pattern rejects', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthCampaignPaths).values({
        grain: 'hour',
        bucket: HOUR_BUCKET,
        campaign: 'direct',
        path: '/wel come',
        visitors: 1,
      })
    );
    expect(refusal).toBe('growth_campaign_paths_path_format');
  });

  it('refuses a negative visitor count', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthCampaignPaths).values({
        grain: 'hour',
        bucket: HOUR_BUCKET,
        campaign: 'direct',
        path: '/welcome',
        visitors: -1,
      })
    );
    expect(refusal).toBe('growth_campaign_paths_visitors_non_negative');
  });

  it('refuses a bucket that is not its own grain truncated in UTC', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthCampaignPaths).values({
        grain: 'day',
        bucket: HOUR_BUCKET,
        campaign: 'direct',
        path: '/welcome',
        visitors: 1,
      })
    );
    expect(refusal).toBe('growth_campaign_paths_bucket_grain');
  });

  it('refuses a second row for a grain, bucket, campaign and path already counted', async () => {
    const row = {
      grain: 'hour',
      bucket: HOUR_BUCKET,
      campaign: 'direct',
      path: '/duplicate-campaign-page',
      visitors: 9,
    } satisfies typeof growthCampaignPaths.$inferInsert;
    await db.insert(growthCampaignPaths).values(row);

    const refusal = await refusalConstraint(db.insert(growthCampaignPaths).values(row));
    expect(refusal).toBe('growth_campaign_paths_grain_bucket_campaign_path_unique');
  });
});

describe('growth_geo', () => {
  it('keeps a state alongside the country that resolves to states', async () => {
    const [row] = await db
      .insert(growthGeo)
      .values({
        grain: 'hour',
        bucket: HOUR_BUCKET,
        country: 'US',
        region: 'CA',
        device: 'desktop',
        visitors: 6,
      })
      .returning({ country: growthGeo.country, region: growthGeo.region });
    expect(row).toEqual({ country: 'US', region: 'CA' });
  });

  it('defaults an unresolved location to the empty country and region', async () => {
    const [row] = await db
      .insert(growthGeo)
      .values({ grain: 'hour', bucket: HOUR_BUCKET, device: 'mobile', visitors: 1 })
      .returning({ country: growthGeo.country, region: growthGeo.region });
    expect(row).toEqual({ country: '', region: '' });
  });

  it('refuses a region under any country but the one that resolves to states', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthGeo).values({
        grain: 'hour',
        bucket: HOUR_BUCKET,
        country: 'GB',
        region: 'EN',
        device: 'desktop',
        visitors: 1,
      })
    );
    expect(refusal).toBe('growth_geo_region_requires_us');
  });

  it('refuses a country that is neither two uppercase letters nor empty', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthGeo).values({
        grain: 'hour',
        bucket: HOUR_BUCKET,
        country: 'us',
        device: 'desktop',
        visitors: 1,
      })
    );
    expect(refusal).toBe('growth_geo_country_format');
  });

  it('refuses a region that is neither two uppercase letters nor empty', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthGeo).values({
        grain: 'hour',
        bucket: HOUR_BUCKET,
        country: 'US',
        region: 'CAL',
        device: 'desktop',
        visitors: 1,
      })
    );
    expect(refusal).toBe('growth_geo_region_format');
  });

  it('refuses a negative visitor count', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthGeo).values({
        grain: 'hour',
        bucket: HOUR_BUCKET,
        country: 'US',
        region: 'CA',
        device: 'tablet',
        visitors: -1,
      })
    );
    expect(refusal).toBe('growth_geo_visitors_non_negative');
  });

  it('refuses a bucket that is not its own grain truncated in UTC', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthGeo).values({
        grain: 'day',
        bucket: HOUR_BUCKET,
        country: 'US',
        region: 'CA',
        device: 'other',
        visitors: 1,
      })
    );
    expect(refusal).toBe('growth_geo_bucket_grain');
  });

  it('refuses a second row for a grain, bucket, country, region and device already counted', async () => {
    const row = {
      grain: 'hour',
      bucket: HOUR_BUCKET,
      country: 'US',
      region: 'NY',
      device: 'tablet',
      visitors: 9,
    } satisfies typeof growthGeo.$inferInsert;
    await db.insert(growthGeo).values(row);

    const refusal = await refusalConstraint(db.insert(growthGeo).values(row));
    expect(refusal).toBe('growth_geo_grain_bucket_country_region_device_unique');
  });
});

describe('growth_daily_path_reach', () => {
  it('counts a same-day journey from a landing page to another page', async () => {
    const [row] = await db
      .insert(growthDailyPathReach)
      .values({ day: DAY, landingPath: '/welcome', reachedPath: '/pricing', visitors: 2 })
      .returning({ day: growthDailyPathReach.day });
    expect(row?.day).toBe(DAY);
  });

  it('refuses a landing path the shared pattern rejects', async () => {
    const refusal = await refusalConstraint(
      db
        .insert(growthDailyPathReach)
        .values({ day: DAY, landingPath: 'welcome', reachedPath: '/pricing', visitors: 1 })
    );
    expect(refusal).toBe('growth_daily_path_reach_landing_path_format');
  });

  it('refuses a reached path one character past its length bound', async () => {
    const refusal = await refusalConstraint(
      db
        .insert(growthDailyPathReach)
        .values({ day: DAY, landingPath: '/welcome', reachedPath: TOO_LONG_PATH, visitors: 1 })
    );
    expect(refusal).toBe('growth_daily_path_reach_reached_path_format');
  });

  it('refuses a negative visitor count', async () => {
    const refusal = await refusalConstraint(
      db
        .insert(growthDailyPathReach)
        .values({ day: DAY, landingPath: '/welcome', reachedPath: '/privacy', visitors: -1 })
    );
    expect(refusal).toBe('growth_daily_path_reach_visitors_non_negative');
  });

  it('refuses a second row for a day, landing page and reached page already counted', async () => {
    const row = {
      day: DAY,
      landingPath: '/duplicate-landing',
      reachedPath: '/duplicate-reached',
      visitors: 9,
    } satisfies typeof growthDailyPathReach.$inferInsert;
    await db.insert(growthDailyPathReach).values(row);

    const refusal = await refusalConstraint(db.insert(growthDailyPathReach).values(row));
    expect(refusal).toBe('growth_daily_path_reach_day_landing_reached_unique');
  });
});

describe('growth_hourly_events', () => {
  it('counts distinct visitors who fired an auto-captured event', async () => {
    const [row] = await db
      .insert(growthHourlyEvents)
      .values({
        hour: HOUR_BUCKET,
        campaign: 'direct',
        eventName: 'link:/signup',
        path: '/welcome',
        visitors: 3,
      })
      .returning({ eventName: growthHourlyEvents.eventName });
    expect(row?.eventName).toBe('link:/signup');
  });

  it('refuses an hour carrying a minute', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthHourlyEvents).values({
        hour: UNTRUNCATED,
        campaign: 'direct',
        eventName: 'link:/signup',
        path: '/welcome',
        visitors: 1,
      })
    );
    expect(refusal).toBe('growth_hourly_events_hour_utc');
  });

  it('refuses an event name the shared pattern rejects', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthHourlyEvents).values({
        hour: HOUR_BUCKET,
        campaign: 'direct',
        eventName: 'Start Free Trial',
        path: '/welcome',
        visitors: 1,
      })
    );
    expect(refusal).toBe('growth_hourly_events_event_name_format');
  });

  it('refuses an event name one character past its length bound', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthHourlyEvents).values({
        hour: HOUR_BUCKET,
        campaign: 'direct',
        eventName: TOO_LONG_EVENT_NAME,
        path: '/welcome',
        visitors: 1,
      })
    );
    expect(refusal).toBe('growth_hourly_events_event_name_format');
  });

  it('refuses a path the shared pattern rejects', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthHourlyEvents).values({
        hour: HOUR_BUCKET,
        campaign: 'direct',
        eventName: 'link:/signup',
        path: '/Welcome',
        visitors: 1,
      })
    );
    expect(refusal).toBe('growth_hourly_events_path_format');
  });

  it('refuses a negative visitor count', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthHourlyEvents).values({
        hour: HOUR_BUCKET,
        campaign: 'direct',
        eventName: 'link:/signup',
        path: '/welcome',
        visitors: -1,
      })
    );
    expect(refusal).toBe('growth_hourly_events_visitors_non_negative');
  });

  it('refuses a campaign tag no campaigns row claims', async () => {
    const refusal = await refusalConstraint(
      db.insert(growthHourlyEvents).values({
        hour: HOUR_BUCKET,
        campaign: 'never-minted',
        eventName: 'link:/signup',
        path: '/welcome',
        visitors: 1,
      })
    );
    expect(refusal).toBe('growth_hourly_events_campaign_campaigns_tag_fk');
  });

  it('refuses a second row for an hour, campaign, event and page already counted', async () => {
    const row = {
      hour: HOUR_BUCKET,
      campaign: 'direct',
      eventName: 'link:/duplicate',
      path: '/welcome',
      visitors: 9,
    } satisfies typeof growthHourlyEvents.$inferInsert;
    await db.insert(growthHourlyEvents).values(row);

    const refusal = await refusalConstraint(db.insert(growthHourlyEvents).values(row));
    expect(refusal).toBe('growth_hourly_events_hour_campaign_event_path_unique');
  });
});

describe('growth_hourly_funnel', () => {
  it('counts registration starts per campaign per hour', async () => {
    const [row] = await db
      .insert(growthHourlyFunnel)
      .values({ hour: HOUR_BUCKET, campaign: 'direct', step: 'started', registrations: 4 })
      .returning({
        step: growthHourlyFunnel.step,
        registrations: growthHourlyFunnel.registrations,
      });
    expect(row).toEqual({ step: 'started', registrations: 4 });
  });

  it('refuses an hour carrying a minute', async () => {
    const refusal = await refusalConstraint(
      db
        .insert(growthHourlyFunnel)
        .values({ hour: UNTRUNCATED, campaign: 'direct', step: 'started', registrations: 1 })
    );
    expect(refusal).toBe('growth_hourly_funnel_hour_utc');
  });

  it('refuses a negative registration count', async () => {
    const refusal = await refusalConstraint(
      db
        .insert(growthHourlyFunnel)
        .values({ hour: OTHER_HOUR_BUCKET, campaign: 'direct', step: 'started', registrations: -1 })
    );
    expect(refusal).toBe('growth_hourly_funnel_registrations_non_negative');
  });

  it('refuses a campaign tag no campaigns row claims', async () => {
    const refusal = await refusalConstraint(
      db
        .insert(growthHourlyFunnel)
        .values({ hour: HOUR_BUCKET, campaign: 'never-minted', step: 'started', registrations: 1 })
    );
    expect(refusal).toBe('growth_hourly_funnel_campaign_campaigns_tag_fk');
  });

  it('refuses a second row for an hour, campaign and step already counted', async () => {
    const row = {
      hour: DUPLICATE_FUNNEL_HOUR,
      campaign: 'direct',
      step: 'started',
      registrations: 9,
    } satisfies typeof growthHourlyFunnel.$inferInsert;
    await db.insert(growthHourlyFunnel).values(row);

    const refusal = await refusalConstraint(db.insert(growthHourlyFunnel).values(row));
    expect(refusal).toBe('growth_hourly_funnel_hour_campaign_step_unique');
  });
});

describe('the campaign a growth row references', () => {
  // The subject is a tag this test mints, never a seeded one: a fallback tag is
  // the referent of rows kept forever, so a test that could delete one would
  // corrupt the seeded data on any run where the delete were to succeed.
  it('cannot be deleted while a growth row still points at its tag', async () => {
    await db
      .insert(campaigns)
      .values({ tag: FK_GUARD_TAG, label: 'Foreign key guard', status: 'active' });
    await db.insert(growthCampaignPaths).values({
      grain: 'hour',
      bucket: HOUR_BUCKET,
      campaign: FK_GUARD_TAG,
      path: '/welcome',
      visitors: 1,
    });

    const refusal = await refusalConstraint(
      db.delete(campaigns).where(eq(campaigns.tag, FK_GUARD_TAG))
    );
    expect(refusal).toBe('growth_campaign_paths_campaign_campaigns_tag_fk');
  });
});
