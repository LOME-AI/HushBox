import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { createHash } from 'crypto';
import type { AppEnv } from '../types.js';
import type { ChatMessage } from '../services/openrouter/types.js';
import { buildPrompt } from '../services/prompt/builder.js';
import { checkGuestUsage, incrementGuestUsage } from '../services/billing/index.js';
import { processModels } from '../services/models.js';

const errorSchema = z.object({
  error: z.string(),
});

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

/**
 * Hash an IP address for privacy.
 */
function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex');
}

/**
 * Get client IP from request headers.
 */
function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  // Check common proxy headers
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    // Take the first IP if there are multiple
    return forwarded.split(',')[0]?.trim() ?? 'unknown';
  }

  const realIp = c.req.header('x-real-ip');
  if (realIp) {
    return realIp;
  }

  return 'unknown';
}

export function createGuestChatRoutes(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(guestStreamRoute, async (c) => {
    const { messages, model } = c.req.valid('json');
    const db = c.get('db');
    const openrouter = c.get('openrouter');

    // Validate last message is from user
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role !== 'user') {
      return c.json({ error: 'Last message must be from user' }, 400);
    }

    // Get guest identity
    const guestToken = c.req.header('x-guest-token') ?? null;
    const clientIp = getClientIp(c);
    const ipHash = hashIp(clientIp);

    // Check guest usage limits
    const usageCheck = await checkGuestUsage(db, guestToken, ipHash);
    if (!usageCheck.canSend) {
      return c.json(
        {
          error: 'Daily message limit reached. Sign up for unlimited access.',
          limit: usageCheck.limit,
          remaining: 0,
        },
        429
      );
    }

    // Check if model is premium (guests can only use basic models)
    const allModels = await openrouter.listModels();
    const { premiumIds } = processModels(allModels);

    if (premiumIds.includes(model)) {
      return c.json(
        { error: 'Premium models require a free account. Sign up to access this model.' },
        403
      );
    }

    const assistantMessageId = crypto.randomUUID();

    // Build prompt
    const { systemPrompt } = buildPrompt({
      modelId: model,
      supportedCapabilities: [],
    });

    const openRouterMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
    ];

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'start',
        data: JSON.stringify({
          assistantMessageId,
        }),
      });

      try {
        for await (const token of openrouter.chatCompletionStreamWithMetadata({
          model,
          messages: openRouterMessages,
        })) {
          await stream.writeSSE({
            event: 'token',
            data: JSON.stringify({ content: token.content }),
          });
        }

        // Increment guest usage after successful completion
        // Fire-and-forget - don't block response
        void incrementGuestUsage(db, guestToken, ipHash).catch((err: unknown) => {
          console.error('Failed to increment guest usage:', err);
        });

        // Note: We do NOT persist the message for guests (ephemeral)

        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({}),
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: errorMessage, code: 'STREAM_ERROR' }),
        });
      }
    });
  });

  return app;
}

export const guestChatRoute = createGuestChatRoutes();
