import { getTableConfig } from 'drizzle-orm/pg-core';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

export function column(table: PgTable, dbName: string): AnyPgColumn {
  const found = getTableConfig(table).columns.find((c) => c.name === dbName);
  if (!found) {
    throw new Error(`column ${dbName} not found on ${getTableConfig(table).name}`);
  }
  return found;
}

interface IndexShape {
  name: string | undefined;
  unique: boolean;
  partial: boolean;
  columns: string[];
}

export function indexShapes(table: PgTable): IndexShape[] {
  return getTableConfig(table).indexes.map((index) => ({
    name: index.config.name,
    unique: index.config.unique,
    partial: index.config.where !== undefined,
    columns: index.config.columns.map((c) => ('name' in c ? (c as { name: string }).name : '')),
  }));
}

export function findIndex(table: PgTable, name: string): IndexShape {
  const found = indexShapes(table).find((index) => index.name === name);
  if (!found) {
    throw new Error(`index ${name} not found on ${getTableConfig(table).name}`);
  }
  return found;
}

interface UniqueShape {
  name: string | undefined;
  columns: string[];
}

export function uniqueShapes(table: PgTable): UniqueShape[] {
  return getTableConfig(table).uniqueConstraints.map((u) => ({
    name: u.name,
    columns: u.columns.map((c) => c.name),
  }));
}

interface ForeignKeyShape {
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
  onDelete: string | undefined;
}

export function foreignKeyShapes(table: PgTable): ForeignKeyShape[] {
  return getTableConfig(table).foreignKeys.map((fk) => {
    const ref = fk.reference();
    return {
      columns: ref.columns.map((c) => c.name),
      foreignTable: getTableConfig(ref.foreignTable).name,
      foreignColumns: ref.foreignColumns.map((c) => c.name),
      onDelete: fk.onDelete,
    };
  });
}

export function findForeignKey(table: PgTable, localColumns: string[]): ForeignKeyShape {
  const found = foreignKeyShapes(table).find(
    (fk) =>
      fk.columns.length === localColumns.length && localColumns.every((c) => fk.columns.includes(c))
  );
  if (!found) {
    throw new Error(
      `foreign key on (${localColumns.join(', ')}) not found on ${getTableConfig(table).name}`
    );
  }
  return found;
}

export function checkNames(table: PgTable): string[] {
  return getTableConfig(table).checks.map((c) => c.name);
}

/** True when the column has a SQL-side default expression (e.g. uuidv7()). */
export function hasDefault(table: PgTable, dbName: string): boolean {
  const c = column(table, dbName);
  return c.default !== undefined || c.defaultFn !== undefined || c.hasDefault;
}

/**
 * The constraint Postgres named when it refused the row. Asserting the name,
 * not merely that something threw, is what makes a rejection test evidence
 * that the intended constraint fired rather than an unrelated one — and it is
 * what makes the test unable to pass if the constraint were absent, since the
 * insert would then be accepted and this would throw instead.
 */
function constraintOf(error: unknown): string {
  // Drizzle wraps the driver's error, so the constraint name sits on a cause
  // one or more links down rather than on the error the query rejected with.
  for (let link: unknown = error; link instanceof Error; link = link.cause) {
    if ('constraint' in link && typeof link.constraint === 'string' && link.constraint !== '') {
      return link.constraint;
    }
  }
  throw new Error(`expected a constraint violation, got: ${String(error)}`);
}

export async function refusalConstraint(insert: Promise<unknown>): Promise<string> {
  try {
    await insert;
  } catch (error) {
    return constraintOf(error);
  }
  throw new Error('the insert was accepted, so no constraint fired');
}

/** Every message on the refusal's cause chain, since drizzle's own wrapper carries none of Postgres' text. */
export async function refusalMessages(statement: Promise<unknown>): Promise<string> {
  try {
    await statement;
  } catch (error) {
    const chain: string[] = [];
    for (let link: unknown = error; link instanceof Error; link = link.cause) {
      chain.push(link.message);
    }
    return chain.join('\n');
  }
  throw new Error('the statement was accepted, so nothing refused it');
}
