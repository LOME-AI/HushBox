import { describe, it, expect } from 'vitest';
import { createTableRelationsHelpers, extractTablesRelationalConfig, Many, One } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';

import {
  checkNames,
  column,
  findForeignKey,
  hasDefault,
  uniqueShapes,
} from './__tests__/shape-helpers';
import * as schema from './index';

describe('terms_acceptances', () => {
  it('carries the acceptance columns and nothing else', () => {
    const names = getTableConfig(schema.termsAcceptances)
      .columns.map((c) => c.name)
      .toSorted((a, b) => a.localeCompare(b));
    expect(names).toEqual(['accepted_at', 'id', 'revision', 'user_id']);
  });

  it('holds one row per account and Terms revision', () => {
    expect(uniqueShapes(schema.termsAcceptances)).toEqual([
      { name: 'terms_acceptances_user_revision_unique', columns: ['user_id', 'revision'] },
    ]);
  });

  it('goes with the account that accepted', () => {
    expect(findForeignKey(schema.termsAcceptances, ['user_id'])).toEqual({
      columns: ['user_id'],
      foreignTable: 'users',
      foreignColumns: ['id'],
      onDelete: 'cascade',
    });
  });

  it('requires the account', () => {
    expect(column(schema.termsAcceptances, 'user_id').notNull).toBe(true);
  });

  it('stores the revision as a required integer', () => {
    const c = column(schema.termsAcceptances, 'revision');
    expect(c.getSQLType()).toBe('integer');
    expect(c.notNull).toBe(true);
  });

  it('constrains the revision to be positive', () => {
    expect(checkNames(schema.termsAcceptances)).toEqual(['terms_acceptances_revision_positive']);
  });

  it('timestamps the acceptance by default', () => {
    const c = column(schema.termsAcceptances, 'accepted_at');
    expect(c.getSQLType()).toBe('timestamp with time zone');
    expect(c.notNull).toBe(true);
    expect(hasDefault(schema.termsAcceptances, 'accepted_at')).toBe(true);
  });

  it("lists an account's acceptances from the account", () => {
    const config = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
    expect(config.tables['users']?.relations['termsAcceptances']).toBeInstanceOf(Many);
  });

  it('names the account from an acceptance', () => {
    const config = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
    expect(config.tables['termsAcceptances']?.relations['user']).toBeInstanceOf(One);
  });
});
