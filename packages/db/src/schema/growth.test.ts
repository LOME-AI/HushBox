import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';

import {
  GROWTH_CAMPAIGN_STATUS,
  GROWTH_DEVICE,
  GROWTH_FUNNEL_STEP,
  GROWTH_GRAIN,
} from '@hushbox/shared';

import {
  checkNames,
  column,
  findForeignKey,
  findIndex,
  hasDefault,
  uniqueShapes,
} from './__tests__/shape-helpers';
import * as schema from './index';

describe('growth pgEnums', () => {
  it('derives growth_grain values from the single shared GROWTH_GRAIN source', () => {
    expect(schema.growthGrainEnum.enumValues).toEqual([...GROWTH_GRAIN]);
  });

  it('derives growth_device values from the single shared GROWTH_DEVICE source', () => {
    expect(schema.growthDeviceEnum.enumValues).toEqual([...GROWTH_DEVICE]);
  });

  it('derives growth_campaign_status values from the single shared GROWTH_CAMPAIGN_STATUS source', () => {
    expect(schema.growthCampaignStatusEnum.enumValues).toEqual([...GROWTH_CAMPAIGN_STATUS]);
  });

  it('derives growth_funnel_step values from the single shared GROWTH_FUNNEL_STEP source', () => {
    expect(schema.growthFunnelStepEnum.enumValues).toEqual([...GROWTH_FUNNEL_STEP]);
  });

  it('declares every growth enum in the public pg schema', () => {
    for (const growthEnum of [
      schema.growthGrainEnum,
      schema.growthDeviceEnum,
      schema.growthCampaignStatusEnum,
      schema.growthFunnelStepEnum,
    ]) {
      expect(growthEnum.schema).toBeUndefined();
    }
  });
});

describe('campaigns', () => {
  it('has a uuid primary key defaulting to uuidv7()', () => {
    const id = column(schema.campaigns, 'id');
    expect(id.primary).toBe(true);
    expect(id.getSQLType()).toBe('uuid');
    expect(hasDefault(schema.campaigns, 'id')).toBe(true);
  });

  it('makes the tag unique, so growth rows can reference it', () => {
    expect(column(schema.campaigns, 'tag').isUnique).toBe(true);
  });

  it('constrains the tag to the shared campaign-tag pattern', () => {
    expect(checkNames(schema.campaigns)).toContain('campaigns_tag_format');
  });

  it('bounds the operator-typed label', () => {
    expect(checkNames(schema.campaigns)).toContain('campaigns_label_length');
  });

  it('types the status as the growth_campaign_status enum', () => {
    expect(column(schema.campaigns, 'status').getSQLType()).toBe('growth_campaign_status');
  });

  it('holds exactly the five declared columns', () => {
    expect(getTableConfig(schema.campaigns).columns.map((c) => c.name)).toEqual([
      'id',
      'tag',
      'label',
      'status',
      'created_at',
    ]);
  });

  it('declares no unique constraint beyond the tag column itself', () => {
    expect(uniqueShapes(schema.campaigns)).toEqual([]);
  });
});

describe('growth_visitors', () => {
  it('has a uuid primary key defaulting to uuidv7()', () => {
    const id = column(schema.growthVisitors, 'id');
    expect(id.primary).toBe(true);
    expect(id.getSQLType()).toBe('uuid');
    expect(hasDefault(schema.growthVisitors, 'id')).toBe(true);
  });

  it('carries both grains in one table, typed by the growth_grain enum', () => {
    expect(column(schema.growthVisitors, 'grain').getSQLType()).toBe('growth_grain');
  });

  it('pins the bucket to the UTC truncation of its own grain', () => {
    expect(checkNames(schema.growthVisitors)).toContain('growth_visitors_bucket_grain');
  });

  it('refuses a negative visitor count', () => {
    expect(checkNames(schema.growthVisitors)).toContain('growth_visitors_visitors_non_negative');
  });

  it('makes the grain and bucket pair the rollup conflict target', () => {
    expect(uniqueShapes(schema.growthVisitors)).toEqual([
      { name: 'growth_visitors_grain_bucket_unique', columns: ['grain', 'bucket'] },
    ]);
  });

  it('holds exactly the declared columns', () => {
    expect(getTableConfig(schema.growthVisitors).columns.map((c) => c.name)).toEqual([
      'id',
      'grain',
      'bucket',
      'visitors',
      'overflow',
    ]);
  });
});

describe('growth_paths', () => {
  it('constrains the path to the shared path pattern and its length bound', () => {
    expect(checkNames(schema.growthPaths)).toContain('growth_paths_path_format');
  });

  it('keeps landings within the visitors of the same row', () => {
    expect(checkNames(schema.growthPaths)).toContain('growth_paths_landings_within_visitors');
  });

  it('makes grain, bucket and path the rollup conflict target', () => {
    expect(uniqueShapes(schema.growthPaths)).toEqual([
      { name: 'growth_paths_grain_bucket_path_unique', columns: ['grain', 'bucket', 'path'] },
    ]);
  });

  it('indexes path with bucket for the per-page time series', () => {
    expect(findIndex(schema.growthPaths, 'growth_paths_path_bucket_idx').columns).toEqual([
      'path',
      'bucket',
    ]);
  });

  it('holds exactly the declared columns', () => {
    expect(getTableConfig(schema.growthPaths).columns.map((c) => c.name)).toEqual([
      'id',
      'grain',
      'bucket',
      'path',
      'visitors',
      'landings',
      'overflow',
    ]);
  });
});

describe('growth_referrers', () => {
  it('constrains the referrer host to the shared host pattern and its length bound', () => {
    expect(checkNames(schema.growthReferrers)).toContain('growth_referrers_host_format');
  });

  it('makes grain, bucket, path and referrer host the rollup conflict target', () => {
    expect(uniqueShapes(schema.growthReferrers)).toEqual([
      {
        name: 'growth_referrers_grain_bucket_path_host_unique',
        columns: ['grain', 'bucket', 'path', 'referrer_host'],
      },
    ]);
  });

  it('indexes the referrer host with bucket for the per-referrer time series', () => {
    expect(findIndex(schema.growthReferrers, 'growth_referrers_host_bucket_idx').columns).toEqual([
      'referrer_host',
      'bucket',
    ]);
  });
});

describe('growth_campaign_paths', () => {
  it('references the campaign tag', () => {
    expect(findForeignKey(schema.growthCampaignPaths, ['campaign'])).toMatchObject({
      foreignTable: 'campaigns',
      foreignColumns: ['tag'],
    });
  });

  it('indexes the campaign FK', () => {
    expect(
      findIndex(schema.growthCampaignPaths, 'growth_campaign_paths_campaign_idx').columns
    ).toEqual(['campaign']);
  });

  it('makes grain, bucket, campaign and path the rollup conflict target', () => {
    expect(uniqueShapes(schema.growthCampaignPaths)).toEqual([
      {
        name: 'growth_campaign_paths_grain_bucket_campaign_path_unique',
        columns: ['grain', 'bucket', 'campaign', 'path'],
      },
    ]);
  });
});

describe('growth_geo', () => {
  it('types the device as the growth_device enum', () => {
    expect(column(schema.growthGeo, 'device').getSQLType()).toBe('growth_device');
  });

  it('admits a two-letter country or the empty unknown', () => {
    expect(checkNames(schema.growthGeo)).toContain('growth_geo_country_format');
  });

  it('admits a two-letter region or the empty unknown', () => {
    expect(checkNames(schema.growthGeo)).toContain('growth_geo_region_format');
  });

  it('keeps a region only under the country that resolves to states', () => {
    expect(checkNames(schema.growthGeo)).toContain('growth_geo_region_requires_us');
  });

  it('makes grain, bucket, country, region and device the rollup conflict target', () => {
    expect(uniqueShapes(schema.growthGeo)).toEqual([
      {
        name: 'growth_geo_grain_bucket_country_region_device_unique',
        columns: ['grain', 'bucket', 'country', 'region', 'device'],
      },
    ]);
  });
});

describe('growth_daily_path_reach', () => {
  it('is keyed by a calendar day, because reach is a same-day journey', () => {
    expect(column(schema.growthDailyPathReach, 'day').getSQLType()).toBe('date');
  });

  it('constrains the landing path to the shared path pattern', () => {
    expect(checkNames(schema.growthDailyPathReach)).toContain(
      'growth_daily_path_reach_landing_path_format'
    );
  });

  it('constrains the reached path to the shared path pattern', () => {
    expect(checkNames(schema.growthDailyPathReach)).toContain(
      'growth_daily_path_reach_reached_path_format'
    );
  });

  it('makes day, landing path and reached path the rollup conflict target', () => {
    expect(uniqueShapes(schema.growthDailyPathReach)).toEqual([
      {
        name: 'growth_daily_path_reach_day_landing_reached_unique',
        columns: ['day', 'landing_path', 'reached_path'],
      },
    ]);
  });

  it('holds exactly the declared columns', () => {
    expect(getTableConfig(schema.growthDailyPathReach).columns.map((c) => c.name)).toEqual([
      'id',
      'day',
      'landing_path',
      'reached_path',
      'visitors',
      'overflow',
    ]);
  });
});

describe('growth_hourly_events', () => {
  it('pins the hour to its own UTC truncation', () => {
    expect(checkNames(schema.growthHourlyEvents)).toContain('growth_hourly_events_hour_utc');
  });

  it('constrains the auto-captured event name to the shared event-name pattern', () => {
    expect(checkNames(schema.growthHourlyEvents)).toContain(
      'growth_hourly_events_event_name_format'
    );
  });

  it('references the campaign tag', () => {
    expect(findForeignKey(schema.growthHourlyEvents, ['campaign'])).toMatchObject({
      foreignTable: 'campaigns',
      foreignColumns: ['tag'],
    });
  });

  it('indexes the campaign FK', () => {
    expect(
      findIndex(schema.growthHourlyEvents, 'growth_hourly_events_campaign_idx').columns
    ).toEqual(['campaign']);
  });

  it('makes hour, campaign, event name and path the rollup conflict target', () => {
    expect(uniqueShapes(schema.growthHourlyEvents)).toEqual([
      {
        name: 'growth_hourly_events_hour_campaign_event_path_unique',
        columns: ['hour', 'campaign', 'event_name', 'path'],
      },
    ]);
  });
});

describe('growth_hourly_product_entry', () => {
  it('pins the hour to its own UTC truncation', () => {
    expect(checkNames(schema.growthHourlyProductEntry)).toContain(
      'growth_hourly_product_entry_hour_utc'
    );
  });

  it('refuses a negative visitor count', () => {
    expect(checkNames(schema.growthHourlyProductEntry)).toContain(
      'growth_hourly_product_entry_visitors_non_negative'
    );
  });

  it('makes the hour alone the rollup conflict target, the marginal carrying no dimension', () => {
    expect(uniqueShapes(schema.growthHourlyProductEntry)).toEqual([
      { name: 'growth_hourly_product_entry_hour_unique', columns: ['hour'] },
    ]);
  });

  it('holds exactly the declared columns', () => {
    expect(getTableConfig(schema.growthHourlyProductEntry).columns.map((c) => c.name)).toEqual([
      'id',
      'hour',
      'visitors',
      'overflow',
    ]);
  });
});

describe('growth_hourly_funnel', () => {
  it('pins the hour to its own UTC truncation', () => {
    expect(checkNames(schema.growthHourlyFunnel)).toContain('growth_hourly_funnel_hour_utc');
  });

  it('types the step as the growth_funnel_step enum', () => {
    expect(column(schema.growthHourlyFunnel, 'step').getSQLType()).toBe('growth_funnel_step');
  });

  it('refuses a negative registration count', () => {
    expect(checkNames(schema.growthHourlyFunnel)).toContain(
      'growth_hourly_funnel_registrations_non_negative'
    );
  });

  it('indexes the campaign FK', () => {
    expect(
      findIndex(schema.growthHourlyFunnel, 'growth_hourly_funnel_campaign_idx').columns
    ).toEqual(['campaign']);
  });

  it('makes hour, campaign and step the rollup conflict target', () => {
    expect(uniqueShapes(schema.growthHourlyFunnel)).toEqual([
      {
        name: 'growth_hourly_funnel_hour_campaign_step_unique',
        columns: ['hour', 'campaign', 'step'],
      },
    ]);
  });

  it('holds exactly the declared columns', () => {
    expect(getTableConfig(schema.growthHourlyFunnel).columns.map((c) => c.name)).toEqual([
      'id',
      'hour',
      'campaign',
      'step',
      'registrations',
      'overflow',
    ]);
  });
});
