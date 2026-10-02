import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle'
);

const ROLE = 'growth_reader';

/**
 * The aggregate views the role's migration grants SELECT on, and the whole of
 * what it may reach. Duplicated from the migration on purpose: a list derived
 * from the same grants it checks would assert nothing.
 */
const GRANTED_VIEWS: readonly string[] = [
  'acquisition_sources',
  'funnel_weekly',
  'growth_weekly',
  'marketing_daily',
  'marketing_hourly',
];

interface AttributeExpectation {
  readonly name: string;
  readonly expected: boolean;
}

/**
 * The posture the role's migration creates it with, read from the catalog
 * because a privilege query cannot answer for it: `rolbypassrls` is not a table
 * privilege at all, and `rolsuper` reaches a privilege check only as a blanket
 * pass that names no attribute. `rolcanlogin` false is what keeps the role
 * unusable until someone deliberately grants LOGIN and a password.
 */
const EXPECTED_ATTRIBUTES: readonly AttributeExpectation[] = [
  { name: 'rolsuper', expected: false },
  { name: 'rolbypassrls', expected: false },
  { name: 'rolcanlogin', expected: false },
  { name: 'rolinherit', expected: true },
];

interface ColumnReference {
  readonly relation: string;
  readonly column: string;
}

function columnKey({ relation, column }: ColumnReference): string {
  return `${relation}.${column}`;
}

interface FunctionReference {
  readonly schema: string;
  readonly signature: string;
}

let db: Database;
let readable: readonly string[];
let readableColumns: readonly ColumnReference[];
let schemaColumns: readonly ColumnReference[];
let memberships: readonly string[];
let attributes: ReadonlyMap<string, boolean>;
let schemaUsage: boolean;
let definerFunctions: readonly FunctionReference[];

/**
 * Asks Postgres what the role reaches rather than reading migration text: the
 * answer is the privilege the database computes, not one derived from statements
 * a parser recognises. `has_table_privilege` resolves a direct grant, a grant
 * routed through PUBLIC, an inherited role membership, a default privilege, a
 * relation's ownership and SUPERUSER alike. It answers one question — does the
 * role hold a table-level SELECT privilege on this relation of schema `public` —
 * so a widening at any other granularity takes a read of its own: a grant scoped
 * to a column ({@link selectableColumns}), a membership the role does not inherit
 * ({@link membershipRoles}), an attribute ({@link roleAttributes}).
 */
async function readableRelations(): Promise<readonly string[]> {
  const result = await db.execute(sql`
    SELECT c.relname AS relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
      AND has_table_privilege(${ROLE}, c.oid, 'SELECT')
    ORDER BY c.relname
  `);
  return result.rows.map((row) => String(row['relname']));
}

/**
 * A grant may be scoped to a column, and a table-level answer does not see one:
 * after `GRANT SELECT (email) ON users TO growth_reader`,
 * `has_table_privilege(…, 'users', 'SELECT')` is false while
 * `has_column_privilege(…, 'users', 'email', 'SELECT')` is true, so the role reads
 * that column with {@link readableRelations} reporting nothing.
 */
async function selectableColumns(): Promise<readonly ColumnReference[]> {
  const result = await db.execute(sql`
    SELECT c.relname AS relname, a.attname AS attname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND has_column_privilege(${ROLE}, c.oid, a.attnum, 'SELECT')
    ORDER BY c.relname, a.attname
  `);
  return result.rows.map((row) => ({
    relation: String(row['relname']),
    column: String(row['attname']),
  }));
}

/**
 * Every column of schema `public`, read with no privilege predicate, because a
 * privilege-filtered read cannot serve as its own expectation: this is the inventory
 * the granted views' columns are checked against, and {@link selectableColumns}
 * coming back empty would otherwise satisfy every assertion over it.
 */
async function publicColumns(): Promise<readonly ColumnReference[]> {
  const result = await db.execute(sql`
    SELECT c.relname AS relname, a.attname AS attname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY c.relname, a.attname
  `);
  return result.rows.map((row) => ({
    relation: String(row['relname']),
    column: String(row['attname']),
  }));
}

/**
 * A membership widens the role whether or not it inherits, and the
 * non-inheriting form reaches no privilege check: `pg_has_role(role, target,
 * 'MEMBER')` is true for it while the `'USAGE'` form `has_table_privilege`
 * consults is false, because reaching the privilege takes `SET ROLE`. The
 * membership row, not a privilege answer, is what a widening of that shape
 * reaches.
 */
async function membershipRoles(): Promise<readonly string[]> {
  const result = await db.execute(sql`
    SELECT granted.rolname AS rolname
    FROM pg_auth_members m
    JOIN pg_roles granted ON granted.oid = m.roleid
    JOIN pg_roles member ON member.oid = m.member
    WHERE member.rolname = ${ROLE}
    ORDER BY granted.rolname
  `);
  return result.rows.map((row) => String(row['rolname']));
}

async function roleAttributes(): Promise<ReadonlyMap<string, boolean>> {
  const result = await db.execute(sql`
    SELECT rolsuper, rolbypassrls, rolcanlogin, rolinherit
    FROM pg_roles
    WHERE rolname = ${ROLE}
  `);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`${ROLE} has no pg_roles row`);
  }
  return new Map(
    EXPECTED_ATTRIBUTES.map(({ name }): [string, boolean] => {
      const value = row[name];
      if (typeof value !== 'boolean') {
        throw new TypeError(`pg_roles.${name} read as ${typeof value}, not a boolean`);
      }
      return [name, value];
    })
  );
}

/**
 * Schema USAGE is a privilege of its own, consulted where a name is resolved
 * rather than read from a relation's ACL, so every relation and column answer
 * here stays unchanged while the role can reach nothing at all. Asked of the
 * role rather than read out of the schema's ACL because either grant answers
 * it — the role's own, or the USAGE schema `public` carries for PUBLIC — which
 * is also why revoking the role's own grant alone costs it nothing.
 */
async function hasSchemaUsage(): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT has_schema_privilege(${ROLE}, 'public', 'USAGE') AS granted
  `);
  const granted = result.rows[0]?.['granted'];
  if (typeof granted !== 'boolean') {
    throw new TypeError(`has_schema_privilege read as ${typeof granted}, not a boolean`);
  }
  return granted;
}

/**
 * A SECURITY DEFINER function runs with its owner's privileges, so one that
 * selects from a relation the caller cannot read hands the caller those rows;
 * no relation privilege, membership or attribute changes, so every other read
 * here stays unchanged while such a function reads anything its owner can.
 * Postgres grants EXECUTE on a new function to PUBLIC, so the route opens by
 * omission rather than by a grant naming a role.
 *
 * This answers whether such a function exists, not whether any given role can
 * reach one. Both privilege answers were tried and neither holds: a function in
 * a schema the reader holds no USAGE on is still reached through an operator or
 * through a cast, neither of which resolves the function by name, and an
 * aggregate's transition function is reached with no EXECUTE check at all — it
 * runs after EXECUTE is revoked from PUBLIC, which is otherwise the documented
 * remedy for a benign definer function. Those three were measured, and nothing
 * makes them the whole set, so the predicate is the object's existence rather
 * than an enumeration of the ways to invoke it.
 *
 * The predicate is `prosecdef` alone, and the object's identity bounds it no
 * further. An oid at or above PostgreSQL's FirstNormalObjectId once narrowed it
 * to objects a migration created, since every lower oid belongs to an object the
 * server itself supplied; that bound is gone because `CREATE OR REPLACE
 * FUNCTION` on a system-supplied function keeps its oid while setting
 * `prosecdef`, which puts a definer body under an oid the bound could not see.
 * Replacing a system-supplied function takes ownership of that function, and the
 * role that applies the migration chain owns every
 * function in `pg_catalog` and `information_schema` here because it is the
 * cluster's bootstrap role. The
 * accepted cost is the false positive that bound used to absorb — a PostgreSQL
 * release shipping a SECURITY DEFINER builtin reddens this assertion while
 * saying nothing about what a migration did. That case is a human ruling on the
 * new builtin, foreseen when the bound was dropped, and not a defect to silence.
 */
async function securityDefinerFunctions(): Promise<readonly FunctionReference[]> {
  const result = await db.execute(sql`
    SELECT n.nspname AS nspname,
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef
    ORDER BY n.nspname, signature
  `);
  return result.rows.map((row) => ({
    schema: String(row['nspname']),
    signature: String(row['signature']),
  }));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  readable = await readableRelations();
  readableColumns = await selectableColumns();
  schemaColumns = await publicColumns();
  memberships = await membershipRoles();
  attributes = await roleAttributes();
  schemaUsage = await hasSchemaUsage();
  definerFunctions = await securityDefinerFunctions();
}, 60_000);

afterAll(async () => {
  await db.$client.end();
});

describe('growth_reader readable set', () => {
  it('reads every view its migration grants', () => {
    const lost = GRANTED_VIEWS.filter((view) => !readable.includes(view)).map(
      (view) => `${view}: granted to ${ROLE} by migration, unreadable in the database`
    );
    expect(lost).toEqual([]);
  });

  it('reads no other relation in the public schema', () => {
    const widened = readable
      .filter((relation) => !GRANTED_VIEWS.includes(relation))
      .map((relation) => `${relation}: readable by ${ROLE}, granted by no migration`);
    expect(widened).toEqual([]);
  });

  it('reads no column of a relation outside those views', () => {
    const widened = readableColumns
      .filter(({ relation }) => !GRANTED_VIEWS.includes(relation))
      .map(
        ({ relation, column }) =>
          `${relation}.${column}: readable by ${ROLE}, granted by no migration`
      );
    expect(widened).toEqual([]);
  });

  it('reads every column of the views its migration grants', () => {
    const readableKeys = new Set(readableColumns.map((reference) => columnKey(reference)));
    const lost = schemaColumns
      .filter(({ relation }) => GRANTED_VIEWS.includes(relation))
      .filter((reference) => !readableKeys.has(columnKey(reference)))
      .map(
        (reference) =>
          `${columnKey(reference)}: granted to ${ROLE} by migration, unreadable in the database`
      );
    expect(lost).toEqual([]);
  });

  it('is a member of no role', () => {
    const granted = memberships.map(
      (role) => `${role}: granted to ${ROLE}, reachable whether or not the role inherits`
    );
    expect(granted).toEqual([]);
  });

  it('keeps the attributes its migration creates it with', () => {
    const changed = EXPECTED_ATTRIBUTES.filter(
      ({ name, expected }) => attributes.get(name) !== expected
    ).map(
      ({ name, expected }) =>
        `${name}: ${ROLE} has ${String(attributes.get(name))}, its migration leaves it ${String(expected)}`
    );
    expect(changed).toEqual([]);
  });

  it('holds USAGE on the schema its views live in', () => {
    const missing = schemaUsage
      ? []
      : [
          `public: USAGE missing for ${ROLE}, which resolves no table name in the schema without it`,
        ];
    expect(missing).toEqual([]);
  });

  it('rests on the database holding no security-definer function', () => {
    const present = definerFunctions.map(
      ({ schema, signature }) =>
        `${schema}.${signature}: SECURITY DEFINER, so it runs with its owner's privileges and reads whatever they can; revoking EXECUTE from PUBLIC does not close it, because an aggregate's transition function is invoked with no EXECUTE check`
    );
    expect(present).toEqual([]);
  });
});
