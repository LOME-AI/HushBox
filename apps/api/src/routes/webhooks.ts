import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { payments } from '@lome-chat/db';
import {
  createEnvUtils,
  errorResponseSchema,
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_VALIDATION,
} from '@lome-chat/shared';
import { verifyWebhookSignatureAsync } from '../services/helcim/index.js';
import { processWebhookCredit } from '../services/billing/index.js';
import { createErrorResponse } from '../lib/error-response.js';
import {
  ERROR_INVALID_SIGNATURE,
  ERROR_INVALID_JSON,
  ERROR_WEBHOOK_VERIFIER_MISSING,
  ERROR_PAYMENT_NOT_FOUND,
} from '../constants/errors.js';
import { ERROR_CODE_INTERNAL } from '@lome-chat/shared';
import type { AppEnv } from '../types.js';

const errorSchema = errorResponseSchema;

const webhookResponseSchema = z.object({
  received: z.boolean(),
});

const helcimWebhookPayloadSchema = z.object({
  type: z.string(),
  id: z.string().or(z.number()).transform(String),
});

const helcimWebhookRoute = createRoute({
  method: 'post',
  path: '/payment',
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
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Server misconfiguration',
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

  app.openapi(helcimWebhookRoute, async (c) => {
    const db = c.get('db');

    // Get raw body for signature verification
    const rawBody = await c.req.text();

    // Get signature headers from Helcim
    // See: https://devdocs.helcim.com/docs/webhooks
    const signature = c.req.header('webhook-signature');
    const timestamp = c.req.header('webhook-timestamp');
    const webhookId = c.req.header('webhook-id');

    const webhookVerifier = c.env.HELCIM_WEBHOOK_VERIFIER;
    const { isProduction } = createEnvUtils(c.env);

    // In production, webhook verifier MUST be configured
    if (isProduction && !webhookVerifier) {
      console.error('HELCIM_WEBHOOK_VERIFIER not configured in production');
      return c.json(createErrorResponse(ERROR_WEBHOOK_VERIFIER_MISSING, ERROR_CODE_INTERNAL), 500);
    }

    // Verify signature if verifier is configured (required in production, optional in dev)
    if (webhookVerifier && signature && timestamp && webhookId) {
      const isValid = await verifyWebhookSignatureAsync(
        webhookVerifier,
        rawBody,
        signature,
        timestamp,
        webhookId
      );

      if (!isValid) {
        return c.json(createErrorResponse(ERROR_INVALID_SIGNATURE, ERROR_CODE_UNAUTHORIZED), 401);
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
      return c.json(createErrorResponse(ERROR_INVALID_JSON, ERROR_CODE_VALIDATION), 400);
    }

    if (event.type === 'cardTransaction') {
      const [existing] = await db
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.helcimTransactionId, event.id));

      if (existing?.status === 'confirmed') {
        return c.json({ received: true }, 200);
      }

      let result = await processWebhookCredit(db, { helcimTransactionId: event.id });

      if (!result) {
        const maxRetries = 15;
        for (let i = 0; i < maxRetries; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));

          const [check] = await db
            .select({ status: payments.status })
            .from(payments)
            .where(eq(payments.helcimTransactionId, event.id));

          if (check?.status === 'confirmed') {
            return c.json({ received: true }, 200);
          }

          result = await processWebhookCredit(db, { helcimTransactionId: event.id });
          if (result) break;
        }
      }

      if (!result) {
        console.error(`Webhook failed: payment not found for helcimTransactionId=${event.id}`);
        return c.json(createErrorResponse(ERROR_PAYMENT_NOT_FOUND, ERROR_CODE_INTERNAL), 500);
      }
    }

    return c.json({ received: true }, 200);
  });

  return app;
}
