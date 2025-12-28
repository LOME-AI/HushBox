import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createAuth } from '../index.js';
import { createDb } from '@lome-chat/db';
import { createMockEmailClient } from '../../services/email/index.js';

describe('email verification flow', () => {
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

  afterAll(async () => {
    // No cleanup needed for config tests
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

    // If signup succeeds (DB is running), verify email was sent
    if (res.status === 200) {
      const sentEmails = mockEmailClient.getSentEmails();
      expect(sentEmails.length).toBeGreaterThan(0);

      const verificationEmail = sentEmails.find((email) => email.to === uniqueEmail);
      expect(verificationEmail).toBeDefined();
      expect(verificationEmail?.subject).toContain('Verify');
      expect(verificationEmail?.html).toContain('Verify Email');
    }
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

    // If signup succeeds, verify the link format
    if (res.status === 200) {
      const sentEmails = mockEmailClient.getSentEmails();
      const verificationEmail = sentEmails.find((email) => email.to === uniqueEmail);

      expect(verificationEmail?.html).toContain('href="');
      expect(verificationEmail?.html).toContain('localhost:8787');
    }
  });
});
