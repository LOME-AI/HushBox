import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { eq, asc } from 'drizzle-orm';
import { conversations, messages, type Database } from '@lome-chat/db';
import {
  errorResponseSchema,
  ERROR_CODE_NOT_FOUND,
  ERROR_CODE_VALIDATION,
  ERROR_CODE_PAYMENT_REQUIRED,
  ERROR_CODE_INSUFFICIENT_BALANCE,
  ERROR_CODE_UNAUTHORIZED,
  calculateBudget,
  applyFees,
  buildSystemPrompt,
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
import { computeSafeMaxTokens } from '../services/chat/max-tokens.js';
import { createErrorResponse } from '../lib/error-response.js';
import { createSSEEventWriter } from '../lib/stream-handler.js';
import { requireAuth } from '../middleware/require-auth.js';
import {
  ERROR_CONVERSATION_NOT_FOUND,
  ERROR_LAST_MESSAGE_NOT_USER,
  ERROR_INSUFFICIENT_BALANCE,
  ERROR_PREMIUM_REQUIRES_BALANCE,
  ERROR_UNAUTHORIZED,
} from '../constants/errors.js';
import type { Context } from 'hono';

const errorSchema = errorResponseSchema;

type Message = typeof messages.$inferSelect;
type Conversation = typeof conversations.$inferSelect;

interface ChatValidationSuccess {
  success: true;
  conversation: Conversation;
  messageHistory: Message[];
  lastMessage: Message;
}

interface ChatValidationFailure {
  success: false;
  response: Response;
}

async function validateChatRequest(
  c: Context<AppEnv>,
  conversationId: string,
  userId: string
): Promise<ChatValidationSuccess | ChatValidationFailure> {
  const db = c.get('db');

  const conversation = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)
    .then((rows) => rows[0]);

  if (conversation?.userId !== userId) {
    return {
      success: false,
      response: c.json(
        createErrorResponse(ERROR_CONVERSATION_NOT_FOUND, ERROR_CODE_NOT_FOUND),
        404
      ),
    };
  }

  const messageHistory = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));

  if (!validateLastMessageIsFromUser(messageHistory)) {
    return {
      success: false,
      response: c.json(
        createErrorResponse(ERROR_LAST_MESSAGE_NOT_USER, ERROR_CODE_VALIDATION),
        400
      ),
    };
  }

  const lastMessage = messageHistory.at(-1);
  if (!lastMessage) {
    return {
      success: false,
      response: c.json(
        createErrorResponse(ERROR_LAST_MESSAGE_NOT_USER, ERROR_CODE_VALIDATION),
        400
      ),
    };
  }

  return { success: true, conversation, messageHistory, lastMessage };
}

interface BillingValidationSuccess {
  success: true;
  tierInfo: Awaited<ReturnType<typeof getUserTierInfo>>;
  deductionSource: 'balance' | 'freeAllowance';
  budgetResult: ReturnType<typeof calculateBudget>;
  safeMaxTokens: number | undefined;
  openrouterModels: Awaited<ReturnType<typeof fetchModels>>;
}

interface BillingValidationFailure {
  success: false;
  response: Response;
}

function checkPremiumModelAccess(
  c: Context<AppEnv>,
  tierInfo: Awaited<ReturnType<typeof getUserTierInfo>>,
  isPremiumModel: boolean
): Response | null {
  const sendCheck = canUserSendMessage(tierInfo, isPremiumModel);
  if (!sendCheck.canSend) {
    return c.json(
      createErrorResponse(ERROR_PREMIUM_REQUIRES_BALANCE, ERROR_CODE_PAYMENT_REQUIRED, {
        currentBalance: (tierInfo.balanceCents / 100).toFixed(2),
      }),
      402
    );
  }
  return null;
}

type BalanceCheckResult =
  | { hasAccess: true; deductionSource: 'balance' | 'freeAllowance' }
  | { hasAccess: false; errorResponse: Response };

function checkBalanceOrAllowance(
  c: Context<AppEnv>,
  tierInfo: Awaited<ReturnType<typeof getUserTierInfo>>,
  isPremiumModel: boolean
): BalanceCheckResult {
  const canUseFreeAllowance =
    tierInfo.balanceCents <= 0 && !isPremiumModel && tierInfo.freeAllowanceCents > 0;
  const deductionSource: 'balance' | 'freeAllowance' =
    tierInfo.balanceCents > 0 ? 'balance' : 'freeAllowance';

  if (tierInfo.balanceCents <= 0 && !canUseFreeAllowance) {
    return {
      hasAccess: false,
      errorResponse: c.json(
        createErrorResponse(ERROR_INSUFFICIENT_BALANCE, ERROR_CODE_INSUFFICIENT_BALANCE, {
          currentBalance: '0.00',
        }),
        402
      ),
    };
  }

  return { hasAccess: true, deductionSource };
}

interface ModelPricing {
  inputPricePerToken: number;
  outputPricePerToken: number;
  contextLength: number;
}

function getModelPricing(
  models: Awaited<ReturnType<typeof fetchModels>>,
  modelId: string
): ModelPricing {
  const modelInfo = models.find((m) => m.id === modelId);
  const inputPricePerToken = applyFees(modelInfo ? Number.parseFloat(modelInfo.pricing.prompt) : 0);
  const outputPricePerToken = applyFees(
    modelInfo ? Number.parseFloat(modelInfo.pricing.completion) : 0
  );
  const contextLength = modelInfo?.context_length ?? 128_000;

  return { inputPricePerToken, outputPricePerToken, contextLength };
}

type AffordabilityResult =
  | {
      canAfford: true;
      budgetResult: ReturnType<typeof calculateBudget>;
      safeMaxTokens: number | undefined;
    }
  | { canAfford: false; errorResponse: Response };

function checkAffordability(
  c: Context<AppEnv>,
  tierInfo: Awaited<ReturnType<typeof getUserTierInfo>>,
  pricing: ModelPricing,
  messageHistory: Message[]
): AffordabilityResult {
  const systemPromptForBudget = buildSystemPrompt([]);
  const historyCharacters = messageHistory.reduce((sum, m) => sum + m.content.length, 0);
  const promptCharacterCount = systemPromptForBudget.length + historyCharacters;

  const budgetResult = calculateBudget({
    tier: tierInfo.tier,
    balanceCents: tierInfo.balanceCents,
    freeAllowanceCents: tierInfo.freeAllowanceCents,
    promptCharacterCount,
    modelInputPricePerToken: pricing.inputPricePerToken,
    modelOutputPricePerToken: pricing.outputPricePerToken,
    modelContextLength: pricing.contextLength,
  });

  if (!budgetResult.canAfford) {
    return {
      canAfford: false,
      errorResponse: c.json(
        createErrorResponse(ERROR_INSUFFICIENT_BALANCE, ERROR_CODE_INSUFFICIENT_BALANCE, {
          currentBalance: (tierInfo.balanceCents / 100).toFixed(2),
        }),
        402
      ),
    };
  }

  const safeMaxTokens = computeSafeMaxTokens({
    budgetMaxTokens: budgetResult.maxOutputTokens,
    modelContextLength: pricing.contextLength,
    estimatedInputTokens: budgetResult.estimatedInputTokens,
  });

  return { canAfford: true, budgetResult, safeMaxTokens };
}

async function validateBilling(
  c: Context<AppEnv>,
  userId: string,
  model: string,
  messageHistory: Message[]
): Promise<BillingValidationSuccess | BillingValidationFailure> {
  const db = c.get('db');

  const tierInfo = await getUserTierInfo(db, userId);
  const openrouterModels = await fetchModels();
  const { premiumIds } = processModels(openrouterModels);
  const isPremiumModel = premiumIds.includes(model);

  const premiumError = checkPremiumModelAccess(c, tierInfo, isPremiumModel);
  if (premiumError) {
    return { success: false, response: premiumError };
  }

  const balanceResult = checkBalanceOrAllowance(c, tierInfo, isPremiumModel);
  if (!balanceResult.hasAccess) {
    return { success: false, response: balanceResult.errorResponse };
  }

  const pricing = getModelPricing(openrouterModels, model);
  const affordability = checkAffordability(c, tierInfo, pricing, messageHistory);
  if (!affordability.canAfford) {
    return { success: false, response: affordability.errorResponse };
  }

  return {
    success: true,
    tierInfo,
    deductionSource: balanceResult.deductionSource,
    budgetResult: affordability.budgetResult,
    safeMaxTokens: affordability.safeMaxTokens,
    openrouterModels,
  };
}

interface StreamResult {
  fullContent: string;
  generationId: string | undefined;
  error: Error | null;
}

type OpenRouterClient = ReturnType<
  typeof import('../services/openrouter/index.js').createOpenRouterClient
>;
type SSEEventWriter = ReturnType<typeof createSSEEventWriter>;

async function collectStreamTokens(
  tokenStream: AsyncIterable<{ content: string; generationId?: string }>,
  writer: SSEEventWriter
): Promise<StreamResult> {
  let fullContent = '';
  let generationId: string | undefined;
  let error: Error | null = null;

  try {
    for await (const token of tokenStream) {
      if (token.generationId) {
        generationId = token.generationId;
      }
      fullContent += token.content;
      await writer.writeToken(token.content);
    }
  } catch (error_) {
    error = error_ instanceof Error ? error_ : new Error('Unknown error');
  }

  return { fullContent, generationId, error };
}

interface BillingOptions {
  openrouter: OpenRouterClient;
  openrouterModels: Awaited<ReturnType<typeof fetchModels>>;
  model: string;
  generationId: string | undefined;
  lastMessageContent: string;
  fullContent: string;
  db: Database;
  assistantMessageId: string;
  conversationId: string;
  userId: string;
  inputCharacters: number;
  deductionSource: 'balance' | 'freeAllowance';
}

async function processBillingAfterStream(options: BillingOptions): Promise<void> {
  const {
    openrouter,
    openrouterModels,
    model,
    generationId,
    lastMessageContent,
    fullContent,
    db,
    assistantMessageId,
    conversationId,
    userId,
    inputCharacters,
    deductionSource,
  } = options;

  try {
    const modelInfo = openrouterModels.find((m) => m.id === model);
    const totalCost = await calculateMessageCost({
      openrouter,
      modelInfo,
      generationId,
      inputContent: lastMessageContent,
      outputContent: fullContent,
    });

    await saveMessageWithBilling(db, {
      messageId: assistantMessageId,
      conversationId,
      content: fullContent,
      model,
      userId,
      totalCost,
      inputCharacters,
      outputCharacters: fullContent.length,
      deductionSource,
    });
  } catch (billingError) {
    console.error(
      JSON.stringify({
        event: 'billing_failed',
        messageId: assistantMessageId,
        userId,
        model,
        generationId,
        error: billingError instanceof Error ? billingError.message : String(billingError),
        timestamp: new Date().toISOString(),
      })
    );
  }
}

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

  app.use('*', requireAuth());

  app.openapi(streamChatRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }
    const { conversationId, model } = c.req.valid('json');
    const db = c.get('db');
    const openrouter = c.get('openrouter');

    const chatValidation = await validateChatRequest(c, conversationId, user.id);
    if (!chatValidation.success) {
      return chatValidation.response;
    }
    const { messageHistory, lastMessage } = chatValidation;

    const billingValidation = await validateBilling(c, user.id, model, messageHistory);
    if (!billingValidation.success) {
      return billingValidation.response;
    }
    const { deductionSource, safeMaxTokens, openrouterModels } = billingValidation;

    const assistantMessageId = crypto.randomUUID();

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

      const tokenStream = openrouter.chatCompletionStreamWithMetadata({
        model,
        messages: openRouterMessages,
        ...(safeMaxTokens !== undefined && { max_tokens: safeMaxTokens }),
      });

      const result = await collectStreamTokens(tokenStream, writer);

      if (result.fullContent.length > 0 && !result.error) {
        await processBillingAfterStream({
          openrouter,
          openrouterModels,
          model,
          generationId: result.generationId,
          lastMessageContent: lastMessage.content,
          fullContent: result.fullContent,
          db,
          assistantMessageId,
          conversationId,
          userId: user.id,
          inputCharacters,
          deductionSource,
        });
      }

      if (result.error) {
        await writer.writeError({ message: result.error.message, code: 'STREAM_ERROR' });
      } else {
        await writer.writeDone();
      }
    });
  });

  return app;
}

export const chatRoute = createChatRoutes();
