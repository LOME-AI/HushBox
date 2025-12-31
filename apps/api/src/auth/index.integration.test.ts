import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createAuth } from './index.js';
import { createDb, LOCAL_NEON_DEV_CONFIG, users } from '@lome-chat/db';
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

describe('sign-in flow', () => {
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

  it('returns generic error for non-existent user (prevents email enumeration)', async () => {
    const res = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'nonexistent@example.com',
        password: 'password123',
      }),
    });

    expect(res.status).toBe(401);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const body = (await res.json()) as { message: string };
    // Error message should be generic to prevent email enumeration
    expect(body.message).toBe('Invalid email or password');
  });

  it('returns generic error for wrong password (same as non-existent user)', async () => {
    const uniqueEmail = `test-wrongpw-${String(Date.now())}@example.com`;

    // Create user via sign-up
    await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'correctpassword',
        name: 'Test User',
      }),
    });

    // Try to sign in with wrong password
    const res = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'wrongpassword',
      }),
    });

    expect(res.status).toBe(401);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const body = (await res.json()) as { message: string };
    // Error message should be identical to non-existent user case
    expect(body.message).toBe('Invalid email or password');
  });

  it('returns error for unverified email', async () => {
    const uniqueEmail = `test-unverified-${String(Date.now())}@example.com`;

    // Create user via sign-up (email not verified)
    await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'password123',
        name: 'Test User',
      }),
    });

    // Try to sign in without verifying email
    const res = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'password123',
      }),
    });

    expect(res.status).toBe(403);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('Email not verified');
  });

  it('succeeds with valid credentials and verified email', async () => {
    const uniqueEmail = `test-verified-${String(Date.now())}@example.com`;

    // Create user via sign-up
    await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'password123',
        name: 'Test User',
      }),
    });

    // Manually verify email in database
    await db.update(users).set({ emailVerified: true }).where(eq(users.email, uniqueEmail));

    // Sign in with verified email
    const res = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'password123',
      }),
    });

    expect(res.status).toBe(200);
    // Should have Set-Cookie header with session
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('better-auth.session_token');
  });
});

describe('session validation', () => {
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

  it('get-session returns user data with valid session cookie', async () => {
    const uniqueEmail = `test-session-${String(Date.now())}@example.com`;

    // Create and verify user
    await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'password123',
        name: 'Test User',
      }),
    });
    await db.update(users).set({ emailVerified: true }).where(eq(users.email, uniqueEmail));

    // Sign in to get session cookie
    const signInRes = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'password123',
      }),
    });

    const setCookie = signInRes.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();

    // Extract cookie value for next request
    const cookieMatch = setCookie?.match(/better-auth\.session_token=([^;]+)/);
    expect(cookieMatch).toBeTruthy();
    if (!cookieMatch?.[1]) throw new Error('cookieMatch should have capture group');
    const sessionCookie = `better-auth.session_token=${cookieMatch[1]}`;

    // Get session with cookie
    const sessionRes = await app.request('/api/auth/get-session', {
      method: 'GET',
      headers: { Cookie: sessionCookie },
    });

    expect(sessionRes.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const body = (await sessionRes.json()) as { user: { email: string } };
    expect(body.user).toBeDefined();
    expect(body.user.email).toBe(uniqueEmail);
  });

  it('get-session returns null without session cookie', async () => {
    const sessionRes = await app.request('/api/auth/get-session', {
      method: 'GET',
    });

    expect(sessionRes.status).toBe(200);
    const body = await sessionRes.json();
    // Better Auth returns null for the entire body when no session
    expect(body).toBeNull();
  });
});

describe('sign-up validation', () => {
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

  it('creates user record in database', async () => {
    const uniqueEmail = `test-create-${String(Date.now())}@example.com`;

    const res = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'password123',
        name: 'Test User',
      }),
    });

    expect(res.status).toBe(200);

    // Query database directly to verify user was created
    const [user] = await db.select().from(users).where(eq(users.email, uniqueEmail));
    expect(user).toBeDefined();
    if (!user) throw new Error('User should be defined');
    expect(user.email).toBe(uniqueEmail);
    expect(user.name).toBe('Test User');
    expect(user.emailVerified).toBe(false);
  });

  it('rejects duplicate email', async () => {
    const uniqueEmail = `test-duplicate-${String(Date.now())}@example.com`;

    // First signup
    const firstRes = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'password123',
        name: 'Test User',
      }),
    });
    expect(firstRes.status).toBe(200);

    // Second signup with same email
    const secondRes = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'differentpassword',
        name: 'Another User',
      }),
    });

    expect(secondRes.status).toBe(422);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const body = (await secondRes.json()) as { message: string };
    expect(body.message).toContain('User already exists');
  });
});
