import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { payments, recordServiceEvidence, SERVICE_NAMES, type Database } from '@lome-chat/db';
import {
  createEnvUtilities,
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

interface SignatureHeaders {
  signature: string | undefined;
  timestamp: string | undefined;
  webhookId: string | undefined;
}

interface VerifySignatureResult {
  error?: { message: string; code: string; status: 401 | 500 };
}

async function verifySignatureIfRequired(
  webhookVerifier: string | undefined,
  rawBody: string,
  headers: SignatureHeaders,
  isProduction: boolean
): Promise<VerifySignatureResult> {
  if (isProduction && !webhookVerifier) {
    console.error('HELCIM_WEBHOOK_VERIFIER not configured in production');
    return {
      error: { message: ERROR_WEBHOOK_VERIFIER_MISSING, code: ERROR_CODE_INTERNAL, status: 500 },
    };
  }

  if (webhookVerifier && headers.signature && headers.timestamp && headers.webhookId) {
    const isValid = await verifyWebhookSignatureAsync({
      webhookVerifier,
      payload: rawBody,
      signatureHeader: headers.signature,
      timestamp: headers.timestamp,
      webhookId: headers.webhookId,
    });

    if (!isValid) {
      return {
        error: { message: ERROR_INVALID_SIGNATURE, code: ERROR_CODE_UNAUTHORIZED, status: 401 },
      };
    }
  }

  return {};
}

interface WebhookEvent {
  type: string;
  id: string;
}

function parseWebhookEvent(rawBody: string): WebhookEvent | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const typedParsed = parsed as Record<string, unknown>;
    const typeValue = typedParsed['type'];
    const idValue = typedParsed['id'] ?? typedParsed['transactionId'];
    return {
      type: typeof typeValue === 'string' ? typeValue : '',
      id: typeof idValue === 'string' || typeof idValue === 'number' ? String(idValue) : '',
    };
  } catch {
    return null;
  }
}

async function processWithRetry(
  db: Database,
  transactionId: string,
  isCI: boolean
): Promise<boolean> {
  const maxRetries = isCI ? 3 : 15;
  const retryDelay = isCI ? 500 : 1000;

  for (let index = 0; index < maxRetries; index++) {
    await new Promise((resolve) => setTimeout(resolve, retryDelay));

    const [check] = await db
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.helcimTransactionId, transactionId));

    if (check?.status === 'confirmed') return true;

    const result = await processWebhookCredit(db, { helcimTransactionId: transactionId });
    if (result) return true;
  }

  return false;
}

type CardTransactionResult =
  | { handled: true; alreadyConfirmed?: boolean }
  | { handled: false; shouldReturnError: boolean; errorMessage?: string };

async function handleCardTransaction(
  db: Database,
  transactionId: string,
  isCI: boolean
): Promise<CardTransactionResult> {
  const [existing] = await db
    .select({ status: payments.status })
    .from(payments)
    .where(eq(payments.helcimTransactionId, transactionId));

  if (existing?.status === 'confirmed') {
    return { handled: true, alreadyConfirmed: true };
  }

  const result = await processWebhookCredit(db, { helcimTransactionId: transactionId });
  if (result) {
    return { handled: true };
  }

  const success = await processWithRetry(db, transactionId, isCI);
  if (success) {
    return { handled: true };
  }

  if (isCI) {
    return { handled: true };
  }

  console.error(`Webhook failed: payment not found for helcimTransactionId=${transactionId}`);
  return { handled: false, shouldReturnError: true, errorMessage: ERROR_PAYMENT_NOT_FOUND };
}

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
    const { isProduction, isCI } = createEnvUtilities(c.env);

    await recordServiceEvidence(db, isCI, SERVICE_NAMES.HOOKDECK);

    const rawBody = await c.req.text();
    const headers: SignatureHeaders = {
      signature: c.req.header('webhook-signature'),
      timestamp: c.req.header('webhook-timestamp'),
      webhookId: c.req.header('webhook-id'),
    };

    const verifyResult = await verifySignatureIfRequired(
      c.env.HELCIM_WEBHOOK_VERIFIER,
      rawBody,
      headers,
      isProduction
    );
    if (verifyResult.error) {
      return c.json(
        createErrorResponse(verifyResult.error.message, verifyResult.error.code),
        verifyResult.error.status
      );
    }

    const event = parseWebhookEvent(rawBody);
    if (!event) {
      return c.json(createErrorResponse(ERROR_INVALID_JSON, ERROR_CODE_VALIDATION), 400);
    }

    if (event.type === 'cardTransaction') {
      const result = await handleCardTransaction(db, event.id, isCI);
      if (!result.handled && result.shouldReturnError) {
        return c.json(
          createErrorResponse(result.errorMessage ?? ERROR_PAYMENT_NOT_FOUND, ERROR_CODE_INTERNAL),
          500
        );
      }
    }

    return c.json({ received: true }, 200);
  });

  return app;
}
