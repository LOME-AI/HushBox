import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, newsletterIssues } from '@hushbox/db';
import { HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  cancelIssueWithinTx,
  createIssueWithinTx,
  getIssueById,
  listIssues,
  mustInsertedRow,
} from './issue-stores.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for newsletter issue store tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const createdIssueIds: string[] = [];

const CREATED_BY = 'admin@hushbox.ai';

async function newIssue(
  overrides: Partial<Parameters<typeof createIssueWithinTx>[1]> = {}
): Promise<typeof newsletterIssues.$inferSelect> {
  const issue = await db.transaction((tx) =>
    createIssueWithinTx(tx, {
      subject: `Issue ${crypto.randomUUID().slice(0, 8)}`,
      bodyMarkdown: 'Hello **world**',
      scheduledAt: new Date(TEST_DAY_START + 9 * HOUR_MS),
      createdBy: CREATED_BY,
      ...overrides,
    })
  );
  createdIssueIds.push(issue.id);
  return issue;
}

afterAll(async () => {
  if (createdIssueIds.length > 0) {
    await db.delete(newsletterIssues).where(inArray(newsletterIssues.id, createdIssueIds));
  }
  await db.$client.end();
});

describe('createIssueWithinTx', () => {
  it('creates a scheduled issue row', async () => {
    const issue = await newIssue();

    expect(issue.status).toBe('scheduled');
    expect(issue.subject).toContain('Issue ');
    expect(issue.bodyMarkdown).toBe('Hello **world**');
    expect(issue.createdBy).toBe(CREATED_BY);
    expect(issue.sentAt).toBeNull();
  });

  it('rolls back with the enclosing transaction', async () => {
    let issueId = '';
    await db
      .transaction(async (tx) => {
        const issue = await createIssueWithinTx(tx, {
          subject: 'Rolled back',
          bodyMarkdown: 'never lands',
          scheduledAt: new Date(),
          createdBy: CREATED_BY,
        });
        issueId = issue.id;
        throw new Error('force rollback');
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'force rollback') throw error;
      });

    const after = await getIssueById(db, issueId);
    expect(after._unsafeUnwrap()).toBeNull();
  });
});

describe('cancelIssueWithinTx', () => {
  it('cancels a scheduled issue atomically', async () => {
    const issue = await newIssue();

    const result = await db.transaction((tx) => cancelIssueWithinTx(tx, issue.id));

    expect(result).toEqual({ kind: 'canceled' });
    const after = await getIssueById(db, issue.id);
    expect(after._unsafeUnwrap()?.status).toBe('canceled');
    expect(after._unsafeUnwrap()?.canceledAt).not.toBeNull();
  });

  it('treats an already-canceled issue as a no-op', async () => {
    const issue = await newIssue();
    await db.transaction((tx) => cancelIssueWithinTx(tx, issue.id));

    const result = await db.transaction((tx) => cancelIssueWithinTx(tx, issue.id));

    expect(result).toEqual({ kind: 'already-canceled' });
  });

  it.each(['sending', 'sent'] as const)('reports %s as an illegal state', async (status) => {
    const issue = await newIssue();
    await db
      .update(newsletterIssues)
      .set({ status })
      .where(inArray(newsletterIssues.id, [issue.id]));

    const result = await db.transaction((tx) => cancelIssueWithinTx(tx, issue.id));

    expect(result).toEqual({ kind: 'illegal-state', status });
  });

  it('reports an unknown issue as not-found', async () => {
    const result = await db.transaction((tx) => cancelIssueWithinTx(tx, crypto.randomUUID()));

    expect(result).toEqual({ kind: 'not-found' });
  });
});

describe('mustInsertedRow', () => {
  it('passes a present row through', async () => {
    const issue = await newIssue();
    expect(mustInsertedRow(issue)).toBe(issue);
  });

  it('throws on a missing row', async () => {
    const rows = await db
      .select()
      .from(newsletterIssues)
      .where(eq(newsletterIssues.id, crypto.randomUUID()));
    expect(() => mustInsertedRow(rows[0])).toThrow(/returned no row/);
  });
});

describe('issue store infra failure mapping', () => {
  it('maps a rejected read to an unavailable domain error', async () => {
    const closedDb = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    await closedDb.$client.end();

    const result = await getIssueById(closedDb, crypto.randomUUID());

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('getIssueById', () => {
  it('reads an issue by id', async () => {
    const issue = await newIssue();

    const result = await getIssueById(db, issue.id);

    expect(result._unsafeUnwrap()?.id).toBe(issue.id);
  });

  it('resolves null for an unknown id', async () => {
    const result = await getIssueById(db, crypto.randomUUID());

    expect(result._unsafeUnwrap()).toBeNull();
  });
});

describe('listIssues', () => {
  it('lists newest-first with keyset pagination', async () => {
    const first = await newIssue();
    const second = await newIssue();
    const third = await newIssue();

    const pageOne = await listIssues(db, { limit: 2 });
    const one = pageOne._unsafeUnwrap();
    const pageOneIds = one.issues.map((issue) => issue.id);
    expect(pageOneIds).toContain(third.id);
    expect(pageOneIds).toContain(second.id);
    expect(one.nextCursor).not.toBeNull();

    const pageTwo = await listIssues(db, { limit: 2, cursor: one.nextCursor ?? undefined });
    const twoIds = pageTwo._unsafeUnwrap().issues.map((issue) => issue.id);
    expect(twoIds).toContain(first.id);
    expect(twoIds).not.toContain(third.id);
  });

  it('reports no next cursor when the last page is exactly full', async () => {
    await newIssue();
    await newIssue();
    // Issues are global — no per-run filter exists — so the window is bounded
    // by reading the whole table first and paging at exactly that size.
    const everything = await listIssues(db, { limit: 10_000 });
    const total = everything._unsafeUnwrap().issues.length;

    const result = await listIssues(db, { limit: total });

    const page = result._unsafeUnwrap();
    expect(page.issues).toHaveLength(total);
    expect(page.nextCursor).toBeNull();
  });

  it('reports a cursor that yields the remaining issue when one more exists', async () => {
    await newIssue();
    await newIssue();
    const everything = await listIssues(db, { limit: 10_000 });
    const all = everything._unsafeUnwrap().issues;
    const oldest = all.at(-1);
    const secondOldest = all.at(-2);

    const first = await listIssues(db, { limit: all.length - 1 });
    const page = first._unsafeUnwrap();
    expect(page.nextCursor).toBe(secondOldest?.id);

    const second = await listIssues(db, {
      limit: all.length - 1,
      cursor: page.nextCursor ?? undefined,
    });
    const rest = second._unsafeUnwrap();
    expect(rest.issues.map((issue) => issue.id)).toEqual([oldest?.id]);
    expect(rest.nextCursor).toBeNull();
  });

  it('reports the end of the list with a null cursor', async () => {
    const issue = await newIssue();

    const page = await listIssues(db, { limit: 1, cursor: issue.id });
    // Older issues from other runs may exist; walking from the newest issue
    // of THIS run must terminate with a null cursor eventually.
    let cursor = page._unsafeUnwrap().nextCursor;
    let hops = 0;
    while (cursor !== null && hops < 500) {
      const next = await listIssues(db, { limit: 200, cursor });
      cursor = next._unsafeUnwrap().nextCursor;
      hops += 1;
    }
    expect(cursor).toBeNull();
  });
});
