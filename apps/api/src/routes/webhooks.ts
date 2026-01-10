import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import {
  errorResponseSchema,
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_VALIDATION,
} from '@lome-chat/shared';
import { verifyWebhookSignatureAsync } from '../services/helcim/index.js';
import { processWebhookCredit } from '../services/billing/index.js';
import { createErrorResponse } from '../lib/error-response.js';
import { ERROR_INVALID_SIGNATURE, ERROR_INVALID_JSON } from '../constants/errors.js';
import type { AppEnv } from '../types.js';

// Response schemas for OpenAPI documentation
const errorSchema = errorResponseSchema;

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
      await processWebhookCredit(db, { helcimTransactionId: event.id });
    }

    return c.json({ received: true }, 200);
  });

  return app;
}
