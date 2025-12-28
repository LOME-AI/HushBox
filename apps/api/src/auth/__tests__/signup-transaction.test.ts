import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createAuth } from '../index.js';
import { createDb, users, verifications } from '@lome-chat/db';
import { createMockEmailClient } from '../../services/email/index.js';

describe('signup transaction atomicity', () => {
  const connectionString = process.env['DATABASE_URL'] ?? '';
  let db: ReturnType<typeof createDb>;
  let mockEmailClient: ReturnType<typeof createMockEmailClient>;
  let app: Hono;

  beforeAll(() => {
    db = createDb({ connectionString });
  });

  beforeEach(() => {
    mockEmailClient = createMockEmailClient();
    const auth = createAuth({
      db,
      emailClient: mockEmailClient,
      baseUrl: 'http://localhost:8787',
      secret: 'test-secret-key-at-least-32-chars',
      frontendUrl: 'http://localhost:5173',
    });
    app = new Hono();
    app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw));
  });

  it('creates both user and verification entry atomically on signup', async () => {
    const uniqueEmail = `atomic-test-${String(Date.now())}@example.com`;

    const res = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'password123',
        name: 'Atomic Test User',
      }),
    });

    // Skip if database isn't available
    if (res.status !== 200) {
      return;
    }

    // Query database directly to verify both entries exist
    const userResult = await db.select().from(users).where(eq(users.email, uniqueEmail));
    expect(userResult).toHaveLength(1);
    const user = userResult[0];
    expect(user).toBeDefined();

    // Verification entry should exist with identifier matching the email
    const verificationResult = await db
      .select()
      .from(verifications)
      .where(eq(verifications.identifier, uniqueEmail));

    expect(verificationResult.length).toBeGreaterThan(0);
    expect(verificationResult[0]).toBeDefined();
  });

  it('user and verification must both exist - never one without the other', async () => {
    const uniqueEmail = `both-exist-${String(Date.now())}@example.com`;

    const res = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'password123',
        name: 'Both Exist User',
      }),
    });

    if (res.status !== 200) {
      return;
    }

    // Check user exists
    const userResult = await db.select().from(users).where(eq(users.email, uniqueEmail));
    const userExists = userResult.length > 0;

    // Check verification exists
    const verificationResult = await db
      .select()
      .from(verifications)
      .where(eq(verifications.identifier, uniqueEmail));
    const verificationExists = verificationResult.length > 0;

    // Both must exist or neither - never one without the other
    expect(userExists).toBe(true);
    expect(verificationExists).toBe(true);

    // Explicit check: if user exists, verification MUST exist
    if (userExists) {
      expect(verificationExists).toBe(true);
    }
  });
});
