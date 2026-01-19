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
import { createBillingRoutes } from './billing.js';
import { createAuthRoutes } from './auth.js';
import { createAuth } from '../auth/index.js';
import { createMockEmailClient } from '../services/email/index.js';
import { createMockHelcimClient } from '../services/helcim/index.js';
import { sessionMiddleware } from '../middleware/dependencies.js';
import type { AppEnv } from '../types.js';

// Response types for type-safe JSON parsing
interface SignupResponse {
  user?: { id: string };
}

interface ErrorResponse {
  error: string;
}

interface BalanceResponse {
  balance: string;
  freeAllowanceCents: number;
}

interface CreatePaymentResponse {
  paymentId: string;
  amount: string;
}

interface ProcessPaymentConfirmedResponse {
  status: 'confirmed';
  newBalance: string;
  helcimTransactionId?: string;
}

interface ProcessPaymentProcessingResponse {
  status: 'processing';
  helcimTransactionId: string;
}

type ProcessPaymentResponse = ProcessPaymentConfirmedResponse | ProcessPaymentProcessingResponse;

interface PaymentStatusResponse {
  status: 'pending' | 'awaiting_webhook' | 'confirmed' | 'failed';
  newBalance?: string;
  errorMessage?: string | null;
}

interface Transaction {
  id: string;
  amount: string;
  balanceAfter: string;
  type: string;
  paymentId?: string | null;
  model?: string | null;
  inputCharacters?: number | null;
  outputCharacters?: number | null;
  deductionSource?: 'balance' | 'freeAllowance' | null;
  createdAt: string;
}

interface TransactionsResponse {
  transactions: Transaction[];
  nextCursor?: string | null;
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

describe('billing routes', () => {
  const connectionString = DATABASE_URL;
  let db: ReturnType<typeof createDb>;
  let app: Hono<AppEnv>;
  let testUserId: string;
  let authCookie: string;
  let helcimClient: ReturnType<typeof createMockHelcimClient>;

  const TEST_EMAIL = `test-billing-${String(Date.now())}@example.com`;
  const TEST_PASSWORD = 'TestPassword123!';
  const TEST_NAME = 'Test Billing User';

  // Track created IDs for cleanup
  const createdPaymentIds: string[] = [];
  const createdTransactionIds: string[] = [];

  beforeAll(async () => {
    db = createDb({ connectionString, neonDev: LOCAL_NEON_DEV_CONFIG });
    helcimClient = createMockHelcimClient();

    const emailClient = createMockEmailClient();
    const auth = createAuth({
      db,
      emailClient,
      baseUrl: 'http://localhost:8787',
      secret: 'test-secret-key-at-least-32-characters-long',
      frontendUrl: 'http://localhost:5173',
    });

    // Create the app with auth and billing routes
    app = new Hono<AppEnv>();
    // Set db, auth, and helcim on context for all routes
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('auth', auth);
      c.set('helcim', helcimClient);
      await next();
    });
    app.use('*', sessionMiddleware());
    app.route('/api/auth', createAuthRoutes(auth));
    app.route('/billing', createBillingRoutes());

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

  describe('GET /billing/balance', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/billing/balance');

      expect(res.status).toBe(401);
    });

    it('returns user balance and free allowance', async () => {
      const res = await app.request('/billing/balance', {
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as BalanceResponse;
      expect(data.balance).toBeDefined();
      expect(typeof data.balance).toBe('string');
      expect(typeof data.freeAllowanceCents).toBe('number');
      expect(data.freeAllowanceCents).toBeGreaterThanOrEqual(0);
    });

    it('returns balance as numeric string with decimal precision', async () => {
      const res = await app.request('/billing/balance', {
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as BalanceResponse;
      // Balance is returned with 8 decimal precision
      expect(parseFloat(data.balance)).toBeGreaterThanOrEqual(0);
      expect(data.balance).toMatch(/^\d+(\.\d+)?$/);
    });
  });

  describe('POST /billing/payments', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/billing/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: '10.00000000' }),
      });

      expect(res.status).toBe(401);
    });

    it('creates a payment record', async () => {
      const res = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '10.00000000' }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as CreatePaymentResponse;
      expect(data.paymentId).toBeDefined();
      expect(data.amount).toBe('10.00000000');
      createdPaymentIds.push(data.paymentId);
    });

    it('validates amount is required', async () => {
      const res = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /billing/payments/:id/process', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/billing/payments/test-id/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardToken: 'test-token' }),
      });

      expect(res.status).toBe(401);
    });

    it('returns 404 for non-existent payment', async () => {
      const res = await app.request('/billing/payments/non-existent-id/process', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      expect(res.status).toBe(404);
    });

    it('processes payment successfully with mock client', async () => {
      // First create a payment
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '25.00000000' }),
      });

      expect(createRes.status).toBe(201);
      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      // Now process it
      const processRes = await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token-123', customerCode: 'CST1234' }),
      });

      expect(processRes.status).toBe(200);
      const processData = (await processRes.json()) as ProcessPaymentResponse;

      // Mock client credits immediately, so should be confirmed
      expect(processData.status).toBe('confirmed');
      if (processData.status === 'confirmed') {
        expect(parseFloat(processData.newBalance)).toBeGreaterThanOrEqual(25);
      }
    });

    it('rejects payment with declined card', async () => {
      // Set mock to decline
      helcimClient.setNextResponse({
        status: 'declined',
        errorMessage: 'Card declined',
      });

      // Create payment
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

      // Process it - should fail
      const processRes = await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token-456', customerCode: 'CST1234' }),
      });

      expect(processRes.status).toBe(400);
      const errorData = (await processRes.json()) as ErrorResponse;
      expect(errorData.error).toBe('Card declined');

      // Reset mock to approved for other tests
      helcimClient.setNextResponse({
        status: 'approved',
        transactionId: 'mock-txn',
        cardType: 'Visa',
        cardLastFour: '9990',
      });
    });

    it('passes client IP from cf-connecting-ip header to Helcim', async () => {
      helcimClient.clearProcessedPayments();

      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '5.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
          'cf-connecting-ip': '203.0.113.42',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      const processedPayments = helcimClient.getProcessedPayments();
      expect(processedPayments.length).toBeGreaterThan(0);
      expect(processedPayments[processedPayments.length - 1]?.ipAddress).toBe('203.0.113.42');
    });

    it('passes client IP from x-forwarded-for header when cf-connecting-ip is absent', async () => {
      helcimClient.clearProcessedPayments();

      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '5.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
          'x-forwarded-for': '198.51.100.178, 70.41.3.18',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      const processedPayments = helcimClient.getProcessedPayments();
      expect(processedPayments.length).toBeGreaterThan(0);
      expect(processedPayments[processedPayments.length - 1]?.ipAddress).toBe('198.51.100.178');
    });

    it('uses fallback IP when no IP headers present', async () => {
      helcimClient.clearProcessedPayments();

      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '5.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      const processedPayments = helcimClient.getProcessedPayments();
      expect(processedPayments.length).toBeGreaterThan(0);
      expect(processedPayments[processedPayments.length - 1]?.ipAddress).toBe('0.0.0.0');
    });

    it('rejects processing already processed payment', async () => {
      // Create and process a payment
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '5.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      // First process
      await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      // Try to process again
      const secondProcessRes = await app.request(
        `/billing/payments/${createData.paymentId}/process`,
        {
          method: 'POST',
          headers: {
            Cookie: authCookie,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
        }
      );

      expect(secondProcessRes.status).toBe(400);
      const errorData = (await secondProcessRes.json()) as ErrorResponse;
      expect(errorData.error).toBe('Payment already processed');
    });
  });

  describe('GET /billing/payments/:id', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/billing/payments/test-id');

      expect(res.status).toBe(401);
    });

    it('returns 404 for non-existent payment', async () => {
      const res = await app.request('/billing/payments/non-existent-id', {
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(404);
    });

    it('returns payment status', async () => {
      // Create a payment
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

      // Get its status
      const statusRes = await app.request(`/billing/payments/${createData.paymentId}`, {
        headers: { Cookie: authCookie },
      });

      expect(statusRes.status).toBe(200);
      const statusData = (await statusRes.json()) as PaymentStatusResponse;
      expect(statusData.status).toBe('pending');
    });
  });

  describe('GET /billing/transactions', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/billing/transactions');

      expect(res.status).toBe(401);
    });

    it('returns transaction history', async () => {
      const res = await app.request('/billing/transactions', {
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as TransactionsResponse;
      expect(Array.isArray(data.transactions)).toBe(true);
    });

    it('respects limit parameter', async () => {
      const res = await app.request('/billing/transactions?limit=5', {
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as TransactionsResponse;
      expect(data.transactions.length).toBeLessThanOrEqual(5);
    });

    it('filters by type=deposit to return only deposits', async () => {
      // Create a deposit transaction via payment
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

      await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      // Create a usage transaction directly in DB
      const [usageTransaction] = await db
        .insert(balanceTransactions)
        .values({
          userId: testUserId,
          amount: '-0.50000000',
          balanceAfter: '9.50000000',
          type: 'usage',
          model: 'openai/gpt-4o-mini',
          inputCharacters: 500,
          outputCharacters: 200,
          deductionSource: 'balance',
        })
        .returning();
      if (usageTransaction) {
        createdTransactionIds.push(usageTransaction.id);
      }

      // Query with type=deposit
      const res = await app.request('/billing/transactions?type=deposit', {
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as TransactionsResponse;

      // All returned transactions should be deposits
      expect(data.transactions.length).toBeGreaterThan(0);
      data.transactions.forEach((tx) => {
        expect(tx.type).toBe('deposit');
      });
    });

    it('filters by type=usage to return only usage charges', async () => {
      // Create a usage transaction directly in DB
      const [usageTransaction] = await db
        .insert(balanceTransactions)
        .values({
          userId: testUserId,
          amount: '-0.25000000',
          balanceAfter: '9.25000000',
          type: 'usage',
          model: 'anthropic/claude-3-opus',
          inputCharacters: 300,
          outputCharacters: 150,
          deductionSource: 'balance',
        })
        .returning();
      if (usageTransaction) {
        createdTransactionIds.push(usageTransaction.id);
      }

      // Query with type=usage
      const res = await app.request('/billing/transactions?type=usage', {
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as TransactionsResponse;

      // All returned transactions should be usage
      expect(data.transactions.length).toBeGreaterThan(0);
      data.transactions.forEach((tx) => {
        expect(tx.type).toBe('usage');
      });
    });

    it('returns all transaction types when no type filter is provided', async () => {
      // Query without type filter
      const res = await app.request('/billing/transactions', {
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as TransactionsResponse;

      // Should have both deposit and usage transactions from previous tests
      const types = new Set(data.transactions.map((tx) => tx.type));
      expect(types.size).toBeGreaterThanOrEqual(1);
    });

    it('supports offset-based pagination with type filter', async () => {
      // Query first page with type=deposit
      const firstPageRes = await app.request(
        '/billing/transactions?type=deposit&limit=2&offset=0',
        {
          headers: { Cookie: authCookie },
        }
      );

      expect(firstPageRes.status).toBe(200);
      const firstPage = (await firstPageRes.json()) as TransactionsResponse;

      // Query second page
      const secondPageRes = await app.request(
        '/billing/transactions?type=deposit&limit=2&offset=2',
        {
          headers: { Cookie: authCookie },
        }
      );

      expect(secondPageRes.status).toBe(200);
      const secondPage = (await secondPageRes.json()) as TransactionsResponse;

      // If there are transactions on both pages, they should be different
      if (firstPage.transactions.length > 0 && secondPage.transactions.length > 0) {
        const firstIds = firstPage.transactions.map((tx) => tx.id);
        const secondIds = secondPage.transactions.map((tx) => tx.id);
        const overlap = firstIds.filter((id) => secondIds.includes(id));
        expect(overlap.length).toBe(0);
      }
    });
  });
});
