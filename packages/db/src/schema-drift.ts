/**
 * Compares a live database against the schema its migration chain records, and
 * refuses when the two disagree.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';

import type { Database } from './client';

/** The subset of a drizzle migration snapshot this comparison reads. */
export interface SnapshotColumn {
  readonly name: string;
  readonly type: string;
  readonly notNull?: boolean;
  readonly primaryKey?: boolean;
}

export interface SnapshotTable {
  readonly name: string;
  readonly schema: string;
  readonly columns: Record<string, SnapshotColumn>;
  readonly indexes: Record<string, { readonly name: string }>;
  readonly foreignKeys: Record<string, { readonly name: string }>;
  readonly compositePrimaryKeys: Record<string, { readonly name: string }>;
  readonly uniqueConstraints: Record<string, { readonly name: string }>;
  readonly checkConstraints: Record<string, { readonly name: string }>;
}

export interface SnapshotView {
  readonly name: string;
  readonly schema: string;
  readonly columns: Record<string, SnapshotColumn>;
}

export interface SnapshotEnum {
  readonly name: string;
  readonly schema: string;
  readonly values: readonly string[];
}

export interface MigrationSnapshot {
  readonly tables: Record<string, SnapshotTable>;
  readonly views: Record<string, SnapshotView>;
  readonly enums: Record<string, SnapshotEnum>;
}

/** What the database actually holds, as the catalog query reports it. */
export interface LiveCatalog {
  readonly relations: readonly { readonly name: string; readonly isView: boolean }[];
  readonly columns: readonly {
    readonly relation: string;
    readonly column: string;
    readonly type: string;
    readonly notNull: boolean;
  }[];
  readonly enums: readonly { readonly name: string; readonly values: readonly string[] }[];
  readonly indexes: readonly string[];
  readonly constraints: readonly string[];
}

export interface ExpectedColumn {
  readonly relation: string;
  readonly column: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly onView: boolean;
}

export interface SchemaExpectation {
  readonly tables: readonly string[];
  readonly views: readonly string[];
  readonly enums: readonly SnapshotEnum[];
  readonly columns: readonly ExpectedColumn[];
  readonly indexes: readonly string[];
  readonly constraints: readonly string[];
}

export type DivergenceKind = 'table' | 'view' | 'enum' | 'column' | 'index' | 'constraint';
export type DivergenceDirection = 'absent' | 'unexpected' | 'differs';

export interface Divergence {
  readonly kind: DivergenceKind;
  readonly direction: DivergenceDirection;
  readonly name: string;
  readonly detail?: string;
}

/**
 * Postgres truncates an identifier past its length ceiling rather than refusing
 * it, so a longer recorded name is stored under the truncated spelling.
 */
const MAX_IDENTIFIER_LENGTH = 63;

function storedIdentifier(name: string): string {
  return name.slice(0, MAX_IDENTIFIER_LENGTH);
}

export function expectationFrom(snapshot: MigrationSnapshot): SchemaExpectation {
  const tables = Object.values(snapshot.tables);
  const views = Object.values(snapshot.views);
  const columns: ExpectedColumn[] = [];
  for (const table of tables) {
    for (const column of Object.values(table.columns)) {
      columns.push({
        relation: table.name,
        column: column.name,
        type: column.type,
        notNull: column.notNull === true,
        onView: false,
      });
    }
  }
  for (const view of views) {
    for (const column of Object.values(view.columns)) {
      columns.push({
        relation: view.name,
        column: column.name,
        type: column.type,
        notNull: column.notNull === true,
        onView: true,
      });
    }
  }
  return {
    tables: tables.map((table) => table.name),
    views: views.map((view) => view.name),
    enums: Object.values(snapshot.enums),
    columns,
    indexes: tables.flatMap((table) => Object.values(table.indexes).map((index) => index.name)),
    constraints: tables.flatMap((table) => constraintsOf(table)),
  };
}

/**
 * The constraint names a table's entry implies. A single-column primary key is
 * a column flag in the snapshot and a named constraint in the catalog, which
 * Postgres mints from the table's own name.
 */
function constraintsOf(table: SnapshotTable): string[] {
  const named = [
    table.uniqueConstraints,
    table.checkConstraints,
    table.foreignKeys,
    table.compositePrimaryKeys,
  ].flatMap((group) => Object.values(group).map((constraint) => constraint.name));
  const hasPrimaryKey = Object.values(table.columns).some((column) => column.primaryKey === true);
  return [...named, ...(hasPrimaryKey ? [`${table.name}_pkey`] : [])].map((name) =>
    storedIdentifier(name)
  );
}

/**
 * Relations the local stack's own bookkeeping installs in the same schema as the
 * migrated tables (`scripts/lib/stack/stack-meta.ts`), on development and test
 * databases only. The migration chain neither creates them nor knows of them,
 * so they are held out of the comparison in both directions. Renaming one there
 * makes this check report it by name as an unexpected table, which says what to
 * change here.
 */
export const HARNESS_RELATIONS: ReadonlySet<string> = new Set(['__stack_meta']);

export function compareSchema(
  expectation: SchemaExpectation,
  catalog: LiveCatalog,
  canonicalType: ReadonlyMap<string, string>
): Divergence[] {
  const live: LiveCatalog = {
    ...catalog,
    relations: catalog.relations.filter((relation) => !HARNESS_RELATIONS.has(relation.name)),
    columns: catalog.columns.filter((column) => !HARNESS_RELATIONS.has(column.relation)),
  };
  const divergences: Divergence[] = [];
  const liveTables = new Set(
    live.relations.filter((relation) => !relation.isView).map((relation) => relation.name)
  );
  const liveViews = new Set(
    live.relations.filter((relation) => relation.isView).map((relation) => relation.name)
  );
  compareSets(divergences, 'table', expectation.tables, liveTables);
  compareSets(divergences, 'view', expectation.views, liveViews);
  compareColumns(divergences, expectation, live, canonicalType);
  compareEnums(divergences, expectation, live);
  compareSets(divergences, 'index', expectation.indexes, new Set(live.indexes));
  // Absence only. The chain adds constraints in raw SQL that the snapshot does
  // not model, so a constraint the snapshot does not record is not evidence the
  // database grew one outside the chain.
  const liveConstraints = new Set(live.constraints);
  for (const name of new Set(expectation.constraints)) {
    if (!liveConstraints.has(name)) {
      divergences.push({ kind: 'constraint', direction: 'absent', name });
    }
  }
  return divergences;
}

/**
 * Enum value lists are compared in order: the order is the enum's sort order,
 * which comparisons against an enum column resolve through.
 */
function compareEnums(into: Divergence[], expectation: SchemaExpectation, live: LiveCatalog): void {
  const liveEnums = new Map(live.enums.map((entry) => [entry.name, entry.values]));
  compareSets(
    into,
    'enum',
    expectation.enums.map((entry) => entry.name),
    new Set(liveEnums.keys())
  );
  for (const entry of expectation.enums) {
    const values = liveEnums.get(entry.name);
    if (values === undefined) continue;
    if (values.join(', ') === entry.values.join(', ')) continue;
    into.push({
      kind: 'enum',
      direction: 'differs',
      name: entry.name,
      detail: `the migrations record values ${entry.values.join(', ')}; the database has ${values.join(', ')}`,
    });
  }
}

/**
 * Columns are compared only on relations the database holds: a relation that is
 * absent altogether is one finding, not one per column it took with it.
 *
 * Nullability is compared on table columns alone. The catalog reports every
 * view column as nullable whatever the view's query guarantees, so a view
 * column's recorded `notNull` has nothing faithful to compare against.
 */
function compareColumns(
  into: Divergence[],
  expectation: SchemaExpectation,
  live: LiveCatalog,
  canonicalType: ReadonlyMap<string, string>
): void {
  const present = new Set(live.relations.map((relation) => relation.name));
  const expectedRelations = new Set(expectation.columns.map((column) => column.relation));
  const liveColumns = new Map(live.columns.map((column) => [columnName(column), column]));
  const expectedColumns = new Set(expectation.columns.map((column) => columnName(column)));

  for (const column of expectation.columns) {
    if (!present.has(column.relation)) continue;
    into.push(...columnDifferences(column, liveColumns.get(columnName(column)), canonicalType));
  }
  for (const column of live.columns) {
    if (!expectedRelations.has(column.relation)) continue;
    const name = columnName(column);
    if (!expectedColumns.has(name)) into.push({ kind: 'column', direction: 'unexpected', name });
  }
}

function columnName(column: { readonly relation: string; readonly column: string }): string {
  return `${column.relation}.${column.column}`;
}

/** How one recorded column and the database's answer for it disagree. */
function columnDifferences(
  expected: ExpectedColumn,
  actual: { readonly type: string; readonly notNull: boolean } | undefined,
  canonicalType: ReadonlyMap<string, string>
): Divergence[] {
  const name = columnName(expected);
  if (actual === undefined) return [{ kind: 'column', direction: 'absent', name }];
  const differences: Divergence[] = [];
  if (!expected.onView && expected.notNull !== actual.notNull) {
    differences.push({
      kind: 'column',
      direction: 'differs',
      name,
      detail: expected.notNull
        ? 'the migrations record it NOT NULL; the database lets it hold nulls'
        : 'the migrations record it nullable; the database has it NOT NULL',
    });
  }
  const recorded = canonicalType.get(expected.type) ?? expected.type;
  if (recorded !== actual.type) {
    differences.push({
      kind: 'column',
      direction: 'differs',
      name,
      detail: `the migrations record type ${recorded}; the database has ${actual.type}`,
    });
  }
  return differences;
}

/**
 * A set difference in both directions: what the snapshot records and the
 * database lacks, and what the database holds and the snapshot records nowhere.
 */
function compareSets(
  into: Divergence[],
  kind: DivergenceKind,
  expected: readonly string[],
  live: ReadonlySet<string>
): void {
  const expectedSet = new Set(expected);
  for (const name of expectedSet) {
    if (!live.has(name)) into.push({ kind, direction: 'absent', name });
  }
  for (const name of live) {
    if (!expectedSet.has(name)) into.push({ kind, direction: 'unexpected', name });
  }
}

/** Message order, so two runs over the same database read the same. */
const KIND_ORDER: readonly DivergenceKind[] = [
  'table',
  'view',
  'enum',
  'column',
  'index',
  'constraint',
];

function describe(divergence: Divergence): string {
  switch (divergence.direction) {
    case 'absent': {
      return 'the migrations record it; the database does not have it';
    }
    case 'unexpected': {
      return 'the database has it; the recorded schema does not describe it';
    }
    case 'differs': {
      return divergence.detail ?? 'the migrations and the database disagree about it';
    }
  }
}

/**
 * The whole refusal a reader meets. It names every object that diverged and the
 * direction of each, then bounds itself: a reader who takes it for a full
 * schema comparison would read a pass as more than it is.
 */
export function formatDrift(migrationTag: string, divergences: readonly Divergence[]): string {
  const ordered = divergences.toSorted(
    (left, right) =>
      KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) ||
      left.direction.localeCompare(right.direction) ||
      left.name.localeCompare(right.name)
  );
  return [
    // Opens on a line of its own: the migration runner that precedes it leaves
    // its last line unterminated, and this report's first line is the one a
    // reader must not lose.
    `\nSchema drift: the database does not match the schema the migration chain records at ${migrationTag}.`,
    ...ordered.map(
      (divergence) => `  ${divergence.kind} ${divergence.name}: ${describe(divergence)}`
    ),
    'What was compared: tables, views, enums with their value lists, the columns of every table',
    'and view both sides name (name, type, and NOT NULL on table columns), indexes that back no',
    'constraint, and unique, check, foreign-key and primary-key constraints — those last only in',
    'the absent direction, because the snapshot does not describe every constraint the chain',
    'creates. What was not: the text of view and check-constraint definitions, which Postgres',
    'stores in its own rewritten form, and functions and triggers, which `pnpm verify:db-objects`',
    'compares.',
    'Either the database was changed outside its migration chain, or a migration creates one of',
    'the objects above in raw SQL the snapshot does not describe. Locally, `pnpm db:reset`',
    'rebuilds the database from the chain.',
  ].join('\n');
}

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * The one schema the catalog side of the comparison reads. A snapshot object
 * anywhere else would be compared against nothing and pass, so it is refused
 * instead. Drizzle spells the default schema as the empty string on a table and
 * by name on a view or an enum.
 */
const COMPARED_SCHEMA = 'public';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, source: string, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(
      `schema drift: the migration snapshot ${source} has a shape this check does not recognise — "${field}" is not a set of objects`
    );
  }
  return value;
}

function assertComparedSchema(
  entries: Record<string, unknown>,
  source: string,
  allowUnnamedDefault: boolean
): void {
  for (const [key, entry] of Object.entries(entries)) {
    const schema = isRecord(entry) ? entry['schema'] : undefined;
    if (schema === COMPARED_SCHEMA) continue;
    if (allowUnnamedDefault && schema === '') continue;
    throw new Error(
      `schema drift: the migration snapshot ${source} records "${key}" outside the ${COMPARED_SCHEMA} schema, which this check does not read`
    );
  }
}

/**
 * Turns a snapshot document into the shape this check reads, refusing anything
 * it could not compare faithfully. A snapshot this check silently read as empty
 * would pass every database, which is the failure it exists to prevent.
 */
export function parseSnapshot(document: unknown, source: string): MigrationSnapshot {
  const root = requireRecord(document, source, 'the document');
  const tables = requireRecord(root['tables'], source, 'tables');
  const views = requireRecord(root['views'], source, 'views');
  const enums = requireRecord(root['enums'], source, 'enums');
  if (Object.keys(tables).length === 0) {
    throw new Error(`schema drift: the migration snapshot ${source} records no table`);
  }
  assertComparedSchema(tables, source, true);
  assertComparedSchema(views, source, false);
  assertComparedSchema(enums, source, false);
  // The three containers are checked above; the entries inside them are not,
  // because the migration tooling owns their shape and a field missing from one
  // reaches the comparison as an object named `undefined` — reported, never
  // silently skipped.
  // eslint-disable-next-line no-restricted-syntax -- the migration tooling owns each entry's shape, and a field missing from one is reported by the comparison above rather than refused here
  return { tables, views, enums } as unknown as MigrationSnapshot;
}

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
}

/** The migration a journal ends with. */
export function latestEntry(entries: readonly JournalEntry[]): JournalEntry {
  const latest = entries.at(-1);
  if (latest === undefined) {
    throw new Error('schema drift: the migration journal records no migration');
  }
  return latest;
}

/** The migration the journal ends with, and the schema that migration produces. */
export function readLatestSnapshot(): { tag: string; snapshot: MigrationSnapshot } {
  // The journal's shape is the migration tooling's, read here as the rehearsal
  // reads it; a journal with no entry is refused rather than assumed.
  const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8')) as {
    entries: readonly JournalEntry[];
  };
  const latest = latestEntry(journal.entries);
  const file = `${String(latest.idx).padStart(4, '0')}_snapshot.json`;
  const document: unknown = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/${file}`, 'utf8'));
  return { tag: latest.tag, snapshot: parseSnapshot(document, file) };
}

/**
 * Everything the comparison reads, in one round trip.
 *
 * Two catalog shapes are deliberately narrowed. An index that backs a primary
 * key or a unique constraint is one object to Postgres and a constraint to the
 * snapshot, so counting it as an index too would report every one of them as
 * unexpected. And a NOT NULL is a `pg_constraint` row of its own on this server,
 * which the snapshot records as a column flag instead, so the constraint side
 * takes only the four kinds the snapshot names.
 */
async function readLiveCatalog(db: Database): Promise<LiveCatalog> {
  const result = await db.execute(sql`
    select json_build_object(
      'relations', (
        select coalesce(json_agg(json_build_object(
          'name', c.relname, 'isView', c.relkind in ('v', 'm')
        ) order by c.relname), '[]'::json)
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = ${COMPARED_SCHEMA} and c.relkind in ('r', 'p', 'v', 'm')
      ),
      'columns', (
        select coalesce(json_agg(json_build_object(
          'relation', c.relname, 'column', a.attname,
          'type', format_type(a.atttypid, a.atttypmod), 'notNull', a.attnotnull
        ) order by c.relname, a.attnum), '[]'::json)
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where n.nspname = ${COMPARED_SCHEMA} and c.relkind in ('r', 'p', 'v', 'm')
      ),
      'enums', (
        select coalesce(json_agg(json_build_object('name', t.typname, 'values', v.values) order by t.typname), '[]'::json)
        from pg_type t join pg_namespace n on n.oid = t.typnamespace
        join lateral (
          select json_agg(e.enumlabel order by e.enumsortorder) as values
          from pg_enum e where e.enumtypid = t.oid
        ) v on true
        where n.nspname = ${COMPARED_SCHEMA} and t.typtype = 'e'
      ),
      'indexes', (
        select coalesce(json_agg(i.relname order by i.relname), '[]'::json)
        from pg_index x join pg_class i on i.oid = x.indexrelid
        join pg_namespace n on n.oid = i.relnamespace
        where n.nspname = ${COMPARED_SCHEMA} and not x.indisprimary
          and not exists (
            select 1 from pg_depend d
            where d.classid = 'pg_class'::regclass and d.objid = x.indexrelid
              and d.deptype = 'i' and d.refclassid = 'pg_constraint'::regclass
          )
      ),
      'constraints', (
        select coalesce(json_agg(k.conname order by k.conname), '[]'::json)
        from pg_constraint k join pg_namespace n on n.oid = k.connamespace
        where n.nspname = ${COMPARED_SCHEMA} and k.contype in ('u', 'c', 'f', 'p')
      )
    ) as catalog
  `);
  return catalogFromRows(result.rows);
}

/** The one row the catalog query answers, or a refusal naming what was missing. */
export function catalogFromRows(rows: readonly Record<string, unknown>[]): LiveCatalog {
  const row = rows[0];
  if (row === undefined) {
    throw new Error('schema drift: the database answered no catalog');
  }
  // The column is the object this module's own query builds, key by key.
  return row['catalog'] as LiveCatalog;
}

/**
 * The database's own spelling of each recorded type. The snapshot writes the
 * type as the schema author typed it and the catalog reports it as Postgres
 * renders it, so the two are compared only after the same server has rendered
 * both. A type this database does not know answers nothing and keeps the
 * recorded spelling, which then reports as a difference.
 */
async function canonicalTypes(
  db: Database,
  types: readonly string[]
): Promise<Map<string, string>> {
  const result = await db.execute(sql`
    select coalesce(
      json_object_agg(t, format_type(to_regtype(t), to_regtypemod(t))), '{}'::json
    ) as types
    from unnest(${sql.param([...types])}::text[]) t
  `);
  return renderedTypes(result.rows);
}

/**
 * The rendered spelling of each type the database knows. One it does not know
 * renders as nothing and is dropped, leaving the recorded spelling to be
 * compared as it stands — which is itself a difference, and reads as one.
 */
export function renderedTypes(rows: readonly Record<string, unknown>[]): Map<string, string> {
  const rendered = (rows[0]?.['types'] ?? {}) as Record<string, string | null>;
  return new Map(
    Object.entries(rendered).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

/** The snapshot's tag and every way the database disagrees with it. */
async function inspect(db: Database): Promise<{ tag: string; divergences: Divergence[] }> {
  const { tag, snapshot } = readLatestSnapshot();
  const expectation = expectationFrom(snapshot);
  const live = await readLiveCatalog(db);
  const canonical = await canonicalTypes(db, [
    ...new Set(expectation.columns.map((column) => column.type)),
  ]);
  return { tag, divergences: compareSchema(expectation, live, canonical) };
}

/** Every way the database disagrees with the schema its chain records. */
export async function checkSchemaDrift(db: Database): Promise<Divergence[]> {
  const { divergences } = await inspect(db);
  return divergences;
}

/** The migration step's refusal: drift denies the step and names what diverged. */
export async function assertNoSchemaDrift(db: Database): Promise<void> {
  const { tag, divergences } = await inspect(db);
  if (divergences.length > 0) throw new Error(formatDrift(tag, divergences));
}

/** Host and database name, the identity two connection strings must share. */
function target(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.pathname.replace(/^\//, '')} on ${url.hostname}`;
}

/**
 * Refuses a pair of connection strings that reach different databases. The
 * check reads the database the migration step just wrote, and it reads it over
 * a different transport than the migration used, so the one thing that must
 * hold is that both strings name the same database on the same host. Their
 * credentials never reach the message.
 */
export function assertSameDatabase(readUrl: string, migratedUrl: string): void {
  const read = target(readUrl);
  const migrated = target(migratedUrl);
  if (read === migrated) return;
  throw new Error(
    `schema drift: the migration ran against ${migrated} and this check reads ${read}; a database cannot be checked through a connection that names another one`
  );
}
