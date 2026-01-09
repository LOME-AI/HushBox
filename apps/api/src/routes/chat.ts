import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { eq, asc } from 'drizzle-orm';
import { conversations, messages } from '@lome-chat/db';
import { canUseModel } from '@lome-chat/shared';
import type { DeductionSource } from '@lome-chat/shared';
import type { AppEnv } from '../types.js';
import type { ChatMessage } from '../services/openrouter/types.js';
import { buildPrompt } from '../services/prompt/builder.js';
import { getUserTierInfo, billMessage } from '../services/billing/index.js';
import { fetchModels } from '../services/openrouter/index.js';
import { processModels } from '../services/models.js';

const errorSchema = z.object({
  error: z.string(),
});

const insufficientBalanceSchema = z.object({
  error: z.literal('Insufficient balance'),
  currentBalance: z.string(),
});

const streamChatRequestSchema = z.object({
  conversationId: z.string(),
  model: z.string(),
});

const streamChatRoute = createRoute({
  method: 'post',
  path: '/stream',
  request: {
    body: {
      content: {
        'application/json': {
          schema: streamChatRequestSchema,
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
      description: 'Invalid request (e.g., last message not from user)',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    402: {
      content: { 'application/json': { schema: insufficientBalanceSchema } },
      description: 'Insufficient balance - user needs to add credits',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Conversation not found',
    },
  },
});

export function createChatRoutes(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(streamChatRoute, async (c) => {
    const user = c.get('user');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { conversationId, model } = c.req.valid('json');
    const db = c.get('db');
    const openrouter = c.get('openrouter');

    const conversation = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!conversation) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    if (conversation.userId !== user.id) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    const messageHistory = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));

    const lastMessage = messageHistory[messageHistory.length - 1];
    if (lastMessage?.role !== 'user') {
      return c.json({ error: 'Last message must be from user' }, 400);
    }

    const tierInfo = await getUserTierInfo(db, user.id);

    const allModels = await fetchModels();
    const { premiumIds } = processModels(allModels);
    const isPremiumModel = premiumIds.includes(model);

    if (!canUseModel(tierInfo, isPremiumModel)) {
      return c.json(
        {
          error: 'Premium models require a positive balance. Add credits to access.' as const,
          currentBalance: (tierInfo.balanceCents / 100).toFixed(2),
        },
        402
      );
    }

    let deductionSource: DeductionSource = 'balance';
    if (tierInfo.balanceCents <= 0 && !isPremiumModel && tierInfo.freeAllowanceCents > 0) {
      deductionSource = 'freeAllowance';
    } else if (tierInfo.balanceCents <= 0) {
      return c.json({ error: 'Insufficient balance' as const, currentBalance: '0.00' }, 402);
    }

    const assistantMessageId = crypto.randomUUID();

    // TODO: Remove empty capabilities when Python/JavaScript execution is implemented.
    // Currently we don't have sandbox execution, so don't send tools to avoid
    // the model trying to use them. When ready, check model.supported_parameters
    // to determine which capabilities to enable.
    const { systemPrompt } = buildPrompt({
      modelId: model,
      supportedCapabilities: [],
    });

    const openRouterMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messageHistory.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
    ];

    const inputCharacters = lastMessage.content.length;

    return streamSSE(c, async (stream) => {
      let clientConnected = true;

      stream.onAbort(() => {
        clientConnected = false;
      });

      try {
        await stream.writeSSE({
          event: 'start',
          data: JSON.stringify({
            userMessageId: lastMessage.id,
            assistantMessageId,
          }),
        });
      } catch {
        clientConnected = false;
      }

      let fullContent = '';
      let generationId: string | undefined;
      let streamError: Error | null = null;

      try {
        for await (const token of openrouter.chatCompletionStreamWithMetadata({
          model,
          messages: openRouterMessages,
        })) {
          if (token.generationId) {
            generationId = token.generationId;
          }

          fullContent += token.content;

          if (clientConnected) {
            try {
              await stream.writeSSE({
                event: 'token',
                data: JSON.stringify({ content: token.content }),
              });
            } catch {
              clientConnected = false;
            }
          }
        }
      } catch (error) {
        streamError = error instanceof Error ? error : new Error('Unknown error');
      }

      if (fullContent.length > 0 && !streamError) {
        await db.insert(messages).values({
          id: assistantMessageId,
          conversationId,
          role: 'assistant',
          content: fullContent,
          model,
        });

        if (generationId) {
          const outputCharacters = fullContent.length;
          const genId = generationId; // Capture for closure

          void (async () => {
            try {
              const stats = await openrouter.getGenerationStats(genId);
              await billMessage(db, {
                userId: user.id,
                messageId: assistantMessageId,
                model,
                generationStats: stats,
                inputCharacters,
                outputCharacters,
                deductionSource,
              });
            } catch (billingError) {
              console.error('Billing failed:', billingError);
            }
          })();
        }
      }

      if (clientConnected) {
        try {
          if (streamError) {
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ message: streamError.message, code: 'STREAM_ERROR' }),
            });
          } else {
            await stream.writeSSE({
              event: 'done',
              data: JSON.stringify({}),
            });
          }
        } catch {
          // Stream cleanup errors can be ignored
        }
      }
    });
  });

  return app;
}

export const chatRoute = createChatRoutes();
