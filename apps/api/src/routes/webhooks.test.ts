/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- json() returns any, assertions provide documentation */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  payments,
  balanceTransactions,
  accounts,
  sessions,
} from '@lome-chat/db';
import { createWebhooksRoutes } from './webhooks.js';
import { createAuthRoutes } from './auth.js';
import { createBillingRoutes } from './billing.js';
import { createAuth } from '../auth/index.js';
import { createMockEmailClient } from '../services/email/index.js';
import { createMockHelcimClient } from '../services/helcim/index.js';
import { sessionMiddleware } from '../middleware/dependencies.js';
import type { AppEnv } from '../types.js';

// Response types for type-safe JSON parsing
interface SignupResponse {
  user?: { id: string };
}

interface WebhookResponse {
  received: boolean;
}

interface CreatePaymentResponse {
  paymentId: string;
  amount: string;
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

describe('webhooks routes', () => {
  const connectionString = DATABASE_URL;
  let db: ReturnType<typeof createDb>;
  let app: Hono<AppEnv>;
  let testUserId: string;
  let authCookie: string;
  let helcimClient: ReturnType<typeof createMockHelcimClient>;

  const TEST_EMAIL = `test-webhook-${String(Date.now())}@example.com`;
  const TEST_PASSWORD = 'TestPassword123!';
  const TEST_NAME = 'Test Webhook User';

  // Track created IDs for cleanup
  const createdPaymentIds: string[] = [];
  const createdTransactionIds: string[] = [];

  beforeAll(async () => {
    db = createDb({ connectionString, neonDev: LOCAL_NEON_DEV_CONFIG });
    helcimClient = createMockHelcimClient({
      webhookUrl: 'http://localhost:8787/webhooks/payment',
      webhookVerifier: 'dGVzdC12ZXJpZmllcg==',
    });

    const emailClient = createMockEmailClient();
    const auth = createAuth({
      db,
      emailClient,
      baseUrl: 'http://localhost:8787',
      secret: 'test-secret-key-at-least-32-characters-long',
      frontendUrl: 'http://localhost:5173',
    });

    // Create the app with auth, billing, and webhook routes
    app = new Hono<AppEnv>();
    // Set db, auth, and helcim on context for all routes
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('auth', auth);
      c.set('helcim', helcimClient);
      c.set('envUtils', {
        isCI: false,
        isE2E: false,
        isLocalDev: false,
        isDev: false,
        isProduction: false,
        requiresRealServices: false,
      });
      // Set env bindings - DATABASE_URL required, HELCIM_WEBHOOK_VERIFIER empty to skip signature verification
      c.env = { DATABASE_URL: connectionString, HELCIM_WEBHOOK_VERIFIER: '' };
      await next();
    });
    app.use('*', sessionMiddleware());
    app.route('/api/auth', createAuthRoutes(auth));
    app.route('/billing', createBillingRoutes());
    app.route('/webhooks', createWebhooksRoutes());

    // Create user via HTTP request to auth endpoint
    const signupRes = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        name: TEST_NAME,
      }),
    });

    if (!signupRes.ok) {
      throw new Error(`Signup failed: ${await signupRes.text()}`);
    }

    const signupData = (await signupRes.json()) as SignupResponse;
    testUserId = signupData.user?.id ?? '';
    if (!testUserId) {
      throw new Error('Signup failed - no user ID returned');
    }

    // Mark email as verified (bypass email verification for testing)
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, testUserId));

    // Now sign in to get a session cookie
    const signinRes = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      }),
    });

    if (!signinRes.ok) {
      throw new Error(`Signin failed: ${await signinRes.text()}`);
    }

    const setCookie = signinRes.headers.get('set-cookie');
    if (setCookie) {
      authCookie = setCookie.split(';')[0] ?? '';
    } else {
      throw new Error('Signin succeeded but no session cookie returned');
    }
  });

  afterAll(async () => {
    // Clean up created records
    if (createdTransactionIds.length > 0) {
      await db
        .delete(balanceTransactions)
        .where(inArray(balanceTransactions.id, createdTransactionIds));
    }
    if (createdPaymentIds.length > 0) {
      await db.delete(payments).where(inArray(payments.id, createdPaymentIds));
    }

    // Clean up test user
    if (testUserId) {
      await db.delete(sessions).where(eq(sessions.userId, testUserId));
      await db.delete(accounts).where(eq(accounts.userId, testUserId));
      await db.delete(users).where(eq(users.id, testUserId));
    }
  });

  describe('POST /webhooks/payment', () => {
    it('accepts valid webhook payload', async () => {
      const res = await app.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'refund',
          id: 'some-transaction-id',
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as WebhookResponse;
      expect(data.received).toBe(true);
    });

    it('returns 400 for invalid JSON', async () => {
      const res = await app.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      expect(res.status).toBe(400);
    });

    it('credits balance when webhook matches awaiting_webhook payment', async () => {
      // Create payment
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '50.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      // Manually set payment to awaiting_webhook with a known transaction ID
      const transactionId = `test-txn-${String(Date.now())}`;
      await db
        .update(payments)
        .set({
          status: 'awaiting_webhook',
          helcimTransactionId: transactionId,
        })
        .where(eq(payments.id, createData.paymentId));

      // Get initial balance
      const balanceRes1 = await app.request('/billing/balance', {
        headers: { Cookie: authCookie },
      });
      const initialBalance = Number.parseFloat(
        ((await balanceRes1.json()) as { balance: string }).balance
      );

      // Send webhook
      const webhookRes = await app.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'cardTransaction',
          id: transactionId,
        }),
      });

      expect(webhookRes.status).toBe(200);

      // Check balance was updated
      const balanceRes2 = await app.request('/billing/balance', {
        headers: { Cookie: authCookie },
      });
      const newBalance = Number.parseFloat(
        ((await balanceRes2.json()) as { balance: string }).balance
      );

      expect(newBalance).toBeCloseTo(initialBalance + 50, 2);

      // Check payment status is now confirmed
      const [payment] = await db
        .select()
        .from(payments)
        .where(eq(payments.id, createData.paymentId));

      expect(payment?.status).toBe('confirmed');
      expect(payment?.webhookReceivedAt).not.toBeNull();
    });

    it('is idempotent - does not double-credit', async () => {
      // Create payment
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '25.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      // Manually set payment to awaiting_webhook with a known transaction ID
      const transactionId = `test-txn-idempotent-${String(Date.now())}`;
      await db
        .update(payments)
        .set({
          status: 'awaiting_webhook',
          helcimTransactionId: transactionId,
        })
        .where(eq(payments.id, createData.paymentId));

      // Get initial balance
      const balanceRes1 = await app.request('/billing/balance', {
        headers: { Cookie: authCookie },
      });
      const initialBalance = Number.parseFloat(
        ((await balanceRes1.json()) as { balance: string }).balance
      );

      // Send webhook TWICE
      await app.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'cardTransaction',
          id: transactionId,
        }),
      });

      await app.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'cardTransaction',
          id: transactionId,
        }),
      });

      // Check balance was only credited once
      const balanceRes2 = await app.request('/billing/balance', {
        headers: { Cookie: authCookie },
      });
      const newBalance = Number.parseFloat(
        ((await balanceRes2.json()) as { balance: string }).balance
      );

      // Should be exactly +25, not +50
      expect(newBalance).toBeCloseTo(initialBalance + 25, 2);
    });

    it('ignores non-cardTransaction event types', async () => {
      // Create payment in awaiting_webhook state
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '10.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      const transactionId = `test-txn-ignore-${String(Date.now())}`;
      await db
        .update(payments)
        .set({
          status: 'awaiting_webhook',
          helcimTransactionId: transactionId,
        })
        .where(eq(payments.id, createData.paymentId));

      // Get initial balance
      const balanceRes1 = await app.request('/billing/balance', {
        headers: { Cookie: authCookie },
      });
      const initialBalance = Number.parseFloat(
        ((await balanceRes1.json()) as { balance: string }).balance
      );

      // Send webhook with different event type
      const webhookRes = await app.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'refund', // Different event type
          id: transactionId,
        }),
      });

      expect(webhookRes.status).toBe(200);

      // Check balance was NOT updated
      const balanceRes2 = await app.request('/billing/balance', {
        headers: { Cookie: authCookie },
      });
      const newBalance = Number.parseFloat(
        ((await balanceRes2.json()) as { balance: string }).balance
      );

      expect(newBalance).toBeCloseTo(initialBalance, 2);
    });

    it('returns 500 for truly unknown transaction IDs after retries', async () => {
      // Current implementation returns 200 immediately
      // After implementing retry logic, this test should pass
      const res = await app.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'cardTransaction',
          id: 'completely-unknown-never-exists',
        }),
      });

      // Expects 500 after retries exhausted (new behavior)
      expect(res.status).toBe(500);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain('Payment not found');
    }, 60_000); // 60 second timeout for retries

    it('returns 200 immediately for already-confirmed payments (duplicate webhook)', async () => {
      // Create payment
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '15.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      // Set payment to CONFIRMED (simulating already-processed webhook)
      const transactionId = `test-txn-duplicate-${String(Date.now())}`;
      await db
        .update(payments)
        .set({
          status: 'confirmed',
          helcimTransactionId: transactionId,
        })
        .where(eq(payments.id, createData.paymentId));

      // Get balance before duplicate webhook
      const balanceRes1 = await app.request('/billing/balance', {
        headers: { Cookie: authCookie },
      });
      const balanceBefore = Number.parseFloat(
        ((await balanceRes1.json()) as { balance: string }).balance
      );

      // Send duplicate webhook for already-confirmed payment
      const webhookRes = await app.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'cardTransaction',
          id: transactionId,
        }),
      });

      // Should return 200 immediately (no retry needed for duplicates)
      expect(webhookRes.status).toBe(200);
      const data = (await webhookRes.json()) as WebhookResponse;
      expect(data.received).toBe(true);

      // Balance should NOT change
      const balanceRes2 = await app.request('/billing/balance', {
        headers: { Cookie: authCookie },
      });
      const balanceAfter = Number.parseFloat(
        ((await balanceRes2.json()) as { balance: string }).balance
      );
      expect(balanceAfter).toBeCloseTo(balanceBefore, 2);
    });

    it('returns 500 in production when HELCIM_WEBHOOK_VERIFIER is not configured', async () => {
      // Create a separate app with production settings
      const productionApp = new Hono<AppEnv>();
      productionApp.use('*', async (c, next) => {
        c.set('db', db);
        // Production env with missing webhook verifier
        c.env = {
          DATABASE_URL: connectionString,
          NODE_ENV: 'production',
          HELCIM_WEBHOOK_VERIFIER: '',
        };
        await next();
      });
      productionApp.route('/webhooks', createWebhooksRoutes());

      const res = await productionApp.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'cardTransaction',
          id: 'test-transaction',
        }),
      });

      expect(res.status).toBe(500);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain('not configured');
    });
  });
});
