import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { payments, balanceTransactions, users } from '@lome-chat/db';
import { verifyWebhookSignatureAsync } from '../services/helcim/index.js';
import type { AppEnv } from '../types.js';

// Response schemas for OpenAPI documentation
const errorSchema = z.object({
  error: z.string(),
});

const webhookResponseSchema = z.object({
  received: z.boolean(),
});

// Helcim webhook payload schema
const helcimWebhookPayloadSchema = z.object({
  type: z.string(),
  id: z.string().or(z.number()).transform(String),
  // Helcim sends more fields but we only need these
});

// Route definition
const helcimWebhookRoute = createRoute({
  method: 'post',
  path: '/helcim',
  request: {
    body: {
      content: {
        'application/json': {
          schema: helcimWebhookPayloadSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: webhookResponseSchema } },
      description: 'Webhook processed',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid request',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid signature',
    },
  },
});

/**
 * Creates webhook routes.
 * Requires dbMiddleware to be applied.
 * Does NOT require auth middleware - webhooks are authenticated via signature.
 */
export function createWebhooksRoutes(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  // POST /webhooks/helcim - Handle Helcim webhook events
  app.openapi(helcimWebhookRoute, async (c) => {
    const db = c.get('db');

    // Get raw body for signature verification
    const rawBody = await c.req.text();

    // Get signature headers from Helcim
    const signature = c.req.header('x-helcim-signature');
    const timestamp = c.req.header('x-helcim-timestamp');
    const webhookId = c.req.header('x-helcim-webhook-id');

    // Skip signature verification in development/mock mode
    const webhookVerifier = c.env.HELCIM_WEBHOOK_VERIFIER;
    if (webhookVerifier && signature && timestamp && webhookId) {
      const isValid = await verifyWebhookSignatureAsync(
        webhookVerifier,
        rawBody,
        signature,
        timestamp,
        webhookId
      );

      if (!isValid) {
        return c.json({ error: 'Invalid signature' }, 401);
      }
    }

    // Parse the body after verification
    let event: { type: string; id: string };
    try {
      const parsed: unknown = JSON.parse(rawBody);
      const typedParsed = parsed as Record<string, unknown>;
      const typeValue = typedParsed['type'];
      const idValue = typedParsed['id'] ?? typedParsed['transactionId'];
      event = {
        type: typeof typeValue === 'string' ? typeValue : '',
        id: typeof idValue === 'string' || typeof idValue === 'number' ? String(idValue) : '',
      };
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (event.type === 'cardTransaction') {
      // Find payment by Helcim transaction ID
      const [payment] = await db
        .select()
        .from(payments)
        .where(eq(payments.helcimTransactionId, event.id));

      // Only process if awaiting webhook (idempotent via status check)
      if (payment?.status === 'awaiting_webhook') {
        await db.transaction(async (tx) => {
          // Add balance atomically with RETURNING
          const [updatedUser] = await tx
            .update(users)
            .set({
              balance: sql`${users.balance} + ${payment.amount}::numeric`,
              updatedAt: new Date(),
            })
            .where(eq(users.id, payment.userId))
            .returning({ balance: users.balance });

          if (!updatedUser) {
            throw new Error('Failed to update user balance');
          }

          // Record transaction
          await tx.insert(balanceTransactions).values({
            userId: payment.userId,
            amount: payment.amount,
            balanceAfter: updatedUser.balance,
            type: 'deposit',
            paymentId: payment.id,
            description: `Deposit of $${parseFloat(payment.amount).toFixed(2)}`,
          });

          // Confirm payment
          await tx
            .update(payments)
            .set({
              status: 'confirmed',
              webhookReceivedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(payments.id, payment.id));
        });
      }
    }

    return c.json({ received: true }, 200);
  });

  return app;
}
