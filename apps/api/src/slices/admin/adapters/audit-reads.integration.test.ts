import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, adminAudit, createDb } from '@hushbox/db';
import { DAY_MS, HOUR_MS, TEST_YEAR_START } from '@hushbox/shared/test-time';
import { createAdminStores } from './stores.js';
import { createAdminAuditDigestReads, createAdminAuditReads } from './audit-reads.js';
import type { AdminAuditInsertRow } from '../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin audit-read integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createAdminStores();
const reads = createAdminAuditReads();

/** Rows are append-only; per-run actors isolate this suite forever. */
function freshActor(): string {
  return `admin-audit-reads-reads-${crypto.randomUUID()}@hushbox.test`;
}

/** Executed-effect details shape (what the engine writes for real ops). */
function executedDetails(): AdminAuditInsertRow['details'] {
  return { input: {}, effects: [{ label: 'fixture' }], inverseInput: null };
}

async function seedRow(row: Partial<AdminAuditInsertRow> & { actor: string }): Promise<string> {
  const { id } = await stores.insertAudit(db, {
    role: 'operator',
    action: 'fixture.mark',
    details: executedDetails(),
    ...row,
  });
  return id;
}

describe('createAdminAuditReads().search', () => {
  it('returns only the filtered actor’s rows, newest first', async () => {
    const actor = freshActor();
    const first = await seedRow({ actor });
    const second = await seedRow({ actor });
    await seedRow({ actor: freshActor() });

    const result = await reads.search(db, { actor, limit: 10 });

    expect(result.rows.map((row) => row.id)).toEqual([second, first]);
    expect(result.nextCursor).toBeNull();
  });

  it('filters by action', async () => {
    const actor = freshActor();
    await seedRow({ actor });
    const undone = await seedRow({ actor, action: 'fixture.unmark' });

    const result = await reads.search(db, { actor, action: 'fixture.unmark', limit: 10 });

    expect(result.rows.map((row) => row.id)).toEqual([undone]);
  });

  it('filters by target type and id', async () => {
    const actor = freshActor();
    const targetId = `model/${crypto.randomUUID()}`;
    const hit = await seedRow({ actor, targetType: 'model', targetId });
    await seedRow({ actor, targetType: 'model', targetId: `model/${crypto.randomUUID()}` });
    await seedRow({ actor, targetType: 'user', targetId: crypto.randomUUID() });

    const result = await reads.search(db, { targetType: 'model', targetId, limit: 10 });

    expect(result.rows.map((row) => row.id)).toEqual([hit]);
  });

  it('bounds the page by a date range', async () => {
    const actor = freshActor();
    const seeded = await seedRow({ actor });
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    const inside = await reads.search(db, { actor, from: past, to: future, limit: 10 });
    const outside = await reads.search(db, { actor, to: past, limit: 10 });

    expect(inside.rows.map((row) => row.id)).toEqual([seeded]);
    expect(outside.rows).toEqual([]);
  });

  it('paginates with a strictly-older cursor and reports the next cursor', async () => {
    const actor = freshActor();
    const oldest = await seedRow({ actor });
    const middle = await seedRow({ actor });
    const newest = await seedRow({ actor });

    const firstPage = await reads.search(db, { actor, limit: 2 });
    expect(firstPage.rows.map((row) => row.id)).toEqual([newest, middle]);
    expect(firstPage.nextCursor).toBe(middle);

    const secondPage = await reads.search(db, { actor, limit: 2, cursor: firstPage.nextCursor! });
    expect(secondPage.rows.map((row) => row.id)).toEqual([oldest]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('reports no next cursor when the last page is exactly full', async () => {
    const actor = freshActor();
    const oldest = await seedRow({ actor });
    const newest = await seedRow({ actor });

    const page = await reads.search(db, { actor, limit: 2 });

    expect(page.rows.map((row) => row.id)).toEqual([newest, oldest]);
    expect(page.nextCursor).toBeNull();
  });

  it('returns each row’s own stored role', async () => {
    const actor = freshActor();
    const byOperator = await seedRow({ actor });
    const byViewer = await seedRow({ actor, role: 'growth-viewer' });

    const result = await reads.search(db, { actor, limit: 10 });

    // Two rows differing only in role: a projection that dropped the column,
    // or one that hardcoded a value, fails here where one row would pass.
    expect(new Map(result.rows.map((row) => [row.id, row.role]))).toEqual(
      new Map([
        [byViewer, 'growth-viewer'],
        [byOperator, 'operator'],
      ])
    );
  });

  it('threads undoes and undone-by both ways', async () => {
    const actor = freshActor();
    const executed = await seedRow({ actor });
    const undo = await seedRow({ actor, action: 'fixture.unmark', undoes: executed });

    const result = await reads.search(db, { actor, limit: 10 });

    const executedRow = result.rows.find((row) => row.id === executed);
    const undoRow = result.rows.find((row) => row.id === undo);
    expect(executedRow).toMatchObject({ undoes: null, undoneBy: undo });
    expect(undoRow).toMatchObject({ undoes: executed, undoneBy: null });
  });

  it('answers a target search from the (target_type, target_id) index — never a seq scan', async () => {
    // Force the planner to prove index usability: with seq scans disabled the
    // target predicate must still plan onto admin_audit_target_idx.
    const plan = await db.execute(sql`
      BEGIN;
      SET LOCAL enable_seqscan = off;
      EXPLAIN SELECT * FROM admin_audit
        WHERE target_type = 'model' AND target_id = 'openai/gpt-5'
        ORDER BY id DESC LIMIT 20;
    `);
    const planText = JSON.stringify(plan);
    await db.execute(sql`ROLLBACK;`);
    expect(planText).toContain('admin_audit_target_idx');
  });
});

describe('createAdminAuditReads().recent', () => {
  it('returns at most the requested count, newest first', async () => {
    const actor = freshActor();
    await seedRow({ actor });
    await seedRow({ actor });

    const rows = await reads.recent(db, 5);

    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.length).toBeLessThanOrEqual(5);
    const ids = rows.map((row) => row.id);
    const newestFirst = ids.toSorted((a, b) => b.localeCompare(a));
    expect(newestFirst).toEqual(ids);
  });

  it('carries each row’s own role into the dashboard feed', async () => {
    const actor = freshActor();
    const byOperator = await seedRow({ actor });
    const byViewer = await seedRow({ actor, role: 'growth-viewer' });

    const rows = await reads.recent(db, 50);

    const roleOf = new Map(rows.map((row) => [row.id, row.role]));
    expect(roleOf.get(byOperator)).toBe('operator');
    expect(roleOf.get(byViewer)).toBe('growth-viewer');
  });
});

const digestReads = createAdminAuditDigestReads(db);

/**
 * A window read is not actor-filtered, and `admin_audit` refuses DELETE (an
 * append-only trigger), so a day this file seeds stays dirty for the rest of
 * the run and the only isolation available is a day nothing else writes into.
 * Hence a running counter rather than a random draw: consecutive days cannot
 * collide at all, where draws from a finite band can. The counter is also what
 * keeps a retried attempt safe — it takes the next day, so unlike a fixed day
 * per test it never re-seeds a window its predecessor already filled. Nothing
 * survives the run — vitest clones a fresh database per run and drops it at
 * teardown.
 *
 * Days are handed out from 2034 forward. Compare that band with any other
 * suite's as absolute instants, never as day offsets: the other suite seeding
 * `admin_audit` at explicit timestamps counts from a 1990 epoch, so equal
 * offsets there and here name years that are decades apart.
 */
const ISOLATED_BAND_START_MS = TEST_YEAR_START + 3000 * DAY_MS;
let daysHandedOut = 0;

function isolatedWindow(): { since: Date; until: Date } {
  const start = ISOLATED_BAND_START_MS + daysHandedOut * DAY_MS;
  daysHandedOut += 1;
  return { since: new Date(start), until: new Date(start + DAY_MS) };
}

async function seedAt(actor: string, action: string, at: Date): Promise<void> {
  await db.insert(adminAudit).values({
    actor,
    role: 'operator',
    action,
    details: executedDetails(),
    createdAt: at,
  });
}

describe('createAdminAuditDigestReads().actionsInWindow', () => {
  it('hands every caller a day of its own, so no two seeders share a window', () => {
    const first = isolatedWindow();
    const second = isolatedWindow();

    expect(second.since).toEqual(first.until);
  });

  it('returns the window’s actions oldest first', async () => {
    const actor = freshActor();
    const { since, until } = isolatedWindow();
    await seedAt(actor, 'wallet.credit', new Date(since.getTime() + HOUR_MS));
    await seedAt(actor, 'user.lock', new Date(since.getTime() + 2 * HOUR_MS));

    const rows = await digestReads.actionsInWindow({ since, until }, 10);

    expect(rows.map((row) => row.action)).toEqual(['wallet.credit', 'user.lock']);
    expect(rows.map((row) => row.actor)).toEqual([actor, actor]);
  });

  it('excludes an action at the window’s closing instant', async () => {
    const actor = freshActor();
    const { since, until } = isolatedWindow();
    await seedAt(actor, 'user.lock', since);
    await seedAt(actor, 'model.disable', until);

    const rows = await digestReads.actionsInWindow({ since, until }, 10);

    expect(rows.map((row) => row.action)).toEqual(['user.lock']);
  });

  it('drops the oldest actions when the window overruns the cap', async () => {
    const actor = freshActor();
    const { since, until } = isolatedWindow();
    await seedAt(actor, 'user.lock', new Date(since.getTime() + HOUR_MS));
    await seedAt(actor, 'wallet.credit', new Date(since.getTime() + 2 * HOUR_MS));
    await seedAt(actor, 'model.disable', new Date(since.getTime() + 3 * HOUR_MS));

    const rows = await digestReads.actionsInWindow({ since, until }, 2);

    expect(rows.map((row) => row.action)).toEqual(['wallet.credit', 'model.disable']);
  });

  it('reports a targetless action with its null columns intact', async () => {
    const actor = freshActor();
    const { since, until } = isolatedWindow();
    await seedAt(actor, 'model.disable', new Date(since.getTime() + HOUR_MS));

    const rows = await digestReads.actionsInWindow({ since, until }, 10);

    expect(rows).toEqual([
      {
        action: 'model.disable',
        actor,
        targetType: null,
        targetId: null,
        createdAt: new Date(since.getTime() + HOUR_MS),
      },
    ]);
  });
});
