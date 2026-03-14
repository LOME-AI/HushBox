/**
 * Shared streaming pipeline used by both authenticated chat and link-guest endpoints.
 *
 * Extracted from chat.ts for reuse without code duplication. Contains:
 * - Billing resolution and reservation logic
 * - SSE streaming pipeline with multi-model support
 * - Utility functions for pricing, broadcasting, and cost computation
 */

import { streamSSE } from 'hono/streaming';
import {
  calculateBudget,
  applyFees,
  getModelPricing,
  buildSystemPrompt,
  estimateTokenCount,
  buildCostManifest,
  calculateBudgetFromManifest,
  canAffordModel,
  effectiveBudgetCents,
  resolveBilling,
  getCushionCents,
  AUTO_ROUTER_MODEL_ID,
  ERROR_CODE_INSUFFICIENT_BALANCE,
  ERROR_CODE_BILLING_MISMATCH,
  ERROR_CODE_PREMIUM_REQUIRES_BALANCE,
  ERROR_CODE_BALANCE_RESERVED,
  ERROR_CODE_CONTEXT_LENGTH_EXCEEDED,
  ERROR_CODE_STREAM_ERROR,
  ERROR_CODE_BILLING_ERROR,
  parseTokenPrice,
} from '@hushbox/shared';
import type { FundingSource, DenialReason, ResolveBillingInput } from '@hushbox/shared';
import type { AppEnv, Bindings } from '../types.js';
import { buildPrompt } from '../services/prompt/builder.js';
import type { BuildBillingResult, MemberContext } from '../services/billing/index.js';
import { calculateMessageCost } from '../services/billing/index.js';
import { fetchModels, fetchZdrModelIds, processModels } from '@hushbox/shared/models';
import { ContextCapacityError } from '../services/openrouter/openrouter.js';
import type { ChatMessage, ChatCompletionRequest } from '../services/openrouter/types.js';
import { buildOpenRouterMessages, saveChatTurn } from '../services/chat/index.js';
import type { SaveChatTurnResult } from '../services/chat/index.js';
import { computeSafeMaxTokens } from '../services/chat/max-tokens.js';
import { createErrorResponse } from './error-response.js';
import { createSSEEventWriter } from './stream-handler.js';
import { collectMultiModelStreams, type ModelStreamEntry } from './multi-stream.js';
import { broadcastToRoom } from './broadcast.js';
import { createEvent } from '@hushbox/realtime/events';
import {
  reserveBudget,
  releaseBudget,
  reserveGroupBudget,
  releaseGroupBudget,
  type GroupBudgetReservation,
} from './speculative-balance.js';
import type { Context } from 'hono';

// ============================================================================
// Types
// ============================================================================

export interface MessageForInference {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface BillingValidationSuccess {
  success: true;
  billingInput: ResolveBillingInput;
  budgetResult: ReturnType<typeof calculateBudget>;
  safeMaxTokens: number | undefined;
  openrouterModels: Awaited<ReturnType<typeof fetchModels>>;
  worstCaseCents: number;
  groupBudget?: GroupBudgetReservation;
  billingUserId: string;
  autoRouterAllowedModels?: string[];
}

export interface BillingValidationFailure {
  success: false;
  response: Response;
}

export interface BroadcastContext {
  env: Bindings;
  conversationId: string;
  assistantMessageId: string;
  modelName?: string;
}

export interface StreamResult {
  fullContent: string;
  generationId: string | undefined;
  error: Error | null;
}

type SSEEventWriter = ReturnType<typeof createSSEEventWriter>;

export const BATCH_INTERVAL_MS = 100;

// ============================================================================
// Utility Functions
// ============================================================================

export function lookupModelPricing(
  models: Awaited<ReturnType<typeof fetchModels>>,
  modelId: string
): ReturnType<typeof getModelPricing> {
  const modelInfo = models.find((m) => m.id === modelId);
  const rawInput = modelInfo ? parseTokenPrice(modelInfo.pricing.prompt) : 0;
  const rawOutput = modelInfo ? parseTokenPrice(modelInfo.pricing.completion) : 0;
  return getModelPricing(rawInput, rawOutput, modelInfo?.context_length ?? 128_000);
}

/**
 * Worst-case cost for a message reservation in cents.
 * No Math.ceil — floor() in calculateBudget already guarantees worstCaseCents ≤ availableCents.
 * Redis INCRBYFLOAT handles floats natively.
 */
export function computeWorstCaseCents(
  estimatedInputCost: number,
  effectiveMaxOutputTokens: number,
  outputCostPerToken: number
): number {
  return (estimatedInputCost + effectiveMaxOutputTokens * outputCostPerToken) * 100;
}

function handleBillingDenial(
  c: Context<AppEnv>,
  reason: DenialReason,
  billingInput: ResolveBillingInput
): Response {
  switch (reason) {
    case 'premium_requires_balance': {
      return c.json(
        createErrorResponse(ERROR_CODE_PREMIUM_REQUIRES_BALANCE, {
          currentBalance: (billingInput.balanceCents / 100).toFixed(2),
        }),
        402
      );
    }
    case 'insufficient_balance': {
      return c.json(
        createErrorResponse(ERROR_CODE_INSUFFICIENT_BALANCE, {
          currentBalance: (billingInput.balanceCents / 100).toFixed(2),
        }),
        402
      );
    }
    case 'insufficient_free_allowance': {
      return c.json(
        createErrorResponse(ERROR_CODE_INSUFFICIENT_BALANCE, {
          currentBalance: (billingInput.freeAllowanceCents / 100).toFixed(2),
        }),
        402
      );
    }
    case 'guest_limit_exceeded': {
      return c.json(createErrorResponse(ERROR_CODE_INSUFFICIENT_BALANCE), 402);
    }
  }
}

/** Resolve per-search cost in USD from model pricing. Returns 0 when search is disabled. */
export function resolveWebSearchCost(
  webSearchEnabled: boolean,
  model: string,
  openrouterModels: Awaited<ReturnType<typeof fetchModels>>
): number {
  if (!webSearchEnabled) return 0;
  const modelInfo = openrouterModels.find((m) => m.id === model);
  if (!modelInfo?.pricing.web_search) return 0;
  return parseTokenPrice(modelInfo.pricing.web_search);
}

export interface BuildOpenRouterRequestOptions {
  model: string;
  messages: ChatMessage[];
  safeMaxTokens: number | undefined;
  webSearchEnabled: boolean;
  autoRouterAllowedModels?: string[] | undefined;
}

/** Build the ChatCompletionRequest for OpenRouter, conditionally adding max_tokens and plugins. */
export function buildOpenRouterRequest(
  options: BuildOpenRouterRequestOptions
): ChatCompletionRequest {
  const { model, messages, safeMaxTokens, webSearchEnabled, autoRouterAllowedModels } = options;
  const plugins: { id: string; allowed_models?: string[] }[] = [];

  if (autoRouterAllowedModels) {
    plugins.push({ id: 'auto-router', allowed_models: autoRouterAllowedModels });
  }
  if (webSearchEnabled) {
    plugins.push({ id: 'web' });
  }

  return {
    model,
    messages,
    ...(safeMaxTokens !== undefined && { max_tokens: safeMaxTokens }),
    ...(plugins.length > 0 && { plugins }),
  };
}

/**
 * Wraps an async iterable to broadcast tokens to group chat members via WebSocket.
 * Passes tokens through unchanged — broadcast is fire-and-forget side effect.
 */
export function withBroadcast(
  stream: AsyncIterable<{ content: string; generationId?: string }>,
  broadcast: BroadcastContext
): AsyncIterable<{ content: string; generationId?: string }> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]();
      let tokenBuffer = '';
      let lastBroadcastTime = Date.now();
      let done = false;

      function flushTokenBuffer(): void {
        if (tokenBuffer) {
          void broadcastToRoom(
            broadcast.env,
            broadcast.conversationId,
            createEvent('message:stream', {
              messageId: broadcast.assistantMessageId,
              token: tokenBuffer,
              ...(broadcast.modelName !== undefined && { modelName: broadcast.modelName }),
            })
          );
          tokenBuffer = '';
        }
      }

      return {
        async next() {
          const result = await iterator.next();
          if (result.done) {
            // Flush remaining buffered tokens on completion
            if (!done) flushTokenBuffer();
            done = true;
            return { done: true as const, value: undefined };
          }

          tokenBuffer += result.value.content;
          if (Date.now() - lastBroadcastTime >= BATCH_INTERVAL_MS) {
            flushTokenBuffer();
            lastBroadcastTime = Date.now();
          }

          return { done: false as const, value: result.value };
        },
      };
    },
  };
}

interface HandleBillingOptions {
  c: Context<AppEnv>;
  billingPromise: Promise<SaveChatTurnResult>;
  assistantMessageId: string;
  userId: string;
  model: string;
  generationId: string | undefined;
}

export async function handleBillingResult(
  options: HandleBillingOptions
): Promise<SaveChatTurnResult | null> {
  const { c, billingPromise, assistantMessageId, userId, model, generationId } = options;

  // Ensure billing completes even if client disconnects (Workers only)
  try {
    // eslint-disable-next-line promise/prefer-await-to-then -- waitUntil requires a non-awaited promise; catch prevents unhandled rejection
    c.executionCtx.waitUntil(billingPromise.catch(() => null));
  } catch {
    // executionCtx unavailable outside Cloudflare Workers runtime
  }

  try {
    return await billingPromise;
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
    return null;
  }
}

interface BroadcastAndFinishOptions {
  c: Context<AppEnv>;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  billingResult: SaveChatTurnResult;
  writer: SSEEventWriter;
  modelName?: string;
}

export async function broadcastAndFinish(options: BroadcastAndFinishOptions): Promise<void> {
  const { c, conversationId, userMessageId, assistantMessageId, billingResult, writer, modelName } =
    options;

  const broadcastPromise = broadcastToRoom(
    c.env,
    conversationId,
    createEvent('message:complete', {
      messageId: assistantMessageId,
      conversationId,
      sequenceNumber: billingResult.aiSequence,
      epochNumber: billingResult.epochNumber,
      ...(modelName !== undefined && { modelName }),
    })
  );

  // Best-effort: don't fail the SSE response if broadcast fails
  try {
    // eslint-disable-next-line promise/prefer-await-to-then -- waitUntil requires a non-awaited promise; catch prevents unhandled rejection
    c.executionCtx.waitUntil(broadcastPromise.catch(() => null));
  } catch {
    // executionCtx unavailable outside Workers runtime
  }

  await writer.writeDone({
    userMessageId,
    assistantMessageId,
    userSequence: billingResult.userSequence,
    aiSequence: billingResult.aiSequence,
    epochNumber: billingResult.epochNumber,
    cost: billingResult.cost,
  });
}

// ============================================================================
// resolveAndReserveBilling
// ============================================================================

export interface ResolveAndReserveBillingInput {
  billingResult: BuildBillingResult;
  userId: string;
  models: string[];
  messagesForInference: MessageForInference[];
  clientFundingSource: FundingSource;
  memberContext?: MemberContext;
  conversationId?: string;
  webSearchEnabled: boolean;
  customInstructions?: string;
}

/**
 * Resolve billing decision, compute budget, and reserve balance.
 *
 * Takes a pre-built `BuildBillingResult` (from either `buildBillingInput` or
 * `buildGuestBillingInput`) and does everything that `validateBilling` did
 * after the billing input was gathered.
 */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- billing validation has inherent branching (denial, mismatch, budget computation, reservation)
export async function resolveAndReserveBilling(
  c: Context<AppEnv>,
  input: ResolveAndReserveBillingInput
): Promise<BillingValidationSuccess | BillingValidationFailure> {
  const {
    billingResult,
    userId,
    models,
    messagesForInference,
    clientFundingSource,
    memberContext,
    conversationId,
  } = input;
  const redis = c.get('redis');

  // 1. Fetch models for pricing (in-memory cached with TTL)
  const openrouterModels = await fetchModels();
  const allPricing = models.map((m) => lookupModelPricing(openrouterModels, m));

  // 1b. Resolve web search cost — sum across all models that support it
  let webSearchCostDollars = 0;
  if (input.webSearchEnabled) {
    for (const m of models) {
      const info = openrouterModels.find((om) => om.id === m);
      if (info?.pricing.web_search) {
        webSearchCostDollars += parseTokenPrice(info.pricing.web_search);
      }
    }
  }

  // 2. Character count for budget computation
  const systemPromptForBudget = buildSystemPrompt([], input.customInstructions);
  const historyCharacters = messagesForInference.reduce((sum, m) => sum + m.content.length, 0);
  const promptCharacterCount = systemPromptForBudget.length + historyCharacters;

  // 3. Auto-router: build allowed models and override pricing with worst-case
  //    Only applies when exactly 1 model is selected and it's the auto-router
  const actualTier = billingResult.input.tier;
  let autoRouterAllowedModels: string[] | undefined;
  if (models.length === 1 && models[0] === AUTO_ROUTER_MODEL_ID) {
    const zdrModelIds = await fetchZdrModelIds();
    const { models: poolModels, premiumIds } = processModels(openrouterModels, zdrModelIds);
    const premiumSet = new Set(premiumIds);
    const canAccessPremium = actualTier === 'paid';

    const allowed: { id: string; inputPrice: number; outputPrice: number }[] = [];

    for (const pm of poolModels) {
      if (pm.isAutoRouter) continue;
      const isPremium = premiumSet.has(pm.id);
      if (isPremium && !canAccessPremium) continue;

      const mInputPrice = applyFees(pm.pricePerInputToken);
      const mOutputPrice = applyFees(pm.pricePerOutputToken);

      const affordResult = canAffordModel({
        tier: actualTier,
        balanceCents: billingResult.input.balanceCents,
        freeAllowanceCents: billingResult.input.freeAllowanceCents,
        promptCharacterCount,
        modelInputPricePerToken: mInputPrice,
        modelOutputPricePerToken: mOutputPrice,
        isPremium,
      });

      if (affordResult.affordable) {
        allowed.push({ id: pm.id, inputPrice: mInputPrice, outputPrice: mOutputPrice });
      }
    }

    if (allowed.length === 0) {
      return {
        success: false,
        response: c.json(
          createErrorResponse(ERROR_CODE_INSUFFICIENT_BALANCE, {
            currentBalance: (billingResult.input.balanceCents / 100).toFixed(2),
          }),
          402
        ),
      };
    }

    // Override pricing with worst-case (most expensive allowed model)
    const existingPricing = allPricing[0];
    if (!existingPricing) throw new Error('invariant: allPricing must have at least one entry');
    allPricing[0] = {
      inputPricePerToken: Math.max(...allowed.map((m) => m.inputPrice)),
      outputPricePerToken: Math.max(...allowed.map((m) => m.outputPrice)),
      contextLength: existingPricing.contextLength,
    };
    autoRouterAllowedModels = allowed.map((m) => m.id);
  }

  // 4. Compute estimated minimum cost via CostManifest (single source of truth)
  const minCostManifest = buildCostManifest({
    tier: actualTier,
    promptCharacterCount,
    models: allPricing.map((p) => ({
      modelInputPricePerToken: p.inputPricePerToken,
      modelOutputPricePerToken: p.outputPricePerToken,
    })),
    webSearchCost: webSearchCostDollars,
  });
  const estimatedMinimumCostCents =
    calculateBudgetFromManifest(minCostManifest, 0).estimatedMinimumCost * 100;

  billingResult.input.estimatedMinimumCostCents = estimatedMinimumCostCents;
  const billingDecision = resolveBilling(billingResult.input);

  // 5. Handle denial — return 402 before checking mismatch
  if (billingDecision.fundingSource === 'denied') {
    return {
      success: false,
      response: handleBillingDenial(c, billingDecision.reason, billingResult.input),
    };
  }

  // 6. Handle mismatch — 409 when client and server disagree on funding source
  if (clientFundingSource !== billingDecision.fundingSource) {
    return {
      success: false,
      response: c.json(
        createErrorResponse(ERROR_CODE_BILLING_MISMATCH, {
          serverFundingSource: billingDecision.fundingSource,
        }),
        409
      ),
    };
  }

  // 7. Compute budget for maxOutputTokens based on payer
  const isGroupBilling =
    billingDecision.fundingSource === 'owner_balance' && billingResult.input.group !== undefined;
  const group = billingResult.input.group;
  const payerTier = isGroupBilling && group ? group.ownerTier : billingResult.input.tier;
  const payerBalanceCents =
    isGroupBilling && group ? group.ownerBalanceCents : billingResult.input.balanceCents;
  const payerFreeAllowanceCents = isGroupBilling ? 0 : billingResult.input.freeAllowanceCents;

  const budgetResult = calculateBudget({
    tier: payerTier,
    balanceCents: payerBalanceCents,
    freeAllowanceCents: payerFreeAllowanceCents,
    promptCharacterCount,
    models: allPricing.map((p) => ({
      modelInputPricePerToken: p.inputPricePerToken,
      modelOutputPricePerToken: p.outputPricePerToken,
      contextLength: p.contextLength,
    })),
    webSearchCost: webSearchCostDollars,
  });

  const minContextLength = Math.min(...allPricing.map((p) => p.contextLength));
  const safeMaxTokens = computeSafeMaxTokens({
    budgetMaxTokens: budgetResult.maxOutputTokens,
    modelContextLength: minContextLength,
    estimatedInputTokens: budgetResult.estimatedInputTokens,
  });

  // 8. Calculate worst case cost for reservation (derived from budget — single source of truth)
  const effectiveMaxOutputTokens =
    safeMaxTokens ?? minContextLength - budgetResult.estimatedInputTokens;
  const worstCaseCents = computeWorstCaseCents(
    budgetResult.estimatedInputCost,
    effectiveMaxOutputTokens,
    budgetResult.outputCostPerToken
  );

  // 9. Reserve budget
  if (isGroupBilling && memberContext && conversationId) {
    const groupReservation: GroupBudgetReservation = {
      conversationId,
      memberId: memberContext.memberId,
      payerId: memberContext.ownerId,
      costCents: worstCaseCents,
    };
    const reservedTotals = await reserveGroupBudget(redis, groupReservation);

    // Post-reservation race guard: re-check effective after reservation
    const ctx = billingResult.groupBudgetContext;
    if (!ctx) throw new Error('invariant: groupBudgetContext required for group billing');
    const postReservationEffective = effectiveBudgetCents({
      conversationRemainingCents:
        Number.parseFloat(ctx.conversationBudget) * 100 -
        Number.parseFloat(ctx.conversationSpent) * 100 -
        reservedTotals.conversationTotal,
      memberRemainingCents:
        Number.parseFloat(ctx.memberBudget) * 100 -
        Number.parseFloat(ctx.memberSpent) * 100 -
        reservedTotals.memberTotal,
      ownerRemainingCents: ctx.ownerBalanceCents - reservedTotals.payerTotal,
    });

    const cushionCents = getCushionCents(payerTier);
    if (postReservationEffective < -cushionCents) {
      await releaseGroupBudget(redis, groupReservation);
      return {
        success: false,
        response: c.json(createErrorResponse(ERROR_CODE_BALANCE_RESERVED), 402),
      };
    }

    return {
      success: true,
      billingInput: billingResult.input,
      budgetResult,
      safeMaxTokens,
      openrouterModels,
      worstCaseCents,
      groupBudget: groupReservation,
      billingUserId: memberContext.ownerId,
      ...(autoRouterAllowedModels !== undefined && { autoRouterAllowedModels }),
    };
  }

  // Personal budget reservation with race guard
  // Free tier uses rawFreeAllowanceCents (DB value, not reservation-adjusted) — the race guard
  // compares total reservations against raw balance to catch TOCTOU races
  const newTotalReserved = await reserveBudget(redis, userId, worstCaseCents);
  const availableCents =
    billingDecision.fundingSource === 'free_allowance'
      ? billingResult.rawFreeAllowanceCents
      : billingResult.rawUserBalanceCents;
  const finalEffective = availableCents - newTotalReserved;
  const cushionCents = getCushionCents(payerTier);
  if (finalEffective < -cushionCents) {
    await releaseBudget(redis, userId, worstCaseCents);
    return {
      success: false,
      response: c.json(createErrorResponse(ERROR_CODE_BALANCE_RESERVED), 402),
    };
  }

  return {
    success: true,
    billingInput: billingResult.input,
    budgetResult,
    safeMaxTokens,
    openrouterModels,
    worstCaseCents,
    billingUserId: userId,
    ...(autoRouterAllowedModels !== undefined && { autoRouterAllowedModels }),
  };
}

// ============================================================================
// executeStreamPipeline
// ============================================================================

export interface StreamPipelineInput {
  c: Context<AppEnv>;
  conversationId: string;
  models: string[];
  userMessage: { id: string; content: string };
  messagesForInference: MessageForInference[];
  billingValidation: BillingValidationSuccess;
  memberContext?: MemberContext;
  webSearchEnabled: boolean;
  customInstructions?: string;
  releaseReservation: () => Promise<void>;
  senderId: string;
  forkId?: string;
  parentMessageId: string | null;
}

/** Writes the first stream error to the SSE writer when all models fail. */
async function writeFirstStreamError(
  multiResults: Map<string, StreamResult>,
  writer: SSEEventWriter
): Promise<void> {
  const firstError = [...multiResults.values()].find((r) => r.error !== null)?.error;
  if (firstError) {
    const code =
      firstError instanceof ContextCapacityError
        ? ERROR_CODE_CONTEXT_LENGTH_EXCEEDED
        : ERROR_CODE_STREAM_ERROR;
    await writer.writeError({ message: firstError.message, code });
  } else {
    await writer.writeError({
      message: 'No content generated',
      code: ERROR_CODE_STREAM_ERROR,
    });
  }
}

interface BuildAssistantMessagesOptions {
  successfulModels: [string, StreamResult][];
  getAssistantId: (modelId: string) => string;
  openrouterModels: Awaited<ReturnType<typeof fetchModels>>;
  openrouter: {
    chatCompletionStreamWithMetadata: unknown;
    isMock: boolean;
    getGenerationStats: (generationId: string) => Promise<{ total_cost: number }>;
  };
  lastInferenceMessage: { content: string } | undefined;
  webSearchEnabled: boolean;
}

/** Builds the assistant message array from successful model results for persistence. */
async function buildAssistantMessages(options: BuildAssistantMessagesOptions): Promise<
  {
    id: string;
    content: string;
    model: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
  }[]
> {
  const {
    successfulModels,
    getAssistantId,
    openrouterModels,
    openrouter,
    lastInferenceMessage,
    webSearchEnabled,
  } = options;
  return Promise.all(
    successfulModels.map(async ([modelId, result]) => {
      const assistantMessageId = getAssistantId(modelId);
      const modelInfo = openrouterModels.find((m) => m.id === modelId);
      const totalCost = await calculateMessageCost({
        openrouter: {
          isMock: openrouter.isMock,
          getGenerationStats: openrouter.getGenerationStats,
        },
        modelInfo,
        generationId: result.generationId,
        inputContent: lastInferenceMessage?.content ?? '',
        outputContent: result.fullContent,
        webSearchCost: resolveWebSearchCost(webSearchEnabled, modelId, openrouterModels),
      });

      return {
        id: assistantMessageId,
        content: result.fullContent,
        model: modelId,
        cost: totalCost,
        inputTokens: estimateTokenCount(lastInferenceMessage?.content ?? ''),
        outputTokens: estimateTokenCount(result.fullContent),
      };
    })
  );
}

/**
 * Execute the full SSE streaming pipeline: generate IDs, build prompt,
 * broadcast user message, stream AI responses, calculate costs, persist,
 * broadcast completion, and release reservation.
 */

export function executeStreamPipeline(input: StreamPipelineInput): Response {
  const {
    c,
    conversationId,
    models,
    userMessage,
    messagesForInference,
    billingValidation,
    memberContext,
    webSearchEnabled,
    customInstructions,
    releaseReservation,
    senderId,
    forkId,
    parentMessageId,
  } = input;
  const { safeMaxTokens, openrouterModels, billingUserId } = billingValidation;
  const model = models[0];
  if (!model) throw new Error('invariant: models must have at least one entry');
  const db = c.get('db');
  const openrouter = c.get('openrouter');

  // Generate one assistantMessageId per model
  const modelAssistantIds = new Map<string, string>();
  for (const m of models) {
    modelAssistantIds.set(m, crypto.randomUUID());
  }

  function getAssistantId(modelId: string): string {
    const id = modelAssistantIds.get(modelId);
    if (!id) throw new Error(`invariant: no assistantMessageId for model ${modelId}`);
    return id;
  }

  const { systemPrompt } = buildPrompt({
    modelId: model,
    supportedCapabilities: [],
    ...(customInstructions !== undefined && { customInstructions }),
  });

  const openRouterMessages = buildOpenRouterMessages(systemPrompt, messagesForInference);
  const lastInferenceMessage = messagesForInference.at(-1);

  // Early broadcast: notify other group members of user's message (fire-and-forget)
  const lastContent = lastInferenceMessage?.content ?? '';
  void broadcastToRoom(
    c.env,
    conversationId,
    createEvent('message:new', {
      messageId: userMessage.id,
      conversationId,
      senderType: 'user',
      senderId,
      content: lastContent,
    })
  );

  // Build one stream entry per model, wrapping each with broadcast for group chat
  const streamEntries: ModelStreamEntry[] = models.map((modelId) => {
    const assistantMsgId = getAssistantId(modelId);
    const openRouterRequest = buildOpenRouterRequest({
      model: modelId,
      messages: openRouterMessages,
      safeMaxTokens,
      webSearchEnabled,
      autoRouterAllowedModels: billingValidation.autoRouterAllowedModels,
    });
    const rawStream = openrouter.chatCompletionStreamWithMetadata(openRouterRequest);
    return {
      modelId,
      assistantMessageId: assistantMsgId,
      stream: withBroadcast(rawStream, {
        env: c.env,
        conversationId,
        assistantMessageId: assistantMsgId,
        modelName: modelId,
      }),
    };
  });

  return streamSSE(c, async (stream) => {
    const writer = createSSEEventWriter(stream);
    try {
      await writer.writeStart({
        userMessageId: userMessage.id,
        models: models.map((modelId) => ({
          modelId,
          assistantMessageId: getAssistantId(modelId),
        })),
      });

      const multiResults = await collectMultiModelStreams(streamEntries, writer);

      // Check if ALL models failed
      const successfulModels = [...multiResults.entries()].filter(
        ([, r]) => r.error === null && r.fullContent.length > 0
      );

      if (successfulModels.length === 0) {
        await writeFirstStreamError(multiResults, writer);
        return;
      }

      // Build assistant messages array from successful models
      const assistantMessages = await buildAssistantMessages({
        successfulModels,
        getAssistantId,
        openrouterModels,
        openrouter,
        lastInferenceMessage,
        webSearchEnabled,
      });

      const billingPromise = saveChatTurn(db, {
        userMessageId: userMessage.id,
        userContent: userMessage.content,
        conversationId,
        userId: billingUserId,
        senderId,
        assistantMessages,
        ...(memberContext !== undefined &&
          billingValidation.groupBudget !== undefined && {
            groupBillingContext: { memberId: memberContext.memberId },
          }),
        parentMessageId,
        ...(forkId !== undefined && { forkId }),
      });

      const primaryModel = model; // models[0] — already validated above
      const billingResult = await handleBillingResult({
        c,
        billingPromise,
        assistantMessageId: getAssistantId(primaryModel),
        userId: billingUserId,
        model: primaryModel,
        generationId: multiResults.get(primaryModel)?.generationId,
      });

      if (billingResult) {
        await broadcastAndFinish({
          c,
          conversationId,
          userMessageId: userMessage.id,
          assistantMessageId: getAssistantId(primaryModel),
          billingResult,
          writer,
          modelName: primaryModel,
        });

        // Broadcast completion for additional models
        for (const [modelId] of successfulModels) {
          if (modelId === primaryModel) continue;
          void broadcastToRoom(
            c.env,
            conversationId,
            createEvent('message:complete', {
              messageId: getAssistantId(modelId),
              conversationId,
              sequenceNumber: billingResult.aiSequence,
              epochNumber: billingResult.epochNumber,
              modelName: modelId,
            })
          );
        }
      } else {
        await writer.writeError({
          message: 'Failed to save message',
          code: ERROR_CODE_BILLING_ERROR,
        });
      }
    } finally {
      await releaseReservation();
    }
  });
}
