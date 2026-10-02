import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getTableConfig, getViewConfig, isPgView, PgTable } from 'drizzle-orm/pg-core';

import * as schema from '../index';

import type { PgView } from 'drizzle-orm/pg-core';

/**
 * The `growth_reader` role is default-deny: its migration revokes everything in
 * the schema and grants SELECT back on these aggregate views alone, so this list
 * is the whole of the role's reach into user data.
 */
const GROWTH_READER_VIEWS: readonly string[] = [
  'acquisition_sources',
  'funnel_weekly',
  'growth_weekly',
  'marketing_daily',
  'marketing_hourly',
];

const ROLE = 'growth_reader';

const drizzleDirectory = new URL('../../../drizzle/', import.meta.url);

/** A comment quoting a GRANT is not a GRANT. */
function stripLineComments(sql: string): string {
  return sql.replaceAll(/--[^\n]*/g, '');
}

function splitList(clause: string): readonly string[] {
  return clause
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * `TABLE "public"."funnel_weekly"` and `funnel_weekly` name one relation, and the
 * leading qualified identifier is the whole of that name: a target read whole reads
 * `"public"."funnel_weekly" CASCADE` as some other relation, which hides the drop
 * from the re-grant assertion and passes it over a destroyed grant. A blanket clause
 * (`ALL TABLES IN SCHEMA public`) names a set rather than one relation, so it is kept
 * whole for the table assertion to match on.
 */
function relationName(target: string): string {
  const collapsed = target.trim().replaceAll(/\s+/g, ' ');
  if (/^(?:ALL|SCHEMA)\b/i.test(collapsed)) return collapsed.toLowerCase();
  const unqualified = collapsed
    .replace(/^TABLE /i, '')
    .replaceAll('"', '')
    .replace(/^[\w$]+ ?\. ?/, '');
  return (/^[\w$]+/.exec(unqualified)?.[0] ?? unqualified).toLowerCase();
}

function byName(a: string, b: string): number {
  return a.localeCompare(b);
}

interface Migration {
  readonly tag: string;
  /** Offset of this file in the concatenated chain, so statement positions order globally. */
  readonly start: number;
  readonly sql: string;
}

/** `meta/_journal.json`, not the filenames, is the order Postgres applies the chain in. */
const CHAIN: readonly Migration[] = ((): readonly Migration[] => {
  const journal = JSON.parse(
    readFileSync(new URL('meta/_journal.json', drizzleDirectory), 'utf8')
  ) as { readonly entries: readonly { readonly idx: number; readonly tag: string }[] };
  let start = 0;
  return journal.entries
    .toSorted((a, b) => a.idx - b.idx)
    .map((entry) => {
      const sql = stripLineComments(
        readFileSync(new URL(`${entry.tag}.sql`, drizzleDirectory), 'utf8')
      );
      const migration: Migration = { tag: entry.tag, start, sql };
      start += sql.length;
      return migration;
    });
})();

interface Statement {
  readonly tag: string;
  /** Position in the concatenated chain — the ordering key the re-grant invariant rests on. */
  readonly at: number;
  readonly targets: readonly string[];
}

interface Grant extends Statement {
  readonly objectClause: string;
  readonly grantees: readonly string[];
}

/** Bounded at `;`: a GRANT with no `ON` — role membership — must not splice into the next statement. */
const GRANTS: readonly Grant[] = CHAIN.flatMap((migration) =>
  [...migration.sql.matchAll(/\bGRANT\b[^;]*?\bON\b([^;]*?)\bTO\b([^;]*)/gi)].map((match) => {
    const objectClause = (match[1] ?? '').trim();
    const grantees = (match[2] ?? '').split(/\bWITH\b/i)[0] ?? '';
    return {
      tag: migration.tag,
      at: migration.start + match.index,
      objectClause,
      targets: splitList(objectClause).map((target) => relationName(target)),
      grantees: splitList(grantees).map((grantee) => grantee.replaceAll('"', '').toLowerCase()),
    };
  })
);

const VIEW_DROPS: readonly Statement[] = CHAIN.flatMap((migration) =>
  [
    ...migration.sql.matchAll(/\bDROP\s+(?:MATERIALIZED\s+)?VIEW\b(?:\s+IF\s+EXISTS\b)?([^;]*)/gi),
  ].map((match) => ({
    tag: migration.tag,
    at: migration.start + match.index,
    targets: splitList(match[1] ?? '').map((target) => relationName(target)),
  }))
);

function isSchemaGrant(grant: Grant): boolean {
  return /^SCHEMA\b/i.test(grant.objectClause);
}

const roleRelationGrants = GRANTS.filter(
  (grant) => grant.grantees.includes(ROLE) && !isSchemaGrant(grant)
);

/** The chain is built in apply order, so the last match is the last statement to run. */
function lastTouching(statements: readonly Statement[], relation: string): Statement | undefined {
  return statements.findLast((statement) => statement.targets.includes(relation));
}

const schemaViewNames = (Object.values(schema) as unknown[])
  .filter((value): value is PgView => isPgView(value))
  .map((view) => getViewConfig(view).name);

const schemaTableNames = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => value instanceof PgTable)
  .map((table) => getTableConfig(table).name);

/**
 * This scan reads migration text, so what it sees turns on the statement form its
 * patterns match — a `GRANT … ON … TO` ({@link GRANTS}) and a DROP that destroys one
 * ({@link VIEW_DROPS}) — and not on whether a relation is named. An
 * `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO growth_reader`
 * names no relation and carries that form, so the scan sees it; a widening written in
 * any other form is invisible however concretely it names one: membership in a role
 * that already reads (a GRANT with no `ON`), transfer of a relation's ownership, a role
 * attribute such as SUPERUSER or BYPASSRLS. It earns its place by naming the offending
 * migration at commit time with no database. What the role actually holds is read from
 * the live catalog in
 * `packages/db/src/schema/growth-reader-privileges.integration.test.ts`, which asks
 * Postgres a question of its own for every granularity at which a widening can hide,
 * because an answer at one granularity is silent about the others.
 */
describe('growth reader readable set', () => {
  it('scans every migration file in the drizzle directory', () => {
    const files = readdirSync(drizzleDirectory)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.slice(0, -'.sql'.length))
      .toSorted(byName);
    expect(CHAIN.map((migration) => migration.tag).toSorted(byName)).toEqual(files);
  });

  it('declares only views the schema barrel exports', () => {
    const known = new Set(schemaViewNames);
    expect(GROWTH_READER_VIEWS.filter((view) => !known.has(view))).toEqual([]);
  });

  it('grants the role exactly the declared views', () => {
    const granted = [...new Set(roleRelationGrants.flatMap((grant) => grant.targets))].toSorted(
      byName
    );
    expect(granted).toEqual([...GROWTH_READER_VIEWS].toSorted(byName));
  });

  it('grants the role nothing on a table', () => {
    const tables = new Set(schemaTableNames);
    const onTables = roleRelationGrants
      .flatMap((grant) => grant.targets)
      .filter((target) => tables.has(target) || /\ball\s+tables\b/i.test(target))
      .toSorted(byName);
    expect(onTables).toEqual([]);
  });

  it('routes no privilege to PUBLIC on a relation', () => {
    const widened = GRANTS.filter(
      (grant) => grant.grantees.includes('public') && !isSchemaGrant(grant)
    ).map((grant) => `${grant.tag}: GRANT ON ${grant.objectClause} TO PUBLIC`);
    expect(widened).toEqual([]);
  });

  it('re-grants every declared view after the last statement that drops it', () => {
    const destroyed = GROWTH_READER_VIEWS.map((view): string | undefined => {
      const grant = lastTouching(roleRelationGrants, view);
      const drop = lastTouching(VIEW_DROPS, view);
      if (drop === undefined || (grant !== undefined && grant.at > drop.at)) return undefined;
      return `${view}: dropped by ${drop.tag}, last granted by ${grant?.tag ?? 'nothing'}`;
    }).filter((failure): failure is string => failure !== undefined);
    expect(destroyed).toEqual([]);
  });
});
