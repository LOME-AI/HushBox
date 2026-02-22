import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, desc, lt } from 'drizzle-orm';
import { payments, ledgerEntries, wallets } from '@hushbox/db';
import {
  createPaymentRequestSchema,
  processPaymentRequestSchema,
  listTransactionsQuerySchema,
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_PAYMENT_NOT_FOUND,
  ERROR_CODE_PAYMENT_ALREADY_PROCESSED,
  ERROR_CODE_PAYMENT_EXPIRED,
  ERROR_CODE_PAYMENT_DECLINED,
  ERROR_CODE_PAYMENT_CREATE_FAILED,
  ERROR_CODE_PAYMENT_MISSING_TRANSACTION_ID,
  PAYMENT_EXPIRATION_MS,
} from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePhrase } from '../middleware/require-phrase.js';
import { getClientIp } from '../lib/client-ip.js';
import { checkUserBalance } from '../services/billing/index.js';
import type { AppEnv } from '../types.js';

export const billingRoute = new Hono<AppEnv>()
  .use('*', requireAuth())

  .use('/payments', requirePhrase())
  .use('/payments/*', requirePhrase())

  .get('/balance', async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');

    const balanceResult = await checkUserBalance(db, user.id);

    return c.json(
      {
        balance: balanceResult.currentBalance,
        freeAllowanceCents: balanceResult.freeAllowanceCents,
      },
      200
    );
  })

  .get('/transactions', zValidator('query', listTransactionsQuerySchema), async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
    const query = c.req.valid('query');
    const limit = query.limit;

    const conditions = [eq(wallets.userId, user.id)];

    if (query.type) {
      conditions.push(eq(ledgerEntries.entryType, query.type));
    }

    if (query.cursor) {
      const cursorDate = new Date(query.cursor);
      conditions.push(lt(ledgerEntries.createdAt, cursorDate));
    }

    const baseQuery = db
      .select({
        id: ledgerEntries.id,
        amount: ledgerEntries.amount,
        balanceAfter: ledgerEntries.balanceAfter,
        type: ledgerEntries.entryType,
        paymentId: ledgerEntries.paymentId,
        createdAt: ledgerEntries.createdAt,
      })
      .from(ledgerEntries)
      .innerJoin(wallets, eq(ledgerEntries.walletId, wallets.id))
      .where(and(...conditions))
      .orderBy(desc(ledgerEntries.createdAt))
      .limit(limit + 1);

    const results =
      query.offset === undefined ? await baseQuery : await baseQuery.offset(query.offset);

    const hasMore = results.length > limit;
    const transactions = results.slice(0, limit).map((t) => ({
      id: t.id,
      amount: t.amount,
      balanceAfter: t.balanceAfter,
      type: t.type,
      paymentId: t.paymentId,
      model: null,
      inputCharacters: null,
      outputCharacters: null,
      deductionSource: null,
      createdAt: t.createdAt.toISOString(),
    }));

    const nextCursor = hasMore ? results[limit - 1]?.createdAt.toISOString() : null;

    return c.json({ transactions, nextCursor }, 200);
  })

  .post('/payments', zValidator('json', createPaymentRequestSchema), async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
    const body = c.req.valid('json');

    let payment;

    if (body.idempotencyKey) {
      [payment] = await db
        .insert(payments)
        .values({
          userId: user.id,
          amount: body.amount,
          status: 'pending',
          idempotencyKey: body.idempotencyKey,
        })
        .onConflictDoNothing({
          target: [payments.userId, payments.idempotencyKey],
        })
        .returning();

      if (!payment) {
        [payment] = await db
          .select()
          .from(payments)
          .where(
            and(eq(payments.userId, user.id), eq(payments.idempotencyKey, body.idempotencyKey))
          );
      }
    } else {
      [payment] = await db
        .insert(payments)
        .values({
          userId: user.id,
          amount: body.amount,
          status: 'pending',
        })
        .returning();
    }

    if (!payment) {
      return c.json(createErrorResponse(ERROR_CODE_PAYMENT_CREATE_FAILED), 500);
    }

    return c.json(
      {
        paymentId: payment.id,
        amount: payment.amount,
      },
      201
    );
  })

  .post(
    '/payments/:id/process',
    zValidator('param', z.object({ id: z.string() })),
    zValidator('json', processPaymentRequestSchema),
    async (c) => {
      const user = c.get('user');
      if (!user) {
        return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
      }
      const db = c.get('db');
      const helcim = c.get('helcim');
      const { id: paymentId } = c.req.valid('param');
      const body = c.req.valid('json');

      const [payment] = await db
        .select()
        .from(payments)
        .where(and(eq(payments.id, paymentId), eq(payments.userId, user.id)));

      if (!payment) {
        return c.json(createErrorResponse(ERROR_CODE_PAYMENT_NOT_FOUND), 404);
      }

      if (payment.status !== 'pending') {
        return c.json(createErrorResponse(ERROR_CODE_PAYMENT_ALREADY_PROCESSED), 400);
      }

      const ageMs = Date.now() - payment.createdAt.getTime();
      if (ageMs > PAYMENT_EXPIRATION_MS) {
        await db
          .update(payments)
          .set({
            status: 'failed',
            errorMessage: 'Payment expired',
            updatedAt: new Date(),
          })
          .where(and(eq(payments.id, payment.id), eq(payments.status, 'pending')));

        return c.json(createErrorResponse(ERROR_CODE_PAYMENT_EXPIRED), 400);
      }

      const ipAddress = getClientIp(c, '0.0.0.0');

      const result = await helcim.processPayment({
        cardToken: body.cardToken,
        customerCode: body.customerCode,
        amount: payment.amount,
        paymentId: payment.id,
        ipAddress,
      });

      if (result.status === 'approved') {
        if (!result.transactionId) {
          // This should never happen - Helcim approved but gave no transaction ID
          console.error('[ERROR] Helcim approved payment but returned no transactionId');
          return c.json(createErrorResponse(ERROR_CODE_PAYMENT_MISSING_TRANSACTION_ID), 500);
        }

        const transactionId = result.transactionId;
        const [updated] = await db
          .update(payments)
          .set({
            status: 'awaiting_webhook',
            helcimTransactionId: transactionId,
            cardType: result.cardType,
            cardLastFour: result.cardLastFour,
            updatedAt: new Date(),
          })
          .where(and(eq(payments.id, payment.id), eq(payments.status, 'pending')))
          .returning();

        if (!updated) {
          console.error(`Payment UPDATE failed: id=${payment.id}, status may have changed`);
          return c.json(createErrorResponse(ERROR_CODE_PAYMENT_ALREADY_PROCESSED), 400);
        }

        return c.json(
          {
            status: 'processing' as const,
            helcimTransactionId: transactionId,
          },
          200
        );
      }

      await db
        .update(payments)
        .set({
          status: 'failed',
          errorMessage: result.errorMessage,
          updatedAt: new Date(),
        })
        .where(and(eq(payments.id, payment.id), eq(payments.status, 'pending')));

      return c.json(createErrorResponse(ERROR_CODE_PAYMENT_DECLINED, result.debugInfo), 400);
    }
  )

  .get('/payments/:id', zValidator('param', z.object({ id: z.string() })), async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
    const { id: paymentId } = c.req.valid('param');

    const [payment] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.userId, user.id)));

    if (!payment) {
      return c.json(createErrorResponse(ERROR_CODE_PAYMENT_NOT_FOUND), 404);
    }

    if (payment.status === 'completed') {
      const balanceResult = await checkUserBalance(db, user.id);

      return c.json(
        {
          status: 'completed' as const,
          newBalance: balanceResult.currentBalance,
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
