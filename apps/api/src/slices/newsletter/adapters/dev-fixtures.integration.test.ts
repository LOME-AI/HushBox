import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, newsletterSubscribers } from '@hushbox/db';
import { mintNewsletterSubscribers } from './dev-fixtures.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for newsletter dev-fixture tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const mintedIds: string[] = [];

afterAll(async () => {
  if (mintedIds.length > 0) {
    await db.delete(newsletterSubscribers).where(inArray(newsletterSubscribers.id, mintedIds));
  }
  await db.$client.end();
});

describe('mintNewsletterSubscribers', () => {
  it('mints the requested count with unique emails', async () => {
    const { subscribers } = await mintNewsletterSubscribers(db, { count: 2 });
    mintedIds.push(...subscribers.map((row) => row.id));

    expect(subscribers).toHaveLength(2);
    expect(new Set(subscribers.map((row) => row.email)).size).toBe(2);
  });

  it('gives a pending subscriber a confirm token the confirmation flow can spend', async () => {
    const { subscribers } = await mintNewsletterSubscribers(db, {
      count: 1,
      status: 'pending',
      emailPrefix: 'nl-pending',
    });
    mintedIds.push(...subscribers.map((row) => row.id));

    const [minted] = subscribers;
    expect(minted?.confirmToken).toEqual(expect.any(String));

    const [row] = await db
      .select({ confirmExpiresAt: newsletterSubscribers.confirmExpiresAt })
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.id, minted?.id ?? ''));
    expect(row?.confirmExpiresAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
  });
});
