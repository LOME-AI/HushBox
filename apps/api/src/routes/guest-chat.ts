import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import {
  errorResponseSchema,
  ERROR_CODE_VALIDATION,
  ERROR_CODE_RATE_LIMITED,
  ERROR_CODE_FORBIDDEN,
} from '@lome-chat/shared';
import type { AppEnv } from '../types.js';
import { buildPrompt } from '../services/prompt/builder.js';
import { checkGuestUsage, incrementGuestUsage } from '../services/billing/index.js';
import { processModels } from '../services/models.js';
import { fetchModels } from '../services/openrouter/index.js';
import { validateLastMessageIsFromUser, buildOpenRouterMessages } from '../services/chat/index.js';
import { fireAndForget } from '../lib/fire-and-forget.js';
import { createErrorResponse } from '../lib/error-response.js';
import { createSSEEventWriter } from '../lib/stream-handler.js';
import { hashIp, getClientIp } from '../lib/client-ip.js';
import {
  ERROR_LAST_MESSAGE_NOT_USER,
  ERROR_DAILY_LIMIT_EXCEEDED,
  ERROR_PREMIUM_REQUIRES_ACCOUNT,
  ERROR_AUTHENTICATED_USER_ON_GUEST_ENDPOINT,
} from '../constants/errors.js';

const errorSchema = errorResponseSchema;

const rateLimitSchema = z.object({
  error: z.string(),
  limit: z.number(),
  remaining: z.number(),
});

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

const guestStreamRequestSchema = z.object({
  messages: z.array(messageSchema).min(1),
  model: z.string(),
});

const guestStreamRoute = createRoute({
  method: 'post',
  path: '/stream',
  request: {
    body: {
      content: {
        'application/json': {
          schema: guestStreamRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'SSE stream of chat response tokens',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid request',
    },
    403: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Premium model not allowed for guests',
    },
    429: {
      content: { 'application/json': { schema: rateLimitSchema } },
      description: 'Rate limit exceeded',
    },
  },
});

export function createGuestChatRoutes(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(guestStreamRoute, async (c) => {
    const { messages, model } = c.req.valid('json');
    const db = c.get('db');
    const openrouter = c.get('openrouter');

    // Reject authenticated users - they should use /chat/stream
    const session = c.get('session');
    if (session) {
      return c.json(
        createErrorResponse(ERROR_AUTHENTICATED_USER_ON_GUEST_ENDPOINT, ERROR_CODE_VALIDATION),
        400
      );
    }

    if (!validateLastMessageIsFromUser(messages)) {
      return c.json(createErrorResponse(ERROR_LAST_MESSAGE_NOT_USER, ERROR_CODE_VALIDATION), 400);
    }

    const guestToken = c.req.header('x-guest-token') ?? null;
    const clientIp = getClientIp(c);
    const ipHash = hashIp(clientIp);

    const usageCheck = await checkGuestUsage(db, guestToken, ipHash);
    if (!usageCheck.canSend) {
      return c.json(
        createErrorResponse(ERROR_DAILY_LIMIT_EXCEEDED, ERROR_CODE_RATE_LIMITED, {
          limit: usageCheck.limit,
          remaining: 0,
        }),
        429
      );
    }

    const allModels = await fetchModels();
    const { premiumIds } = processModels(allModels);

    if (premiumIds.includes(model)) {
      return c.json(createErrorResponse(ERROR_PREMIUM_REQUIRES_ACCOUNT, ERROR_CODE_FORBIDDEN), 403);
    }

    const assistantMessageId = crypto.randomUUID();

    const { systemPrompt } = buildPrompt({
      modelId: model,
      supportedCapabilities: [],
    });

    const openRouterMessages = buildOpenRouterMessages(systemPrompt, messages);

    return streamSSE(c, async (stream) => {
      const writer = createSSEEventWriter(stream);

      await writer.writeStart({ assistantMessageId });

      let streamError: Error | null = null;
      let streamCompleted = false;

      try {
        for await (const token of openrouter.chatCompletionStreamWithMetadata({
          model,
          messages: openRouterMessages,
        })) {
          await writer.writeToken(token.content);
        }
        streamCompleted = true;
      } catch (error) {
        streamError = error instanceof Error ? error : new Error('Unknown error');
      }

      // Increment guest usage after stream completes (regardless of client connection)
      // Only count if we got any response from OpenRouter
      // Pass existing record from check to skip duplicate query
      if (streamCompleted && !streamError) {
        fireAndForget(
          incrementGuestUsage(db, guestToken, ipHash, usageCheck.record),
          'increment guest usage'
        );
      }

      // Note: We do NOT persist the message for guests (ephemeral)

      if (streamError) {
        await writer.writeError({ message: streamError.message, code: 'STREAM_ERROR' });
      } else {
        await writer.writeDone();
      }
    });
  });

  return app;
}

export const guestChatRoute = createGuestChatRoutes();
