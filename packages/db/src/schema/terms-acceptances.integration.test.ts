import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';
import { userFactory } from '../factories';
import { refusalConstraint } from './__tests__/shape-helpers';
import { termsAcceptances, users } from './index';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle'
);

let db: Database;
const insertedUserIds: string[] = [];

/**
 * Every test inserts the account it needs, so each one passes run alone and no
 * test depends on a row another left behind.
 */
async function insertUser(): Promise<string> {
  const [row] = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
  if (!row) throw new Error('user insert returned no row');
  insertedUserIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  // Deleting the account cascades its acceptance rows away, keeping local reruns clean.
  for (const id of insertedUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  await db.$client.end();
});

describe('terms_acceptances', () => {
  it('records the revision an account accepted', async () => {
    const userId = await insertUser();
    const [row] = await db.insert(termsAcceptances).values({ userId, revision: 1 }).returning();
    expect(row?.userId).toBe(userId);
    expect(row?.revision).toBe(1);
    expect(row?.acceptedAt).toBeInstanceOf(Date);
  });

  it('keeps a later revision beside the earlier acceptance', async () => {
    const userId = await insertUser();
    await db.insert(termsAcceptances).values({ userId, revision: 1 });
    await db.insert(termsAcceptances).values({ userId, revision: 2 });

    const revisions = await db
      .select({ revision: termsAcceptances.revision })
      .from(termsAcceptances)
      .where(eq(termsAcceptances.userId, userId));
    expect(revisions.map((r) => r.revision).toSorted((a, b) => a - b)).toEqual([1, 2]);
  });

  it('refuses a second acceptance of the same revision', async () => {
    const userId = await insertUser();
    await db.insert(termsAcceptances).values({ userId, revision: 1 });

    const refusal = await refusalConstraint(
      db.insert(termsAcceptances).values({ userId, revision: 1 })
    );
    expect(refusal).toBe('terms_acceptances_user_revision_unique');
  });

  it('refuses a revision of zero', async () => {
    const userId = await insertUser();
    const refusal = await refusalConstraint(
      db.insert(termsAcceptances).values({ userId, revision: 0 })
    );
    expect(refusal).toBe('terms_acceptances_revision_positive');
  });

  it('removes the acceptance rows when the account is deleted', async () => {
    const userId = await insertUser();
    await db.insert(termsAcceptances).values({ userId, revision: 1 });

    await db.delete(users).where(eq(users.id, userId));

    const after = await db
      .select()
      .from(termsAcceptances)
      .where(eq(termsAcceptances.userId, userId));
    expect(after).toEqual([]);
  });
});
