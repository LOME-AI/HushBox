import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';

import { createDb, type Database } from '../client';
import { users } from '../schema/index';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/lome_chat';

describe('createDb', () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(DATABASE_URL);
  });

  it('creates a database instance', () => {
    expect(db).toBeDefined();
    expect(typeof db.select).toBe('function');
    expect(typeof db.insert).toBe('function');
    expect(typeof db.update).toBe('function');
    expect(typeof db.delete).toBe('function');
  });

  describe('integration tests', () => {
    const testEmail = `test-${String(Date.now())}@example.com`;

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

      expect(inserted).toBeDefined();
      expect(inserted.id).toBeDefined();
      expect(inserted.email).toBe(testEmail);
      expect(inserted.name).toBe('Test User');
      expect(inserted.createdAt).toBeInstanceOf(Date);
      expect(inserted.updatedAt).toBeInstanceOf(Date);

      const [selected] = await db.select().from(users).where(eq(users.email, testEmail));

      expect(selected).toBeDefined();
      expect(selected.id).toBe(inserted.id);
      expect(selected.email).toBe(testEmail);
    });

    it('updates a user', async () => {
      const [updated] = await db
        .update(users)
        .set({ name: 'Updated Name' })
        .where(eq(users.email, testEmail))
        .returning();

      expect(updated).toBeDefined();
      expect(updated.name).toBe('Updated Name');
    });
  });
});
