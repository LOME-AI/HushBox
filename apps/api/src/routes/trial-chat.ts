import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { streamSSE } from 'hono/streaming';
import {
  ERROR_CODE_VALIDATION,
  ERROR_CODE_DAILY_LIMIT_EXCEEDED,
  ERROR_CODE_PREMIUM_REQUIRES_ACCOUNT,
  ERROR_CODE_AUTHENTICATED_ON_TRIAL,
  ERROR_CODE_TRIAL_MESSAGE_TOO_EXPENSIVE,
  calculateBudget,
  resolveBilling,
  applyFees,
  buildSystemPrompt,
} from '@hushbox/shared';
import type { AppEnv } from '../types.js';
import { buildPrompt } from '../services/prompt/builder.js';
import { consumeTrialMessage } from '../services/billing/index.js';
import { processModels } from '../services/models.js';
import { fetchModels, fetchZdrModelIds } from '../services/openrouter/index.js';
import { validateLastMessageIsFromUser, buildOpenRouterMessages } from '../services/chat/index.js';
import { computeSafeMaxTokens } from '../services/chat/max-tokens.js';
import { createErrorResponse } from '../lib/error-response.js';
import { createSSEEventWriter } from '../lib/stream-handler.js';
import { hashIp, getClientIp } from '../lib/client-ip.js';
import type { Context } from 'hono';

interface TrialMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface TrialValidationSuccess {
  success: true;
  usageCheck: Awaited<ReturnType<typeof consumeTrialMessage>>;
  safeMaxTokens: number | undefined;
  budgetResult: ReturnType<typeof calculateBudget>;
}

interface TrialValidationFailure {
  success: false;
  response: Response;
}

type TrialQuotaResult =
  | { allowed: true; usageCheck: Awaited<ReturnType<typeof consumeTrialMessage>> }
  | { allowed: false; errorResponse: Response };

async function checkTrialQuota(
  c: Context<AppEnv>,
  trialToken: string | null,
  ipHash: string
): Promise<TrialQuotaResult> {
  const redis = c.get('redis');
  const usageCheck = await consumeTrialMessage(redis, trialToken, ipHash);

  if (!usageCheck.canSend) {
    return {
      allowed: false,
      errorResponse: c.json(
        createErrorResponse(ERROR_CODE_DAILY_LIMIT_EXCEEDED, {
          limit: usageCheck.limit,
          remaining: 0,
        }),
        429
      ),
    };
  }

  return { allowed: true, usageCheck };
}

function checkTrialModelAccess(
  c: Context<AppEnv>,
  model: string,
  premiumIds: string[]
): Response | null {
  if (premiumIds.includes(model)) {
    return c.json(createErrorResponse(ERROR_CODE_PREMIUM_REQUIRES_ACCOUNT), 403);
  }
  return null;
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

type TrialBudgetResult =
  | {
      allowed: true;
      budgetResult: ReturnType<typeof calculateBudget>;
      safeMaxTokens: number | undefined;
    }
  | { allowed: false; errorResponse: Response };

function calculateTrialBudget(
  c: Context<AppEnv>,
  messages: TrialMessage[],
  pricing: ModelPricing
): TrialBudgetResult {
  const systemPromptForBudget = buildSystemPrompt([]);
  const historyCharacters = messages.reduce((sum, m) => sum + m.content.length, 0);
  const promptCharacterCount = systemPromptForBudget.length + historyCharacters;

  const budgetResult = calculateBudget({
    tier: 'trial',
    balanceCents: 0,
    freeAllowanceCents: 0,
    promptCharacterCount,
    modelInputPricePerToken: pricing.inputPricePerToken,
    modelOutputPricePerToken: pricing.outputPricePerToken,
    modelContextLength: pricing.contextLength,
  });

  const estimatedMinimumCostCents = Math.ceil(budgetResult.estimatedMinimumCost * 100);
  const billingResult = resolveBilling({
    tier: 'trial',
    balanceCents: 0,
    freeAllowanceCents: 0,
    isPremiumModel: false, // Premium already gated by checkTrialModelAccess()
    estimatedMinimumCostCents,
  });

  if (billingResult.fundingSource === 'denied') {
    return {
      allowed: false,
      errorResponse: c.json(createErrorResponse(ERROR_CODE_TRIAL_MESSAGE_TOO_EXPENSIVE), 402),
    };
  }

  const safeMaxTokens = computeSafeMaxTokens({
    budgetMaxTokens: budgetResult.maxOutputTokens,
    modelContextLength: pricing.contextLength,
    estimatedInputTokens: budgetResult.estimatedInputTokens,
  });

  return { allowed: true, budgetResult, safeMaxTokens };
}

async function validateTrialRequest(
  c: Context<AppEnv>,
  messages: TrialMessage[],
  model: string
): Promise<TrialValidationSuccess | TrialValidationFailure> {
  const session = c.get('session');
  if (session) {
    return {
      success: false,
      response: c.json(createErrorResponse(ERROR_CODE_AUTHENTICATED_ON_TRIAL), 400),
    };
  }

  if (!validateLastMessageIsFromUser(messages)) {
    return {
      success: false,
      response: c.json(createErrorResponse(ERROR_CODE_VALIDATION), 400),
    };
  }

  const trialToken = c.req.header('x-trial-token') ?? null;
  const ipHash = hashIp(getClientIp(c));

  const quotaResult = await checkTrialQuota(c, trialToken, ipHash);
  if (!quotaResult.allowed) {
    return { success: false, response: quotaResult.errorResponse };
  }

  const [allModels, zdrModelIds] = await Promise.all([fetchModels(), fetchZdrModelIds()]);
  const { premiumIds } = processModels(allModels, zdrModelIds);

  const modelError = checkTrialModelAccess(c, model, premiumIds);
  if (modelError) {
    return { success: false, response: modelError };
  }

  const pricing = getModelPricing(allModels, model);
  const budgetCheck = calculateTrialBudget(c, messages, pricing);
  if (!budgetCheck.allowed) {
    return { success: false, response: budgetCheck.errorResponse };
  }

  return {
    success: true,
    usageCheck: quotaResult.usageCheck,
    safeMaxTokens: budgetCheck.safeMaxTokens,
    budgetResult: budgetCheck.budgetResult,
  };
}

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

const trialStreamRequestSchema = z.object({
  messages: z.array(messageSchema).min(1),
  model: z.string(),
});

export const trialChatRoute = new Hono<AppEnv>().post(
  '/stream',
  zValidator('json', trialStreamRequestSchema),
  async (c) => {
    const { messages, model } = c.req.valid('json');
    const openrouter = c.get('openrouter');

    const validation = await validateTrialRequest(c, messages, model);
    if (!validation.success) {
      return validation.response;
    }
    const { safeMaxTokens } = validation;

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

      try {
        for await (const token of openrouter.chatCompletionStreamWithMetadata({
          model,
          messages: openRouterMessages,
          ...(safeMaxTokens !== undefined && { max_tokens: safeMaxTokens }),
        })) {
          await writer.writeToken(token.content);
        }
      } catch (error) {
        streamError = error instanceof Error ? error : new Error('Unknown error');
      }

      if (streamError) {
        await writer.writeError({ message: streamError.message, code: 'STREAM_ERROR' });
      } else {
        await writer.writeDone();
      }
    });
  }
);
