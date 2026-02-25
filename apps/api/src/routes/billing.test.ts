/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- json() returns any, assertions provide documentation */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  payments,
  wallets,
  ledgerEntries,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { billingRoute } from './billing.js';
import { createMockHelcimClient } from '../services/helcim/index.js';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';

// Response types for type-safe JSON parsing
interface ErrorResponse {
  code: string;
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
  status: 'completed';
  newBalance: string;
  helcimTransactionId?: string;
}

interface ProcessPaymentProcessingResponse {
  status: 'processing';
  helcimTransactionId: string;
}

type ProcessPaymentResponse = ProcessPaymentConfirmedResponse | ProcessPaymentProcessingResponse;

interface PaymentStatusResponse {
  status: 'pending' | 'awaiting_webhook' | 'completed' | 'failed';
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

function getAuthHeaders(userId: string): Record<string, string> {
  return { 'X-Test-User-Id': userId };
}

describe('billing routes', () => {
  const connectionString = DATABASE_URL;
  let db: ReturnType<typeof createDb>;
  let app: Hono<AppEnv>;
  let testUserId: string;
  let helcimClient: ReturnType<typeof createMockHelcimClient>;

  const testSuffix = String(Date.now());
  const TEST_EMAIL = `test-billing-${testSuffix}@example.com`;
  const TEST_USERNAME = `test_billing_user_${testSuffix}`;

  // Toggle for phrase guard tests — defaults to true so most tests pass the guard
  let mockHasAcknowledgedPhrase = true;

  // Track created IDs for cleanup
  const createdPaymentIds: string[] = [];
  const createdLedgerEntryIds: string[] = [];
  let testWalletId: string;

  beforeAll(async () => {
    db = createDb({ connectionString, neonDev: LOCAL_NEON_DEV_CONFIG });
    helcimClient = createMockHelcimClient({
      webhookUrl: 'http://localhost:8787/api/webhooks/payment',
      webhookVerifier: 'dGVzdC12ZXJpZmllcg==', // gitleaks:allow
    });

    // Create test user using factory (provides all required bytea columns)
    const userData = userFactory.build({
      email: TEST_EMAIL,
      username: TEST_USERNAME,
      emailVerified: true,
    });
    const [createdUser] = await db.insert(users).values(userData).returning();
    if (!createdUser) throw new Error('Failed to create test user');
    testUserId = createdUser.id;

    // Create a purchased wallet for the test user (wallet-based balance system)
    const [createdWallet] = await db
      .insert(wallets)
      .values({
        userId: testUserId,
        type: 'purchased',
        balance: '0.00000000',
        priority: 0,
      })
      .returning();
    if (!createdWallet) throw new Error('Failed to create test wallet');
    testWalletId = createdWallet.id;

    // Create the app with billing routes
    app = new Hono<AppEnv>();
    // OPAQUE-MIGRATION: Remove X-Test-User-Id mock auth once OPAQUE auth is implemented (Phase 9)
    // Currently using header-based auth mock because Better Auth is stubbed during migration
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('helcim', helcimClient);
      c.set('envUtils', {
        isCI: false,
        isE2E: false,
        isLocalDev: false,
        isDev: false,
        isProduction: false,
        requiresRealServices: false,
      });
      // Only set user/session when X-Test-User-Id header is present
      const testUserIdHeader = c.req.header('X-Test-User-Id');
      if (testUserIdHeader) {
        const sessionData: SessionData = {
          sessionId: `test-session-${testUserIdHeader}`,
          userId: testUserIdHeader,
          email: TEST_EMAIL,
          username: TEST_USERNAME,
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: mockHasAcknowledgedPhrase,
          pending2FA: false,
          pending2FAExpiresAt: 0,
          createdAt: Date.now(),
        };
        c.set('user', {
          id: testUserIdHeader,
          email: TEST_EMAIL,
          username: TEST_USERNAME,
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: mockHasAcknowledgedPhrase,
          publicKey: new Uint8Array(32),
        });
        c.set('session', sessionData);
        c.set('sessionData', sessionData);
      }
      await next();
    });
    app.route('/billing', billingRoute);
  });

  afterAll(async () => {
    // Clean up created records (ledger entries cascade from wallets, but clean explicitly first)
    if (createdLedgerEntryIds.length > 0) {
      await db.delete(ledgerEntries).where(inArray(ledgerEntries.id, createdLedgerEntryIds));
    }
    if (createdPaymentIds.length > 0) {
      await db.delete(payments).where(inArray(payments.id, createdPaymentIds));
    }

    // Clean up wallet (ledger entries cascade)
    if (testWalletId) {
      await db.delete(wallets).where(eq(wallets.id, testWalletId));
    }

    // Clean up test user
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId));
    }
  });

  describe('phrase guard', () => {
    beforeAll(() => {
      mockHasAcknowledgedPhrase = false;
    });

    afterAll(() => {
      mockHasAcknowledgedPhrase = true;
    });

    it('allows GET /billing/balance without phrase acknowledgment (read-only)', async () => {
      const res = await app.request('/billing/balance', {
        headers: getAuthHeaders(testUserId),
      });

      // Read routes should not require phrase acknowledgment
      expect(res.status).toBe(200);
    });

    it('returns 403 for POST /billing/payments when phrase not acknowledged', async () => {
      const res = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '10.00000000' }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorResponse;
      expect(body.code).toBe('PHRASE_REQUIRED');
    });

    it('allows GET /billing/transactions without phrase acknowledgment (read-only)', async () => {
      const res = await app.request('/billing/transactions', {
        headers: getAuthHeaders(testUserId),
      });

      // Read routes should not require phrase acknowledgment
      expect(res.status).toBe(200);
    });
  });

  describe('GET /billing/balance', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/billing/balance');

      expect(res.status).toBe(401);
    });

    it('returns user balance and free allowance', async () => {
      const res = await app.request('/billing/balance', {
        headers: getAuthHeaders(testUserId),
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
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as BalanceResponse;
      // Balance is returned with 8 decimal precision
      expect(Number.parseFloat(data.balance)).toBeGreaterThanOrEqual(0);
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
          ...getAuthHeaders(testUserId),
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
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns existing payment when same idempotencyKey is used', async () => {
      const idempotencyKey = crypto.randomUUID();

      const res1 = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '10.00000000', idempotencyKey }),
      });
      expect(res1.status).toBe(201);
      const data1 = (await res1.json()) as CreatePaymentResponse;
      createdPaymentIds.push(data1.paymentId);

      const res2 = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '10.00000000', idempotencyKey }),
      });
      expect(res2.status).toBe(201);
      const data2 = (await res2.json()) as CreatePaymentResponse;

      expect(data2.paymentId).toBe(data1.paymentId);
      expect(data2.amount).toBe(data1.amount);
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
          ...getAuthHeaders(testUserId),
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
          ...getAuthHeaders(testUserId),
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
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token-123', customerCode: 'CST1234' }),
      });

      expect(processRes.status).toBe(200);
      const processData = (await processRes.json()) as ProcessPaymentResponse;

      // Mock client goes through webhook flow like real client, so returns processing
      expect(processData.status).toBe('processing');
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
          ...getAuthHeaders(testUserId),
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
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token-456', customerCode: 'CST1234' }),
      });

      expect(processRes.status).toBe(400);
      const errorData = (await processRes.json()) as ErrorResponse;
      expect(errorData.code).toBe('PAYMENT_DECLINED');

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
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '5.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
          'cf-connecting-ip': '203.0.113.42',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      const processedPayments = helcimClient.getProcessedPayments();
      expect(processedPayments.length).toBeGreaterThan(0);
      expect(processedPayments.at(-1)?.ipAddress).toBe('203.0.113.42');
    });

    it('passes client IP from x-forwarded-for header when cf-connecting-ip is absent', async () => {
      helcimClient.clearProcessedPayments();

      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '5.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
          'x-forwarded-for': '198.51.100.178, 70.41.3.18',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      const processedPayments = helcimClient.getProcessedPayments();
      expect(processedPayments.length).toBeGreaterThan(0);
      expect(processedPayments.at(-1)?.ipAddress).toBe('198.51.100.178');
    });

    it('uses fallback IP when no IP headers present', async () => {
      helcimClient.clearProcessedPayments();

      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '5.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      const processedPayments = helcimClient.getProcessedPayments();
      expect(processedPayments.length).toBeGreaterThan(0);
      expect(processedPayments.at(-1)?.ipAddress).toBe('0.0.0.0');
    });

    it('rejects processing already processed payment', async () => {
      // Create and process a payment
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
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
          ...getAuthHeaders(testUserId),
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
            ...getAuthHeaders(testUserId),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
        }
      );

      expect(secondProcessRes.status).toBe(400);
      const errorData = (await secondProcessRes.json()) as ErrorResponse;
      expect(errorData.code).toBe('PAYMENT_ALREADY_PROCESSED');
    });

    it('does not overwrite completed payment with failed status', async () => {
      // Create payment
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '10.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      // Simulate webhook completed the payment before decline response
      await db
        .update(payments)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(payments.id, createData.paymentId));

      // Set mock to decline
      helcimClient.setNextResponse({
        status: 'declined',
        errorMessage: 'Card declined',
      });

      // Try to process - should not overwrite completed status
      const processRes = await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      // Should reject because status is not 'pending'
      expect(processRes.status).toBe(400);

      // Verify payment is still completed
      const [payment] = await db
        .select()
        .from(payments)
        .where(eq(payments.id, createData.paymentId));
      expect(payment?.status).toBe('completed');

      // Reset mock
      helcimClient.setNextResponse({
        status: 'approved',
        transactionId: 'mock-txn',
        cardType: 'Visa',
        cardLastFour: '9990',
      });
    });

    it('does not overwrite completed payment with expired status', async () => {
      // Create payment
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '10.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      // Simulate: payment was completed by webhook AND has old createdAt
      const expiredTime = new Date(Date.now() - 31 * 60 * 1000); // 31 minutes ago
      await db
        .update(payments)
        .set({
          status: 'completed',
          createdAt: expiredTime,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, createData.paymentId));

      // Try to process - should not overwrite completed with expired/failed
      const processRes = await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      // Should reject because status is not 'pending'
      expect(processRes.status).toBe(400);

      // Verify payment is still completed (not overwritten to 'failed')
      const [payment] = await db
        .select()
        .from(payments)
        .where(eq(payments.id, createData.paymentId));
      expect(payment?.status).toBe('completed');
    });
  });

  describe('GET /billing/payments/:id', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/billing/payments/test-id');

      expect(res.status).toBe(401);
    });

    it('returns 404 for non-existent payment', async () => {
      const res = await app.request('/billing/payments/non-existent-id', {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(404);
    });

    it('returns payment status', async () => {
      // Create a payment
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '15.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      // Get its status
      const statusRes = await app.request(`/billing/payments/${createData.paymentId}`, {
        headers: getAuthHeaders(testUserId),
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
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as TransactionsResponse;
      expect(Array.isArray(data.transactions)).toBe(true);
    });

    it('respects limit parameter', async () => {
      const res = await app.request('/billing/transactions?limit=5', {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as TransactionsResponse;
      expect(data.transactions.length).toBeLessThanOrEqual(5);
    });

    it('filters by type=deposit to return only deposits', async () => {
      // Create a deposit ledger entry directly in DB
      const [depositEntry] = await db
        .insert(ledgerEntries)
        .values({
          walletId: testWalletId,
          amount: '10.00000000',
          balanceAfter: '20.00000000',
          entryType: 'deposit',
          sourceWalletId: testWalletId,
        })
        .returning();
      if (depositEntry) {
        createdLedgerEntryIds.push(depositEntry.id);
      }

      // Create a usage_charge ledger entry directly in DB
      const [usageEntry] = await db
        .insert(ledgerEntries)
        .values({
          walletId: testWalletId,
          amount: '-0.50000000',
          balanceAfter: '9.50000000',
          entryType: 'usage_charge',
          sourceWalletId: testWalletId,
        })
        .returning();
      if (usageEntry) {
        createdLedgerEntryIds.push(usageEntry.id);
      }

      // Query with type=deposit
      const res = await app.request('/billing/transactions?type=deposit', {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as TransactionsResponse;

      // All returned transactions should be deposits
      expect(data.transactions.length).toBeGreaterThan(0);
      for (const tx of data.transactions) {
        expect(tx.type).toBe('deposit');
      }
    });

    it('filters by type=usage_charge to return only usage transactions', async () => {
      // Create a usage_charge ledger entry directly in DB
      const [usageEntry] = await db
        .insert(ledgerEntries)
        .values({
          walletId: testWalletId,
          amount: '-0.25000000',
          balanceAfter: '9.25000000',
          entryType: 'usage_charge',
          sourceWalletId: testWalletId,
        })
        .returning();
      if (usageEntry) {
        createdLedgerEntryIds.push(usageEntry.id);
      }

      // Query with type=usage_charge
      const res = await app.request('/billing/transactions?type=usage_charge', {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as TransactionsResponse;

      // All returned transactions should be usage_charge
      expect(data.transactions.length).toBeGreaterThan(0);
      for (const tx of data.transactions) {
        expect(tx.type).toBe('usage_charge');
      }
    });

    it('returns all transaction types when no type filter is provided', async () => {
      // Query without type filter
      const res = await app.request('/billing/transactions', {
        headers: getAuthHeaders(testUserId),
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
          headers: getAuthHeaders(testUserId),
        }
      );

      expect(firstPageRes.status).toBe(200);
      const firstPage = (await firstPageRes.json()) as TransactionsResponse;

      // Query second page
      const secondPageRes = await app.request(
        '/billing/transactions?type=deposit&limit=2&offset=2',
        {
          headers: getAuthHeaders(testUserId),
        }
      );

      expect(secondPageRes.status).toBe(200);
      const secondPage = (await secondPageRes.json()) as TransactionsResponse;

      // If there are transactions on both pages, they should be different
      if (firstPage.transactions.length > 0 && secondPage.transactions.length > 0) {
        const firstIds = firstPage.transactions.map((tx) => tx.id);
        const secondIds = new Set(secondPage.transactions.map((tx) => tx.id));
        const overlap = firstIds.filter((id) => secondIds.has(id));
        expect(overlap.length).toBe(0);
      }
    });
  });
});
