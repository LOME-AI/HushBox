import { describe, it, expect } from 'vitest';
import { isNotNull, sql } from 'drizzle-orm';
import { getTableConfig, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import {
  NOT_NULL_PARTIAL_INDEXES,
  coversForeignKey,
  deriveNotNullPartialIndexes,
} from './not-null-partial-indexes';

const fixture = pgTable(
  'derivation_fixture',
  {
    id: uuid('id').primaryKey(),
    optionalId: uuid('optional_id'),
    status: text('status'),
  },
  (table) => [
    index('derivation_fixture_id_idx').on(table.id),
    index('derivation_fixture_optional_id_idx')
      .on(table.optionalId)
      .where(isNotNull(table.optionalId)),
    index('derivation_fixture_status_idx')
      .on(table.status)
      .where(sql`${table.status} = 'live'`),
    index().on(table.status).where(isNotNull(table.status)),
  ]
);

describe('deriveNotNullPartialIndexes', () => {
  const derived = deriveNotNullPartialIndexes([fixture]);

  it('names the column a not-null predicate tests', () => {
    expect(derived).toContainEqual({
      name: 'derivation_fixture_optional_id_idx',
      column: 'optional_id',
    });
  });

  it('omits an index that carries no predicate', () => {
    expect(derived.map((entry) => entry.name)).not.toContain('derivation_fixture_id_idx');
  });

  it('omits a partial index whose predicate is not a not-null test', () => {
    expect(derived.map((entry) => entry.name)).not.toContain('derivation_fixture_status_idx');
  });

  it('omits a partial index that carries no name', () => {
    expect(derived).toHaveLength(1);
  });
});

describe('NOT_NULL_PARTIAL_INDEXES', () => {
  it('derives the schema partial indexes that test a column for not-null', () => {
    expect(NOT_NULL_PARTIAL_INDEXES).toContainEqual({
      name: 'ledger_entries_payment_id_idx',
      column: 'payment_id',
    });
  });

  it('omits a schema partial index whose predicate tests something else', () => {
    expect(NOT_NULL_PARTIAL_INDEXES.map((entry) => entry.name)).not.toContain('jobs_claim_idx');
  });
});

describe('coversForeignKey', () => {
  const admitted = (fkColumns: string[]): (string | undefined)[] =>
    getTableConfig(fixture)
      .indexes.filter((declared) => coversForeignKey(declared.config, fkColumns))
      .map((declared) => declared.config.name);

  it('admits an index that carries no predicate', () => {
    expect(admitted(['id'])).toContain('derivation_fixture_id_idx');
  });

  it('refuses a partial index whose predicate is not a not-null test', () => {
    expect(admitted(['status'])).not.toContain('derivation_fixture_status_idx');
  });

  it('refuses a partial index that carries no name', () => {
    expect(admitted(['status'])).not.toContain(undefined);
  });
});
