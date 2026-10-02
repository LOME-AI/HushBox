import { describe, it, expect } from 'vitest';
import { isNotNull } from 'drizzle-orm';
import { getTableConfig, index, pgTable, PgTable, text, uuid } from 'drizzle-orm/pg-core';

import * as schema from '../index';
import { coversForeignKey } from './not-null-partial-indexes';

/**
 * Every FK column gets an index or a written justification (Postgres does
 * not auto-index FKs; unindexed-FK cascades are the classic deletion-stall
 * bug). This test walks every declared FK and asserts its local columns are
 * the leading columns of some index, unique constraint, or primary key.
 *
 * A partial index counts only when its predicate tests the FK column itself
 * for not-null (verified against pg_indexes by the integration suite), which
 * covers every FK lookup because FK scans only ever probe non-null values.
 */

/** `table.column` FKs deliberately left unindexed, each with a written reason. */
const JUSTIFIED_UNINDEXED: Record<string, string> = {};

function leadingColumnsCover(indexColumns: string[], fkColumns: string[]): boolean {
  if (indexColumns.length < fkColumns.length) return false;
  const prefix = new Set(indexColumns.slice(0, fkColumns.length));
  return fkColumns.every((c) => prefix.has(c));
}

function isCovered(cfg: ReturnType<typeof getTableConfig>, fkColumns: string[]): boolean {
  const fullIndexes = cfg.indexes
    .filter((declared) => coversForeignKey(declared.config, fkColumns))
    .map((declared) =>
      declared.config.columns.map((c) => ('name' in c ? (c as { name: string }).name : ''))
    );
  const uniques = cfg.uniqueConstraints.map((u) => u.columns.map((c) => c.name));
  const primaryKeys = cfg.primaryKeys.map((pk) => pk.columns.map((c) => c.name));
  const singleColumnCovers = cfg.columns
    .filter((c) => c.isUnique || c.primary)
    .map((c) => [c.name]);
  const candidates = [...fullIndexes, ...uniques, ...primaryKeys, ...singleColumnCovers];
  return candidates.some((indexColumns) => leadingColumnsCover(indexColumns, fkColumns));
}

const referenced = pgTable('coverage_fixture_parent', {
  id: uuid('id').primaryKey(),
});

const predicateOnOwnColumn = pgTable(
  'coverage_fixture_own_column',
  {
    ownerId: uuid('owner_id').references(() => referenced.id),
    status: text('status'),
  },
  (table) => [
    index('coverage_fixture_own_column_idx').on(table.ownerId).where(isNotNull(table.ownerId)),
  ]
);

const predicateOnOtherColumn = pgTable(
  'coverage_fixture_other_column',
  {
    ownerId: uuid('owner_id').references(() => referenced.id),
    status: text('status'),
  },
  (table) => [
    index('coverage_fixture_other_column_idx').on(table.ownerId).where(isNotNull(table.status)),
  ]
);

describe('every FK column is indexed or justified', () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable => v instanceof PgTable
  );

  it('walks a non-empty table set', () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  for (const table of tables) {
    const cfg = getTableConfig(table);
    for (const fk of cfg.foreignKeys) {
      const fkColumns = fk.reference().columns.map((c) => c.name);
      it(`${cfg.name}(${fkColumns.join(', ')}) is covered`, () => {
        const justification = JUSTIFIED_UNINDEXED[`${cfg.name}.${fkColumns.join(',')}`];
        if (justification !== undefined) {
          expect(justification.length).toBeGreaterThan(0);
          return;
        }
        expect(isCovered(cfg, fkColumns)).toBe(true);
      });
    }
  }
});

describe('a partial index covers an FK only through its own predicate column', () => {
  it('covers an FK whose column the predicate tests for not-null', () => {
    expect(isCovered(getTableConfig(predicateOnOwnColumn), ['owner_id'])).toBe(true);
  });

  it('leaves an FK uncovered when the predicate tests a column outside it', () => {
    expect(isCovered(getTableConfig(predicateOnOtherColumn), ['owner_id'])).toBe(false);
  });
});
