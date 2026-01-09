import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, and, desc, sql, lt } from 'drizzle-orm';
import { payments, balanceTransactions, users } from '@lome-chat/db';
import {
  createPaymentRequestSchema,
  processPaymentRequestSchema,
  listTransactionsQuerySchema,
} from '@lome-chat/shared';
import type { AppEnv } from '../types.js';

// Response schemas for OpenAPI documentation
const errorSchema = z.object({
  error: z.string(),
});

const getBalanceResponseSchema = z.object({
  balance: z.string(),
});

const createPaymentResponseSchema = z.object({
  paymentId: z.string(),
  amount: z.string(),
});

// Note: paymentStatusSchema used only for reference in response types

const processPaymentResponseSchema = z.union([
  z.object({
    status: z.literal('confirmed'),
    newBalance: z.string(),
    helcimTransactionId: z.string().optional(),
  }),
  z.object({
    status: z.literal('processing'),
    helcimTransactionId: z.string(),
  }),
]);

const getPaymentStatusResponseSchema = z.union([
  z.object({
    status: z.literal('confirmed'),
    newBalance: z.string(),
  }),
  z.object({
    status: z.literal('failed'),
    errorMessage: z.string().nullable().optional(),
  }),
  z.object({
    status: z.literal('pending'),
  }),
  z.object({
    status: z.literal('awaiting_webhook'),
  }),
]);

const balanceTransactionTypeSchema = z.enum(['deposit', 'usage', 'adjustment']);

const balanceTransactionResponseSchema = z.object({
  id: z.string(),
  amount: z.string(),
  balanceAfter: z.string(),
  type: balanceTransactionTypeSchema,
  description: z.string(),
  paymentId: z.string().nullable().optional(),
  createdAt: z.string(),
});

const listTransactionsResponseSchema = z.object({
  transactions: z.array(balanceTransactionResponseSchema),
  nextCursor: z.string().nullable().optional(),
});

// Payment expiration time (30 minutes)
const PAYMENT_EXPIRATION_MS = 30 * 60 * 1000;

// Route definitions
const getBalanceRoute = createRoute({
  method: 'get',
  path: '/balance',
  responses: {
    200: {
      content: { 'application/json': { schema: getBalanceResponseSchema } },
      description: 'User balance in USD with 8 decimal precision',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
  },
});

const listTransactionsRoute = createRoute({
  method: 'get',
  path: '/transactions',
  request: {
    query: listTransactionsQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: listTransactionsResponseSchema } },
      description: 'Balance transaction history',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
  },
});

const createPaymentRoute = createRoute({
  method: 'post',
  path: '/payments',
  request: {
    body: {
      content: {
        'application/json': {
          schema: createPaymentRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: createPaymentResponseSchema } },
      description: 'Payment record created',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid request',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal server error',
    },
  },
});

const processPaymentRoute = createRoute({
  method: 'post',
  path: '/payments/{id}/process',
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: processPaymentRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: processPaymentResponseSchema } },
      description: 'Payment processed',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid request or payment expired',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Payment not found',
    },
  },
});

const getPaymentStatusRoute = createRoute({
  method: 'get',
  path: '/payments/{id}',
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: getPaymentStatusResponseSchema } },
      description: 'Payment status',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Payment not found',
    },
  },
});

/**
 * Creates billing routes with OpenAPI documentation.
 * Requires dbMiddleware, authMiddleware, sessionMiddleware, and helcimMiddleware to be applied.
 */
export function createBillingRoutes(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  // GET /billing/balance - Get user's current balance
  app.openapi(getBalanceRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const [userData] = await db
      .select({ balance: users.balance })
      .from(users)
      .where(eq(users.id, user.id));

    return c.json({ balance: userData?.balance ?? '0.00000000' }, 200);
  });

  // GET /billing/transactions - Get balance transaction history
  app.openapi(listTransactionsRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const query = c.req.valid('query');
    const limit = query.limit;

    // Build conditions array
    const conditions = [eq(balanceTransactions.userId, user.id)];

    // Add type filter if provided
    if (query.type) {
      conditions.push(eq(balanceTransactions.type, query.type));
    }

    // Add cursor filter if provided
    if (query.cursor) {
      const cursorDate = new Date(query.cursor);
      conditions.push(lt(balanceTransactions.createdAt, cursorDate));
    }

    const baseQuery = db
      .select()
      .from(balanceTransactions)
      .where(and(...conditions))
      .orderBy(desc(balanceTransactions.createdAt))
      .limit(limit + 1);

    // Apply offset if provided (for offset-based pagination)
    const results =
      query.offset !== undefined ? await baseQuery.offset(query.offset) : await baseQuery;

    const hasMore = results.length > limit;
    const transactions = results.slice(0, limit).map((t) => ({
      id: t.id,
      amount: t.amount,
      balanceAfter: t.balanceAfter,
      type: t.type,
      description: t.description,
      paymentId: t.paymentId,
      createdAt: t.createdAt.toISOString(),
    }));

    const nextCursor = hasMore ? results[limit - 1]?.createdAt.toISOString() : null;

    return c.json({ transactions, nextCursor }, 200);
  });

  // POST /billing/payments - Create a new payment record
  app.openapi(createPaymentRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const body = c.req.valid('json');

    // Create payment record BEFORE any processing
    const [payment] = await db
      .insert(payments)
      .values({
        userId: user.id,
        amount: body.amount,
        status: 'pending',
      })
      .returning();

    if (!payment) {
      return c.json({ error: 'Failed to create payment' }, 500);
    }

    return c.json({ paymentId: payment.id, amount: payment.amount }, 201);
  });

  // POST /billing/payments/:id/process - Process payment with card token
  app.openapi(processPaymentRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');
    const helcim = c.get('helcim');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { id: paymentId } = c.req.valid('param');
    const body = c.req.valid('json');

    // Find payment and verify ownership
    const [payment] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.userId, user.id)));

    if (!payment) {
      return c.json({ error: 'Payment not found' }, 404);
    }

    if (payment.status !== 'pending') {
      return c.json({ error: 'Payment already processed' }, 400);
    }

    // Check expiration (30 minutes)
    const ageMs = Date.now() - payment.createdAt.getTime();
    if (ageMs > PAYMENT_EXPIRATION_MS) {
      await db
        .update(payments)
        .set({
          status: 'failed',
          errorMessage: 'Payment expired',
          updatedAt: new Date(),
        })
        .where(eq(payments.id, payment.id));

      return c.json({ error: 'Payment expired' }, 400);
    }

    // Call Helcim with payment.id as idempotency key
    const result = await helcim.processPayment({
      cardToken: body.cardToken,
      amount: payment.amount,
      paymentId: payment.id,
    });

    if (result.status === 'approved') {
      if (helcim.isMock) {
        // Mock mode: skip webhook, credit immediately
        await db.transaction(async (tx) => {
          const [updatedUser] = await tx
            .update(users)
            .set({
              balance: sql`${users.balance} + ${payment.amount}::numeric`,
              updatedAt: new Date(),
            })
            .where(eq(users.id, user.id))
            .returning({ balance: users.balance });

          if (!updatedUser) {
            throw new Error('Failed to update user balance');
          }

          await tx.insert(balanceTransactions).values({
            userId: user.id,
            amount: payment.amount,
            balanceAfter: updatedUser.balance,
            type: 'deposit',
            paymentId: payment.id,
            description: `Deposit of $${parseFloat(payment.amount).toFixed(2)}`,
          });

          await tx
            .update(payments)
            .set({
              status: 'confirmed',
              helcimTransactionId: result.transactionId,
              cardType: result.cardType,
              cardLastFour: result.cardLastFour,
              updatedAt: new Date(),
            })
            .where(eq(payments.id, payment.id));
        });

        const [userData] = await db
          .select({ balance: users.balance })
          .from(users)
          .where(eq(users.id, user.id));

        return c.json(
          {
            status: 'confirmed' as const,
            newBalance: userData?.balance ?? '0.00000000',
            helcimTransactionId: result.transactionId,
          },
          200
        );
      }

      // Real mode: await webhook
      const transactionId = result.transactionId ?? '';
      await db
        .update(payments)
        .set({
          status: 'awaiting_webhook',
          helcimTransactionId: transactionId,
          cardType: result.cardType,
          cardLastFour: result.cardLastFour,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, payment.id));

      return c.json(
        {
          status: 'processing' as const,
          helcimTransactionId: transactionId,
        },
        200
      );
    }

    // Payment declined
    await db
      .update(payments)
      .set({
        status: 'failed',
        errorMessage: result.errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));

    return c.json({ error: result.errorMessage ?? 'Payment declined' }, 400);
  });

  // GET /billing/payments/:id - Poll payment status
  app.openapi(getPaymentStatusRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { id: paymentId } = c.req.valid('param');

    const [payment] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.userId, user.id)));

    if (!payment) {
      return c.json({ error: 'Payment not found' }, 404);
    }

    if (payment.status === 'confirmed') {
      const [userData] = await db
        .select({ balance: users.balance })
        .from(users)
        .where(eq(users.id, user.id));

      return c.json(
        {
          status: 'confirmed' as const,
          newBalance: userData?.balance ?? '0.00000000',
        },
        200
      );
    }

    if (payment.status === 'failed') {
      return c.json(
        {
          status: 'failed' as const,
          errorMessage: payment.errorMessage,
        },
        200
      );
    }

    return c.json({ status: payment.status }, 200);
  });

  return app;
}
