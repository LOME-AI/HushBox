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
  SMART_MODEL_ID,
  ESTIMATED_IMAGE_BYTES,
  MEDIA_DOWNLOAD_URL_TTL_SECONDS,
  ERROR_CODE_INSUFFICIENT_BALANCE,
  ERROR_CODE_BILLING_MISMATCH,
  ERROR_CODE_PREMIUM_REQUIRES_BALANCE,
  ERROR_CODE_BALANCE_RESERVED,
  ERROR_CODE_CONTEXT_LENGTH_EXCEEDED,
  ERROR_CODE_STREAM_ERROR,
  ERROR_CODE_BILLING_ERROR,
  parseTokenPrice,
  mediaStorageCost,
} from '@hushbox/shared';
import type { FundingSource, DenialReason, ResolveBillingInput, UserTier } from '@hushbox/shared';
import type { AppEnv, Bindings } from '../types.js';
import { buildPrompt } from '../services/prompt/builder.js';
import type { BuildBillingResult, MemberContext } from '../services/billing/index.js';
import { calculateMessageCost } from '../services/billing/index.js';
import { fetchModels, processModels } from '@hushbox/shared/models';
import type {
  AIClient,
  InferenceEvent,
  InferenceStream,
  TextRequest,
  ImageRequest,
} from '../services/ai/index.js';
import { eq } from 'drizzle-orm';
import { conversations } from '@hushbox/db';
import { buildAIMessages, saveChatTurn } from '../services/chat/index.js';
import type { SaveChatTurnResult } from '../services/chat/index.js';
import { computeSafeMaxTokens } from '../services/chat/max-tokens.js';
import { createErrorResponse } from './error-response.js';
import {
  createSSEEventWriter,
  type DoneContentItem,
  type DoneMessageEnvelope,
  type DoneModelEntry,
} from './stream-handler.js';
import { toBase64, calculateMediaGenerationCost } from '@hushbox/shared';
import { beginMessageEnvelope, encryptBinaryWithContentKey } from '@hushbox/crypto';
import type {
  InsertedTextContentItem,
  InsertedMediaContentItem,
} from '../services/chat/message-helpers.js';
import { fetchEpochPublicKey } from '../services/chat/message-helpers.js';
import type { PersistedEnvelope, AssistantResult } from '../services/chat/index.js';
import type { MediaAssistantMessageInput } from '../services/chat/message-persistence.js';
import type { MediaStorage } from '../services/storage/index.js';
import {
  collectMultiModelStreams,
  collectMultiMediaModelStreams,
  type ModelStreamEntry,
  type MediaModelStreamEntry,
  type MediaStreamResult,
} from './multi-stream.js';
import { broadcastFireAndForget } from './broadcast.js';
import { createEvent } from '@hushbox/realtime/events';
import {
  reserveBudget,
  releaseBudget,
  reserveGroupBudget,
  releaseGroupBudget,
  type GroupBudgetReservation,
} from './speculative-balance.js';
import type { Context } from 'hono';
import type { Redis } from '@upstash/redis';
import { safeExecutionCtx } from './safe-execution-ctx.js';

// ============================================================================
// Helpers
// ============================================================================

function createAssistantIdLookup(models: string[]): (modelId: string) => string {
  const idMap = new Map<string, string>();
  for (const m of models) {
    idMap.set(m, crypto.randomUUID());
  }
  return (modelId: string): string => {
    const id = idMap.get(modelId);
    if (!id) throw new Error(`invariant: no assistantMessageId for model ${modelId}`);
    return id;
  };
}

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
  gatewayModels: Awaited<ReturnType<typeof fetchModels>>;
  worstCaseCents: number;
  groupBudget?: GroupBudgetReservation;
  billingUserId: string;
  smartModelAllowedModels?: string[];
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
  senderId?: string;
}

export interface StreamResult {
  fullContent: string;
  /** Generation ID from the gateway's finish event — used post-hoc to fetch exact cost. */
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

/**
 * Worst-case cents for an image generation reservation.
 * Flat cost: perImage × (1 + fee) + estimated storage per model.
 */
export function computeImageWorstCaseCents(perImage: number, modelCount: number): number {
  const perModel = applyFees(perImage) + mediaStorageCost(ESTIMATED_IMAGE_BYTES);
  return perModel * modelCount * 100;
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
    case 'trial_limit_exceeded':
    case 'guest_budget_exhausted': {
      return c.json(createErrorResponse(ERROR_CODE_INSUFFICIENT_BALANCE), 402);
    }
  }
}

/** Resolve per-search cost in USD from model pricing. Returns 0 when search is disabled. */
export function resolveWebSearchCost(
  webSearchEnabled: boolean,
  model: string,
  gatewayModels: Awaited<ReturnType<typeof fetchModels>>
): number {
  if (!webSearchEnabled) return 0;
  const modelInfo = gatewayModels.find((m) => m.id === model);
  if (!modelInfo?.pricing.web_search) return 0;
  return parseTokenPrice(modelInfo.pricing.web_search);
}

/**
 * Wraps an InferenceStream to broadcast text tokens to group chat members via WebSocket.
 * Passes events through unchanged — broadcast is a fire-and-forget side effect.
 * Only text-delta events contribute to the broadcast buffer; other events pass through silently.
 */
export function withBroadcast(
  stream: InferenceStream,
  broadcast: BroadcastContext
): InferenceStream {
  return {
    [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      const iterator = stream[Symbol.asyncIterator]();
      let tokenBuffer = '';
      let lastBroadcastTime = Date.now();
      let isDone = false;

      function flushTokenBuffer(): void {
        if (tokenBuffer.length > 0) {
          broadcastFireAndForget(
            broadcast.env,
            broadcast.conversationId,
            createEvent('message:stream', {
              messageId: broadcast.assistantMessageId,
              token: tokenBuffer,
              ...(broadcast.modelName !== undefined && { modelName: broadcast.modelName }),
              ...(broadcast.senderId !== undefined && { senderId: broadcast.senderId }),
            })
          );
          tokenBuffer = '';
        }
      }

      return {
        async next(): Promise<IteratorResult<InferenceEvent>> {
          const result = await iterator.next();
          if (result.done) {
            if (!isDone) flushTokenBuffer();
            isDone = true;
            return { done: true, value: undefined };
          }

          if (result.value.kind === 'text-delta') {
            tokenBuffer += result.value.content;
            if (Date.now() - lastBroadcastTime >= BATCH_INTERVAL_MS) {
              flushTokenBuffer();
              lastBroadcastTime = Date.now();
            }
          }

          return { done: false, value: result.value };
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
  senderId: string;
  model: string;
  generationId: string | undefined;
}

export async function handleBillingResult(
  options: HandleBillingOptions
): Promise<SaveChatTurnResult | null> {
  const { c, billingPromise, assistantMessageId, userId, senderId, model, generationId } = options;

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
        senderId,
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

function serializeTextContentItem(item: InsertedTextContentItem): DoneContentItem {
  return {
    id: item.id,
    contentType: item.contentType,
    position: item.position,
    encryptedBlob: toBase64(item.encryptedBlob),
    modelName: item.modelName,
    cost: item.cost,
    isSmartModel: item.isSmartModel,
  };
}

function serializeMediaContentItem(item: InsertedMediaContentItem): DoneContentItem {
  return {
    id: item.id,
    contentType: item.contentType,
    position: item.position,
    downloadUrl: item.downloadUrl ?? null,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    width: item.width,
    height: item.height,
    durationMs: item.durationMs,
    modelName: item.modelName,
    cost: item.cost,
    isSmartModel: item.isSmartModel,
  };
}

function serializeEnvelope(envelope: PersistedEnvelope): DoneMessageEnvelope {
  if ('contentItem' in envelope) {
    return {
      wrappedContentKey: toBase64(envelope.wrappedContentKey),
      contentItems: [serializeTextContentItem(envelope.contentItem)],
    };
  }
  return {
    wrappedContentKey: toBase64(envelope.wrappedContentKey),
    contentItems: envelope.contentItems.map((item) => serializeMediaContentItem(item)),
  };
}

function serializeAssistantResult(result: AssistantResult): DoneModelEntry {
  return {
    modelId: result.model,
    assistantMessageId: result.assistantMessageId,
    aiSequence: result.aiSequence,
    cost: result.cost,
    ...serializeEnvelope(result.envelope),
  };
}

export async function broadcastAndFinish(options: BroadcastAndFinishOptions): Promise<void> {
  const { c, conversationId, userMessageId, assistantMessageId, billingResult, writer, modelName } =
    options;

  broadcastFireAndForget(
    c.env,
    conversationId,
    createEvent('message:complete', {
      messageId: assistantMessageId,
      conversationId,
      sequenceNumber: billingResult.aiSequence,
      epochNumber: billingResult.epochNumber,
      ...(modelName !== undefined && { modelName }),
    }),
    safeExecutionCtx(c)
  );

  await writer.writeDone({
    userMessageId,
    assistantMessageId,
    userSequence: billingResult.userSequence,
    aiSequence: billingResult.aiSequence,
    epochNumber: billingResult.epochNumber,
    cost: billingResult.cost,
    userEnvelope: serializeEnvelope(billingResult.userEnvelope),
    models: billingResult.assistantResults.map((r) => serializeAssistantResult(r)),
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
  const apiKey = c.env.AI_GATEWAY_API_KEY;
  if (!apiKey) throw new Error('AI_GATEWAY_API_KEY required for streaming');
  const gatewayModels = await fetchModels(apiKey);
  const allPricing = models.map((m) => lookupModelPricing(gatewayModels, m));

  // 1b. Resolve web search cost — sum across all models that support it
  let webSearchCostDollars = 0;
  if (input.webSearchEnabled) {
    for (const m of models) {
      const info = gatewayModels.find((om) => om.id === m);
      if (info?.pricing.web_search) {
        webSearchCostDollars += parseTokenPrice(info.pricing.web_search);
      }
    }
  }

  // 2. Character count for budget computation
  const systemPromptForBudget = buildSystemPrompt([], input.customInstructions);
  const historyCharacters = messagesForInference.reduce((sum, m) => sum + m.content.length, 0);
  const promptCharacterCount = systemPromptForBudget.length + historyCharacters;

  // 3. Compute estimated minimum cost via CostManifest (single source of truth)
  const minCostManifest = buildCostManifest({
    tier: billingResult.input.tier,
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

  // 4. Handle denial — return 402 before checking mismatch
  if (billingDecision.fundingSource === 'denied') {
    return {
      success: false,
      response: handleBillingDenial(c, billingDecision.reason, billingResult.input),
    };
  }

  // 5. Handle mismatch — 409 when client and server disagree on funding source
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

  // 6. Resolve effective payer — determines balance, tier, and free allowance
  //    for all downstream steps (auto-router filtering, budget, reservation).
  //    For group billing, constrain by group budget limits so the worst-case
  //    reservation doesn't exceed conversation/member budgets.
  const isGroupBilling =
    billingDecision.fundingSource === 'owner_balance' && billingResult.input.group !== undefined;
  const group = billingResult.input.group;
  const payerTier = isGroupBilling && group ? group.ownerTier : billingResult.input.tier;
  const rawPayerBalanceCents =
    isGroupBilling && group ? group.ownerBalanceCents : billingResult.input.balanceCents;
  const payerBalanceCents =
    isGroupBilling && billingResult.groupBudgetContext
      ? Math.min(
          rawPayerBalanceCents,
          Number.parseFloat(billingResult.groupBudgetContext.conversationBudget) * 100 -
            Number.parseFloat(billingResult.groupBudgetContext.conversationSpent) * 100,
          Number.parseFloat(billingResult.groupBudgetContext.memberBudget) * 100 -
            Number.parseFloat(billingResult.groupBudgetContext.memberSpent) * 100
        )
      : rawPayerBalanceCents;
  const payerFreeAllowanceCents = isGroupBilling ? 0 : billingResult.input.freeAllowanceCents;

  // 7. Smart Model: build allowed models and override pricing with worst-case.
  //    Runs after payer resolution so affordability uses the actual payer's balance.
  //    Step 11 will replace this with a classifier-based router.
  let smartModelAllowedModels: string[] | undefined;
  if (models.length === 1 && models[0] === SMART_MODEL_ID) {
    const { models: poolModels, premiumIds } = processModels(gatewayModels);
    const premiumSet = new Set(premiumIds);
    const canAccessPremium = payerTier === 'paid';

    const allowed: { id: string; inputPrice: number; outputPrice: number }[] = [];

    for (const pm of poolModels) {
      if (pm.isSmartModel) continue;
      const isPremium = premiumSet.has(pm.id);
      if (isPremium && !canAccessPremium) continue;

      const mInputPrice = applyFees(pm.pricePerInputToken);
      const mOutputPrice = applyFees(pm.pricePerOutputToken);

      const affordResult = canAffordModel({
        tier: payerTier,
        balanceCents: payerBalanceCents,
        freeAllowanceCents: payerFreeAllowanceCents,
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
            currentBalance: (payerBalanceCents / 100).toFixed(2),
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
    smartModelAllowedModels = allowed.map((m) => m.id);
  }

  // 8. Compute budget for maxOutputTokens based on payer
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
      gatewayModels,
      worstCaseCents,
      groupBudget: groupReservation,
      billingUserId: memberContext.ownerId,
      ...(smartModelAllowedModels !== undefined && { smartModelAllowedModels }),
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
    gatewayModels,
    worstCaseCents,
    billingUserId: userId,
    ...(smartModelAllowedModels !== undefined && { smartModelAllowedModels }),
  };
}

// ============================================================================
// resolveAndReserveImageBilling
// ============================================================================

export interface ImageBillingValidationSuccess {
  success: true;
  worstCaseCents: number;
  groupBudget?: GroupBudgetReservation;
  billingUserId: string;
  perImagePrice: number;
}

export interface ResolveAndReserveImageBillingInput {
  billingResult: BuildBillingResult;
  userId: string;
  models: string[];
  /** Most expensive per-image price among the selected models (pre-fee, USD). */
  perImagePrice: number;
  clientFundingSource: FundingSource;
  memberContext?: MemberContext;
  conversationId?: string;
}

interface ImageBillingReservationContext {
  redis: Redis;
  c: Context<AppEnv>;
  billingResult: BuildBillingResult;
  worstCaseCents: number;
  payerTier: UserTier;
  maxPerImage: number;
}

async function reserveImageGroupBudget(
  ctx: ImageBillingReservationContext,
  memberContext: MemberContext,
  conversationId: string
): Promise<ImageBillingValidationSuccess | BillingValidationFailure> {
  const { redis, c, billingResult, worstCaseCents, payerTier, maxPerImage } = ctx;
  const groupReservation: GroupBudgetReservation = {
    conversationId,
    memberId: memberContext.memberId,
    payerId: memberContext.ownerId,
    costCents: worstCaseCents,
  };
  const reservedTotals = await reserveGroupBudget(redis, groupReservation);
  const budgetCtx = billingResult.groupBudgetContext;
  if (!budgetCtx) throw new Error('invariant: groupBudgetContext required for group billing');
  const postReservationEffective = effectiveBudgetCents({
    conversationRemainingCents:
      Number.parseFloat(budgetCtx.conversationBudget) * 100 -
      Number.parseFloat(budgetCtx.conversationSpent) * 100 -
      reservedTotals.conversationTotal,
    memberRemainingCents:
      Number.parseFloat(budgetCtx.memberBudget) * 100 -
      Number.parseFloat(budgetCtx.memberSpent) * 100 -
      reservedTotals.memberTotal,
    ownerRemainingCents: budgetCtx.ownerBalanceCents - reservedTotals.payerTotal,
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
    worstCaseCents,
    groupBudget: groupReservation,
    billingUserId: memberContext.ownerId,
    perImagePrice: maxPerImage,
  };
}

async function reserveImagePersonalBudget(
  ctx: ImageBillingReservationContext,
  userId: string,
  fundingSource: FundingSource
): Promise<ImageBillingValidationSuccess | BillingValidationFailure> {
  const { redis, c, billingResult, worstCaseCents, payerTier, maxPerImage } = ctx;
  const newTotalReserved = await reserveBudget(redis, userId, worstCaseCents);
  const availableCents =
    fundingSource === 'free_allowance'
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
    worstCaseCents,
    billingUserId: userId,
    perImagePrice: maxPerImage,
  };
}

/**
 * Resolve billing for image generation. Flat cost — no token math.
 * Computes worst-case as N × (perImage + storage) per model, reserves budget.
 */
export async function resolveAndReserveImageBilling(
  c: Context<AppEnv>,
  input: ResolveAndReserveImageBillingInput
): Promise<ImageBillingValidationSuccess | BillingValidationFailure> {
  const {
    billingResult,
    userId,
    models,
    perImagePrice: maxPerImage,
    clientFundingSource,
    memberContext,
    conversationId,
  } = input;
  const redis = c.get('redis');

  // 1. Compute estimated minimum cost for billing denial check
  const estimatedMinimumCostCents = computeImageWorstCaseCents(maxPerImage, 1);
  billingResult.input.estimatedMinimumCostCents = estimatedMinimumCostCents;
  const billingDecision = resolveBilling(billingResult.input);

  // 2. Handle denial
  if (billingDecision.fundingSource === 'denied') {
    return {
      success: false,
      response: handleBillingDenial(c, billingDecision.reason, billingResult.input),
    };
  }

  // 3. Handle mismatch
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

  // 4. Compute worst-case cost for all selected models
  const worstCaseCents = computeImageWorstCaseCents(maxPerImage, models.length);

  // 5. Resolve payer for group billing
  const isGroupBilling =
    billingDecision.fundingSource === 'owner_balance' && billingResult.input.group !== undefined;
  const payerTier =
    isGroupBilling && billingResult.input.group
      ? billingResult.input.group.ownerTier
      : billingResult.input.tier;

  const reservationCtx: ImageBillingReservationContext = {
    redis,
    c,
    billingResult,
    worstCaseCents,
    payerTier,
    maxPerImage,
  };

  // 6. Reserve budget (group or personal)
  if (isGroupBilling && memberContext && conversationId) {
    return reserveImageGroupBudget(reservationCtx, memberContext, conversationId);
  }

  return reserveImagePersonalBudget(reservationCtx, userId, billingDecision.fundingSource);
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
    const code = firstError.message.includes('context length')
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
  aiClient: AIClient;
  lastInferenceMessage: { content: string } | undefined;
}

/** Builds the assistant message array from successful model results for persistence. */
async function buildAssistantMessages(options: BuildAssistantMessagesOptions): Promise<
  {
    modality: 'text';
    id: string;
    content: string;
    model: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
  }[]
> {
  const { successfulModels, getAssistantId, aiClient, lastInferenceMessage } = options;
  return Promise.all(
    successfulModels.map(async ([modelId, result]) => {
      const assistantMessageId = getAssistantId(modelId);
      // generationId is required to compute exact cost — fall back to 0 if missing
      // (this only happens for failed/incomplete streams that still produced content).
      const totalCost = result.generationId
        ? await calculateMessageCost({
            aiClient,
            generationId: result.generationId,
            inputContent: lastInferenceMessage?.content ?? '',
            outputContent: result.fullContent,
          })
        : 0;

      return {
        modality: 'text' as const,
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
    customInstructions,
    releaseReservation,
    senderId,
    forkId,
    parentMessageId,
  } = input;
  const { safeMaxTokens, billingUserId } = billingValidation;
  const model = models[0];
  if (!model) throw new Error('invariant: models must have at least one entry');
  const db = c.get('db');
  const aiClient = c.get('aiClient');

  const getAssistantId = createAssistantIdLookup(models);

  const { systemPrompt } = buildPrompt({
    modelId: model,
    supportedCapabilities: [],
    ...(customInstructions !== undefined && { customInstructions }),
  });

  const aiMessages = buildAIMessages(systemPrompt, messagesForInference);
  const lastInferenceMessage = messagesForInference.at(-1);

  // Early broadcast: notify other group members of user's message
  const lastContent = lastInferenceMessage?.content ?? '';
  broadcastFireAndForget(
    c.env,
    conversationId,
    createEvent('message:new', {
      messageId: userMessage.id,
      conversationId,
      senderType: 'user',
      senderId,
      content: lastContent,
    }),
    safeExecutionCtx(c)
  );

  // Build one stream entry per model via AIClient
  const streamEntries: ModelStreamEntry[] = models.map((modelId) => {
    const assistantMsgId = getAssistantId(modelId);
    const textRequest: TextRequest = {
      modality: 'text',
      model: modelId,
      messages: aiMessages,
      ...(safeMaxTokens === undefined ? {} : { maxOutputTokens: safeMaxTokens }),
    };
    const rawStream = aiClient.stream(textRequest);
    return {
      modelId,
      assistantMessageId: assistantMsgId,
      stream: withBroadcast(rawStream, {
        env: c.env,
        conversationId,
        assistantMessageId: assistantMsgId,
        modelName: modelId,
        senderId,
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
        aiClient,
        lastInferenceMessage,
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
        senderId,
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
          broadcastFireAndForget(
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

// ============================================================================
// executeImagePipeline
// ============================================================================

export interface ImagePipelineInput {
  c: Context<AppEnv>;
  conversationId: string;
  models: string[];
  userMessage: { id: string; content: string };
  prompt: string;
  imageBilling: ImageBillingValidationSuccess;
  memberContext?: MemberContext;
  releaseReservation: () => Promise<void>;
  senderId: string;
  forkId?: string;
  parentMessageId: string | null;
  aspectRatio?: string;
}

interface EncryptAndStoreImageResult {
  assistantMessage: MediaAssistantMessageInput;
  contentItemId: string;
  downloadUrl: string;
}

interface EncryptAndStoreImageInput {
  mediaStorage: MediaStorage;
  epochPublicKey: Uint8Array;
  conversationId: string;
  modelId: string;
  assistantMsgId: string;
  mediaBytes: Uint8Array;
  mimeType: string | undefined;
  width: number | undefined;
  height: number | undefined;
  perImagePrice: number;
}

/** Encrypts a single image, stores it in R2, and returns the assistant message input. */
async function encryptAndStoreImage(
  input: EncryptAndStoreImageInput
): Promise<EncryptAndStoreImageResult> {
  const {
    mediaStorage,
    epochPublicKey,
    conversationId,
    modelId,
    assistantMsgId,
    mediaBytes,
    mimeType,
    width,
    height,
    perImagePrice,
  } = input;
  const contentItemId = crypto.randomUUID();
  const storageKey = `media/${conversationId}/${assistantMsgId}/${contentItemId}.enc`;

  const { contentKey, wrappedContentKey } = beginMessageEnvelope(epochPublicKey);
  const ciphertext = encryptBinaryWithContentKey(contentKey, mediaBytes);

  await mediaStorage.put(storageKey, ciphertext, 'application/octet-stream');

  const { url: downloadUrl } = await mediaStorage.mintDownloadUrl({
    key: storageKey,
    expiresInSec: MEDIA_DOWNLOAD_URL_TTL_SECONDS,
  });

  const totalCost = calculateMediaGenerationCost({
    pricing: { kind: 'image', perImage: perImagePrice },
    sizeBytes: ciphertext.byteLength,
    imageCount: 1,
  });

  return {
    contentItemId,
    downloadUrl,
    assistantMessage: {
      modality: 'image',
      id: assistantMsgId,
      wrappedContentKey,
      contentItems: [
        {
          id: contentItemId,
          contentType: 'image',
          position: 0,
          storageKey,
          mimeType: mimeType ?? 'image/png',
          sizeBytes: ciphertext.byteLength,
          ...(width !== undefined && { width }),
          ...(height !== undefined && { height }),
          modelName: modelId,
          cost: totalCost.toFixed(8),
          isSmartModel: false,
        },
      ],
      model: modelId,
      cost: totalCost,
      mediaType: 'image',
      imageCount: 1,
    },
  };
}

/** Attaches download URLs to media content items on a billing result for SSE serialization. */
function attachDownloadUrls(
  billingResult: SaveChatTurnResult,
  downloadUrls: Map<string, string>
): void {
  for (const assistantResult of billingResult.assistantResults) {
    if (!('contentItems' in assistantResult.envelope)) continue;
    for (const item of assistantResult.envelope.contentItems) {
      const url = downloadUrls.get(item.id);
      if (url !== undefined) item.downloadUrl = url;
    }
  }
}

/** Filters media results to only those with successful bytes. */
function filterSuccessfulMediaModels(
  mediaResults: Map<string, MediaStreamResult>
): [string, MediaStreamResult][] {
  return [...mediaResults.entries()].filter(
    ([, r]) => r.error === null && r.mediaBytes !== undefined && r.mediaBytes.length > 0
  );
}

/** Writes the first media error to the SSE writer when all models fail. */
async function writeFirstMediaError(
  mediaResults: Map<string, MediaStreamResult>,
  writer: SSEEventWriter
): Promise<void> {
  const firstError = [...mediaResults.values()].find((r) => r.error !== null)?.error;
  await writer.writeError({
    message: firstError?.message ?? 'No image generated',
    code: ERROR_CODE_STREAM_ERROR,
  });
}

interface ProcessImageResultsInput {
  mediaStorage: MediaStorage;
  epochPublicKey: Uint8Array;
  conversationId: string;
  perImagePrice: number;
  getAssistantId: (modelId: string) => string;
  successfulModels: [string, MediaStreamResult][];
}

interface ProcessImageResultsOutput {
  assistantMessages: MediaAssistantMessageInput[];
  downloadUrls: Map<string, string>;
}

/** Encrypts and stores images for all successful models, returning assistant messages and download URLs. */
async function processImageResults(
  input: ProcessImageResultsInput
): Promise<ProcessImageResultsOutput> {
  const {
    mediaStorage,
    epochPublicKey,
    conversationId,
    perImagePrice,
    getAssistantId,
    successfulModels,
  } = input;

  const assistantMessages: MediaAssistantMessageInput[] = [];
  const downloadUrls = new Map<string, string>();

  for (const [modelId, result] of successfulModels) {
    if (result.mediaBytes === undefined) continue;
    const stored = await encryptAndStoreImage({
      mediaStorage,
      epochPublicKey,
      conversationId,
      modelId,
      assistantMsgId: getAssistantId(modelId),
      mediaBytes: result.mediaBytes,
      mimeType: result.mimeType,
      width: result.width,
      height: result.height,
      perImagePrice,
    });
    assistantMessages.push(stored.assistantMessage);
    downloadUrls.set(stored.contentItemId, stored.downloadUrl);
  }

  return { assistantMessages, downloadUrls };
}

/**
 * Execute the full image generation pipeline: generate images from N models in parallel,
 * encrypt, store in R2, compute costs, persist, and emit SSE done events.
 */
export function executeImagePipeline(input: ImagePipelineInput): Response {
  const {
    c,
    conversationId,
    models,
    userMessage,
    prompt,
    imageBilling,
    memberContext,
    releaseReservation,
    senderId,
    forkId,
    parentMessageId,
    aspectRatio,
  } = input;
  const db = c.get('db');
  const aiClient = c.get('aiClient');
  const mediaStorage: MediaStorage = c.get('mediaStorage');

  const getAssistantId = createAssistantIdLookup(models);

  const primaryModel = models[0];
  if (!primaryModel) throw new Error('invariant: models must have at least one entry');

  // Early broadcast
  broadcastFireAndForget(
    c.env,
    conversationId,
    createEvent('message:new', {
      messageId: userMessage.id,
      conversationId,
      senderType: 'user',
      senderId,
      content: prompt,
    }),
    safeExecutionCtx(c)
  );

  // Build one image stream entry per model
  const streamEntries: MediaModelStreamEntry[] = models.map((modelId) => {
    const imageRequest: ImageRequest = {
      modality: 'image',
      model: modelId,
      prompt,
      ...(aspectRatio !== undefined && { aspectRatio }),
    };
    return {
      modelId,
      assistantMessageId: getAssistantId(modelId),
      stream: aiClient.stream(imageRequest),
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

      const mediaResults = await collectMultiMediaModelStreams(streamEntries, writer);

      const successfulModels = filterSuccessfulMediaModels(mediaResults);

      if (successfulModels.length === 0) {
        await writeFirstMediaError(mediaResults, writer);
        return;
      }

      // Fetch epoch key for envelope creation
      const [conv] = await db
        .select({ currentEpoch: conversations.currentEpoch })
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      const currentEpoch = conv?.currentEpoch ?? 1;
      const { epochPublicKey } = await fetchEpochPublicKey(db, conversationId, currentEpoch);

      const { assistantMessages, downloadUrls } = await processImageResults({
        mediaStorage,
        epochPublicKey,
        conversationId,
        perImagePrice: imageBilling.perImagePrice,
        getAssistantId,
        successfulModels,
      });

      const billingPromise = saveChatTurn(db, {
        userMessageId: userMessage.id,
        userContent: userMessage.content,
        conversationId,
        userId: imageBilling.billingUserId,
        senderId,
        assistantMessages,
        ...(memberContext !== undefined &&
          imageBilling.groupBudget !== undefined && {
            groupBillingContext: { memberId: memberContext.memberId },
          }),
        parentMessageId,
        ...(forkId !== undefined && { forkId }),
      });

      const billingResult = await handleBillingResult({
        c,
        billingPromise,
        assistantMessageId: getAssistantId(primaryModel),
        userId: imageBilling.billingUserId,
        senderId,
        model: primaryModel,
        generationId: mediaResults.get(primaryModel)?.generationId,
      });

      if (billingResult) {
        attachDownloadUrls(billingResult, downloadUrls);

        await broadcastAndFinish({
          c,
          conversationId,
          userMessageId: userMessage.id,
          assistantMessageId: getAssistantId(primaryModel),
          billingResult,
          writer,
          modelName: primaryModel,
        });
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
