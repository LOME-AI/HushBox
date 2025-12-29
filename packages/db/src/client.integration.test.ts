import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from './client';
import { users } from './schema/index';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:4444/lome_chat';

describe('createDb integration', () => {
  let db: Database;
  const testEmail = `test-${String(Date.now())}@example.com`;

  beforeAll(() => {
    db = createDb({
      connectionString: DATABASE_URL,
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.email, testEmail));
  });

  it('inserts and selects a user', async () => {
    const [inserted] = await db
      .insert(users)
      .values({
        email: testEmail,
        name: 'Test User',
      })
      .returning();

    if (inserted === undefined) {
      throw new Error('Insert failed - no record returned');
    }

    expect(inserted.id).toBeDefined();
    expect(inserted.email).toBe(testEmail);
    expect(inserted.name).toBe('Test User');
    expect(inserted.createdAt).toBeInstanceOf(Date);
    expect(inserted.updatedAt).toBeInstanceOf(Date);

    const [selected] = await db.select().from(users).where(eq(users.email, testEmail));

    if (selected === undefined) {
      throw new Error('Select failed - no record returned');
    }

    expect(selected.id).toBe(inserted.id);
    expect(selected.email).toBe(testEmail);
  });

  it('updates a user', async () => {
    const [updated] = await db
      .update(users)
      .set({ name: 'Updated Name' })
      .where(eq(users.email, testEmail))
      .returning();

    if (updated === undefined) {
      throw new Error('Update failed - no record returned');
    }

    expect(updated.name).toBe('Updated Name');
  });
});
