import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { GROWTH_CHANNELS, GROWTH_SELF_REPORT_CONTEXT } from '@hushbox/shared';

import { checkNames, column, findForeignKey, findIndex } from './__tests__/shape-helpers';
import * as schema from './index';

describe('acquisition pgEnums', () => {
  it('derives growth_channel values from the single shared GROWTH_CHANNELS source', () => {
    expect(schema.growthChannelEnum.enumValues).toEqual([...GROWTH_CHANNELS]);
  });

  it('derives growth_self_report_context values from the single shared source', () => {
    expect(schema.growthSelfReportContextEnum.enumValues).toEqual([...GROWTH_SELF_REPORT_CONTEXT]);
  });
});

describe('user_acquisition', () => {
  it('carries the source columns and nothing else', () => {
    const names = getTableConfig(schema.userAcquisition)
      .columns.map((c) => c.name)
      .toSorted((a, b) => a.localeCompare(b));
    expect(names).toEqual([
      'campaign',
      'id',
      'platform',
      'self_report_skipped',
      'self_reported_at',
      'self_reported_channel',
      'self_reported_context',
      'user_id',
    ]);
  });

  it('holds one row per account', () => {
    expect(column(schema.userAcquisition, 'user_id').isUnique).toBe(true);
  });

  it('goes with the account it describes', () => {
    expect(findForeignKey(schema.userAcquisition, ['user_id'])).toEqual({
      columns: ['user_id'],
      foreignTable: 'users',
      foreignColumns: ['id'],
      onDelete: 'cascade',
    });
  });

  it('resolves its campaign against the campaign tags', () => {
    expect(findForeignKey(schema.userAcquisition, ['campaign'])).toEqual({
      columns: ['campaign'],
      foreignTable: 'campaigns',
      foreignColumns: ['tag'],
      // Campaigns are archived, never deleted, so the tag a row cites always resolves.
      onDelete: 'no action',
    });
  });

  it('indexes the campaign it references', () => {
    expect(findIndex(schema.userAcquisition, 'user_acquisition_campaign_idx').columns).toEqual([
      'campaign',
    ]);
  });

  it('records the campaign and the platform for every account', () => {
    expect(column(schema.userAcquisition, 'campaign').notNull).toBe(true);
    expect(column(schema.userAcquisition, 'platform').notNull).toBe(true);
  });

  it('reuses the account platform enum rather than declaring a second one', () => {
    expect(column(schema.userAcquisition, 'platform').enumValues).toEqual(
      schema.devicePlatformEnum.enumValues
    );
  });

  it('leaves every self-reported column nullable, since the question is optional', () => {
    for (const name of [
      'self_reported_channel',
      'self_reported_context',
      'self_reported_at',
      'self_report_skipped',
    ]) {
      expect(column(schema.userAcquisition, name).notNull).toBe(false);
    }
  });

  it('records a skip in the same closed set as an answer', () => {
    expect(column(schema.userAcquisition, 'self_report_skipped').enumValues).toEqual([
      ...GROWTH_SELF_REPORT_CONTEXT,
    ]);
  });

  it('constrains the answer triple to be wholly present or wholly absent', () => {
    expect(checkNames(schema.userAcquisition)).toEqual(['user_acquisition_self_report_complete']);
  });
});
