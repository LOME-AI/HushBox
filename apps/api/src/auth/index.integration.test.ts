import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createAuth } from './index.js';
import { createDb, LOCAL_NEON_DEV_CONFIG } from '@lome-chat/db';
import { createMockEmailClient } from '../services/email/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

describe('email verification flow', () => {
  let db: ReturnType<typeof createDb>;
  let mockEmailClient: ReturnType<typeof createMockEmailClient>;
  let app: Hono;

  beforeAll(() => {
    db = createDb({
      connectionString: DATABASE_URL,
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
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

  it('sends verification email on successful signup', async () => {
    const uniqueEmail = `test-${String(Date.now())}@example.com`;

    const res = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'password123',
        name: 'Test User',
      }),
    });

    // Explicit assertion - fails if signup fails
    expect(res.status).toBe(200);

    const sentEmails = mockEmailClient.getSentEmails();
    expect(sentEmails.length).toBeGreaterThan(0);

    const verificationEmail = sentEmails.find((email) => email.to === uniqueEmail);
    expect(verificationEmail).toBeDefined();
    expect(verificationEmail?.subject).toContain('Verify');
    expect(verificationEmail?.html).toContain('Verify Email');
  });

  it('verification email contains correct verification link', async () => {
    const uniqueEmail = `test-link-${String(Date.now())}@example.com`;

    const res = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'password123',
        name: 'Test User',
      }),
    });

    // Explicit assertion - fails if signup fails
    expect(res.status).toBe(200);

    const sentEmails = mockEmailClient.getSentEmails();
    const verificationEmail = sentEmails.find((email) => email.to === uniqueEmail);

    expect(verificationEmail).toBeDefined();
    expect(verificationEmail?.html).toContain('href="');
    expect(verificationEmail?.html).toContain('localhost:8787');
  });
});
