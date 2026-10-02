import { getTableConfig, PgDialect, PgTable } from 'drizzle-orm/pg-core';

import * as schema from '../index';

/** A partial index whose predicate tests exactly one column for not-null, and that column. */
export interface NotNullPartialIndex {
  readonly name: string;
  readonly column: string;
}

type IndexConfig = ReturnType<typeof getTableConfig>['indexes'][number]['config'];

/**
 * `isNotNull()` renders the operator in lower case and a raw `sql` predicate
 * renders as it was written, so the match ignores case. A `replace` that finds
 * no match returns its input, which is how a non-matching predicate is detected
 * without indexing into a possibly-absent capture group.
 */
const NOT_NULL_PREDICATE = /^"[^"]+"\."([^"]+)" is not null$/i;

const dialect = new PgDialect();

/**
 * An unnamed index yields `undefined` because the integration suite verifies a
 * predicate by index name, and a name is the only handle it has on one.
 */
function notNullPartialIndex(config: IndexConfig): NotNullPartialIndex | undefined {
  if (config.where === undefined || config.name === undefined) return undefined;
  const predicate = dialect.sqlToQuery(config.where).sql.trim();
  const column = predicate.replace(NOT_NULL_PREDICATE, '$1');
  return column === predicate ? undefined : { name: config.name, column };
}

export function deriveNotNullPartialIndexes(tables: readonly PgTable[]): NotNullPartialIndex[] {
  const derived: NotNullPartialIndex[] = [];
  for (const table of tables) {
    for (const { config } of getTableConfig(table).indexes) {
      const entry = notNullPartialIndex(config);
      if (entry !== undefined) derived.push(entry);
    }
  }
  return derived;
}

/**
 * Whether an index may count as covering a foreign key on `fkColumns`. A full index
 * always may; a partial one only when its predicate tests one of the foreign key's
 * own columns for not-null, since a predicate on any other column excludes rows the
 * foreign-key scan probes.
 */
export function coversForeignKey(config: IndexConfig, fkColumns: readonly string[]): boolean {
  if (config.where === undefined) return true;
  const entry = notNullPartialIndex(config);
  return entry !== undefined && fkColumns.includes(entry.column);
}

/**
 * Derived from the schema rather than listed, so it cannot disagree with it.
 * The FK shape test admits such an index as covering an FK on the column the
 * predicate tests — an FK scan probes only non-null values — and the
 * integration suite proves that predicate reached the database.
 */
export const NOT_NULL_PARTIAL_INDEXES: readonly NotNullPartialIndex[] = deriveNotNullPartialIndexes(
  (Object.values(schema) as unknown[]).filter((v): v is PgTable => v instanceof PgTable)
);
