import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { eq, asc } from 'drizzle-orm';
import { conversations, messages } from '@lome-chat/db';
import {
  errorResponseSchema,
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_NOT_FOUND,
  ERROR_CODE_VALIDATION,
  ERROR_CODE_PAYMENT_REQUIRED,
  ERROR_CODE_INSUFFICIENT_BALANCE,
  type DeductionSource,
} from '@lome-chat/shared';
import type { AppEnv } from '../types.js';
import { buildPrompt } from '../services/prompt/builder.js';
import {
  getUserTierInfo,
  calculateMessageCost,
  canUserSendMessage,
} from '../services/billing/index.js';
import { fetchModels } from '../services/openrouter/index.js';
import { processModels } from '../services/models.js';
import {
  validateLastMessageIsFromUser,
  buildOpenRouterMessages,
  saveMessageWithBilling,
} from '../services/chat/index.js';
import { createErrorResponse } from '../lib/error-response.js';
import { createSSEEventWriter } from '../lib/stream-handler.js';
import {
  ERROR_UNAUTHORIZED,
  ERROR_CONVERSATION_NOT_FOUND,
  ERROR_LAST_MESSAGE_NOT_USER,
  ERROR_INSUFFICIENT_BALANCE,
  ERROR_PREMIUM_REQUIRES_BALANCE,
} from '../constants/errors.js';

const errorSchema = errorResponseSchema;

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
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
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
      return c.json(createErrorResponse(ERROR_CONVERSATION_NOT_FOUND, ERROR_CODE_NOT_FOUND), 404);
    }

    if (conversation.userId !== user.id) {
      return c.json(createErrorResponse(ERROR_CONVERSATION_NOT_FOUND, ERROR_CODE_NOT_FOUND), 404);
    }

    const messageHistory = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));

    if (!validateLastMessageIsFromUser(messageHistory)) {
      return c.json(createErrorResponse(ERROR_LAST_MESSAGE_NOT_USER, ERROR_CODE_VALIDATION), 400);
    }

    const lastMessage = messageHistory[messageHistory.length - 1];
    if (!lastMessage) {
      return c.json(createErrorResponse(ERROR_LAST_MESSAGE_NOT_USER, ERROR_CODE_VALIDATION), 400);
    }

    const tierInfo = await getUserTierInfo(db, user.id);

    const openrouterModels = await fetchModels();
    const { premiumIds } = processModels(openrouterModels);
    const isPremiumModel = premiumIds.includes(model);

    const sendCheck = canUserSendMessage(tierInfo, isPremiumModel);
    if (!sendCheck.canSend) {
      return c.json(
        createErrorResponse(ERROR_PREMIUM_REQUIRES_BALANCE, ERROR_CODE_PAYMENT_REQUIRED, {
          currentBalance: (tierInfo.balanceCents / 100).toFixed(2),
        }),
        402
      );
    }

    // Determine deduction source: balance first, then free allowance for non-premium models
    const canUseFreeAllowance =
      tierInfo.balanceCents <= 0 && !isPremiumModel && tierInfo.freeAllowanceCents > 0;
    const deductionSource: DeductionSource =
      tierInfo.balanceCents > 0 ? 'balance' : 'freeAllowance';

    // Check if user has any funds
    if (tierInfo.balanceCents <= 0 && !canUseFreeAllowance) {
      return c.json(
        createErrorResponse(ERROR_INSUFFICIENT_BALANCE, ERROR_CODE_INSUFFICIENT_BALANCE, {
          currentBalance: '0.00',
        }),
        402
      );
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

    const openRouterMessages = buildOpenRouterMessages(systemPrompt, messageHistory);

    const inputCharacters = lastMessage.content.length;

    return streamSSE(c, async (stream) => {
      const writer = createSSEEventWriter(stream);

      await writer.writeStart({
        userMessageId: lastMessage.id,
        assistantMessageId,
      });

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
          await writer.writeToken(token.content);
        }
      } catch (error) {
        streamError = error instanceof Error ? error : new Error('Unknown error');
      }

      if (fullContent.length > 0 && !streamError) {
        const outputCharacters = fullContent.length;

        try {
          const modelInfo = openrouterModels.find((m) => m.id === model);
          const totalCost = await calculateMessageCost({
            openrouter,
            modelInfo,
            generationId,
            inputContent: lastMessage.content,
            outputContent: fullContent,
            isProduction: c.env.NODE_ENV === 'production',
          });

          // Atomic save + billing (same path dev/prod)
          await saveMessageWithBilling(db, {
            messageId: assistantMessageId,
            conversationId,
            content: fullContent,
            model,
            userId: user.id,
            totalCost,
            inputCharacters,
            outputCharacters,
            deductionSource,
          });
        } catch (billingError) {
          console.error(
            JSON.stringify({
              event: 'billing_failed',
              messageId: assistantMessageId,
              userId: user.id,
              model,
              generationId,
              error: billingError instanceof Error ? billingError.message : String(billingError),
              timestamp: new Date().toISOString(),
            })
          );
        }
      }

      if (streamError) {
        await writer.writeError({ message: streamError.message, code: 'STREAM_ERROR' });
      } else {
        await writer.writeDone();
      }
    });
  });

  return app;
}

export const chatRoute = createChatRoutes();
