import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, and, desc, lt } from 'drizzle-orm';
import { payments, balanceTransactions, users } from '@lome-chat/db';
import { creditUserBalance } from '../services/billing/transaction-writer.js';
import {
  createPaymentRequestSchema,
  processPaymentRequestSchema,
  listTransactionsQuerySchema,
  getBalanceResponseSchema,
  createPaymentResponseSchema,
  processPaymentResponseSchema,
  getPaymentStatusResponseSchema,
  listTransactionsResponseSchema,
  errorResponseSchema,
  ERROR_CODE_NOT_FOUND,
  ERROR_CODE_INTERNAL,
  ERROR_CODE_CONFLICT,
  ERROR_CODE_EXPIRED,
  ERROR_CODE_PAYMENT_REQUIRED,
  ERROR_CODE_UNAUTHORIZED,
  PAYMENT_EXPIRATION_MS,
} from '@lome-chat/shared';
import { createErrorResponse } from '../lib/error-response.js';
import {
  ERROR_PAYMENT_NOT_FOUND,
  ERROR_PAYMENT_ALREADY_PROCESSED,
  ERROR_PAYMENT_EXPIRED,
  ERROR_PAYMENT_DECLINED,
  ERROR_PAYMENT_CREATE_FAILED,
  ERROR_UNAUTHORIZED,
} from '../constants/errors.js';
import { requireAuth } from '../middleware/require-auth.js';
import type { AppEnv } from '../types.js';

const errorSchema = errorResponseSchema;

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

  // All billing routes require authentication
  app.use('*', requireAuth());

  // GET /billing/balance - Get user's current balance
  app.openapi(getBalanceRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');

    const [userData] = await db
      .select({
        balance: users.balance,
        freeAllowanceCents: users.freeAllowanceCents,
      })
      .from(users)
      .where(eq(users.id, user.id));

    const response = getBalanceResponseSchema.parse({
      balance: userData?.balance ?? '0.00000000',
      freeAllowanceCents: userData?.freeAllowanceCents ?? 0,
    });
    return c.json(response, 200);
  });

  // GET /billing/transactions - Get balance transaction history
  app.openapi(listTransactionsRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
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

    const response = listTransactionsResponseSchema.parse({ transactions, nextCursor });
    return c.json(response, 200);
  });

  // POST /billing/payments - Create a new payment record
  app.openapi(createPaymentRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
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
      return c.json(createErrorResponse(ERROR_PAYMENT_CREATE_FAILED, ERROR_CODE_INTERNAL), 500);
    }

    const response = createPaymentResponseSchema.parse({
      paymentId: payment.id,
      amount: payment.amount,
    });
    return c.json(response, 201);
  });

  // POST /billing/payments/:id/process - Process payment with card token
  app.openapi(processPaymentRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
    const helcim = c.get('helcim');
    const { id: paymentId } = c.req.valid('param');
    const body = c.req.valid('json');

    // Find payment and verify ownership
    const [payment] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.userId, user.id)));

    if (!payment) {
      return c.json(createErrorResponse(ERROR_PAYMENT_NOT_FOUND, ERROR_CODE_NOT_FOUND), 404);
    }

    if (payment.status !== 'pending') {
      return c.json(createErrorResponse(ERROR_PAYMENT_ALREADY_PROCESSED, ERROR_CODE_CONFLICT), 400);
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

      return c.json(createErrorResponse(ERROR_PAYMENT_EXPIRED, ERROR_CODE_EXPIRED), 400);
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
        const creditResult = await creditUserBalance(db, {
          userId: user.id,
          amount: payment.amount,
          paymentId: payment.id,
          description: `Deposit of $${parseFloat(payment.amount).toFixed(2)}`,
          transactionDetails: {
            ...(result.transactionId && { helcimTransactionId: result.transactionId }),
            ...(result.cardType && { cardType: result.cardType }),
            ...(result.cardLastFour && { cardLastFour: result.cardLastFour }),
          },
        });

        if (!creditResult) {
          // Payment already processed (idempotent - return success)
          return c.json(
            createErrorResponse(ERROR_PAYMENT_ALREADY_PROCESSED, ERROR_CODE_CONFLICT),
            400
          );
        }

        const response = processPaymentResponseSchema.parse({
          status: 'confirmed' as const,
          newBalance: creditResult.newBalance,
          helcimTransactionId: result.transactionId,
        });
        return c.json(response, 200);
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

      const response = processPaymentResponseSchema.parse({
        status: 'processing' as const,
        helcimTransactionId: transactionId,
      });
      return c.json(response, 200);
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

    return c.json(
      createErrorResponse(
        result.errorMessage ?? ERROR_PAYMENT_DECLINED,
        ERROR_CODE_PAYMENT_REQUIRED
      ),
      400
    );
  });

  // GET /billing/payments/:id - Poll payment status
  app.openapi(getPaymentStatusRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
    const { id: paymentId } = c.req.valid('param');

    const [payment] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.userId, user.id)));

    if (!payment) {
      return c.json(createErrorResponse(ERROR_PAYMENT_NOT_FOUND, ERROR_CODE_NOT_FOUND), 404);
    }

    if (payment.status === 'confirmed') {
      const [userData] = await db
        .select({ balance: users.balance })
        .from(users)
        .where(eq(users.id, user.id));

      const response = getPaymentStatusResponseSchema.parse({
        status: 'confirmed' as const,
        newBalance: userData?.balance ?? '0.00000000',
      });
      return c.json(response, 200);
    }

    if (payment.status === 'failed') {
      const response = getPaymentStatusResponseSchema.parse({
        status: 'failed' as const,
        errorMessage: payment.errorMessage,
      });
      return c.json(response, 200);
    }

    const response = getPaymentStatusResponseSchema.parse({ status: payment.status });
    return c.json(response, 200);
  });

  return app;
}
