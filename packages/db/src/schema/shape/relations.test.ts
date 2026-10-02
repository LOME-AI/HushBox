import { describe, it, expect } from 'vitest';
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  One,
  Relations,
} from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';

import * as schema from '../index';

/** Every table declares relations() so relational queries stay usable. */
describe('relations() coverage', () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable => v instanceof PgTable
  );
  const relationTables = new Set(
    (Object.values(schema) as unknown[])
      .filter((v): v is Relations => v instanceof Relations)
      .map((r) => getTableConfig(r.table as PgTable).name)
  );

  it('walks a non-empty table set', () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  for (const table of tables) {
    const name = getTableConfig(table).name;
    it(`${name} declares relations()`, () => {
      expect(relationTables.has(name)).toBe(true);
    });
  }

  it('every declared relation resolves through relational-config extraction', () => {
    // Runs every relations() callback through drizzle's own extraction, the
    // same path `drizzle(pool, { schema })` takes at client construction.
    const config = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
    expect(Object.keys(config.tables)).toHaveLength(tables.length);
  });

  // conversation_spending and member_budgets are each UNIQUE on their parent
  // column, so the parent side is one-to-one; declaring many() would let a
  // relational query hand back an array that can never hold two rows.
  it.each([
    ['conversations', 'spending'],
    ['conversationMembers', 'budgets'],
  ])('%s.%s is a to-one relation', (table, relation) => {
    const config = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
    expect(config.tables[table]?.relations[relation]).toBeInstanceOf(One);
  });
});
