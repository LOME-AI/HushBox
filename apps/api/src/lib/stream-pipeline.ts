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
  buildEligibleModels,
  getModelPricing,
  buildSystemPrompt,
  estimateTokenCount,
  buildCostManifest,
  calculateBudgetFromManifest,
  effectiveBudgetCents,
  resolveBilling,
  getCushionCents,
  SMART_MODEL_ID,
  MEDIA_DOWNLOAD_URL_TTL_SECONDS,
  ERROR_CODE_INSUFFICIENT_BALANCE,
  ERROR_CODE_BILLING_MISMATCH,
  ERROR_CODE_PREMIUM_REQUIRES_BALANCE,
  ERROR_CODE_BALANCE_RESERVED,
  ERROR_CODE_CONTEXT_LENGTH_EXCEEDED,
  ERROR_CODE_STREAM_ERROR,
  ERROR_CODE_BILLING_ERROR,
  parseTokenPrice,
  computeImageExactCents,
  computeVideoExactCents,
  computeAudioWorstCaseCents,
} from '@hushbox/shared';
import type { FundingSource, DenialReason, ResolveBillingInput, UserTier } from '@hushbox/shared';
import type { AppEnv, Bindings } from '../types.js';
import { buildPrompt } from '../services/prompt/builder.js';
import type { BuildBillingResult, MemberContext } from '../services/billing/index.js';
import { calculateMessageCost, calculateMessageCostWithStages } from '../services/billing/index.js';
import { executePreInferenceChain, resolveStagesForSlot } from './pre-inference/index.js';
import type { PreInferenceBillingPersistence } from '../services/chat/message-persistence.js';
import type { PreInferenceBilling } from '@hushbox/shared';
import { ERROR_CODE_CLASSIFIER_FAILED } from '@hushbox/shared';
import { fetchModels, processModels } from '@hushbox/shared/models';
import type {
  AIClient,
  InferenceEvent,
  InferenceRequest,
  InferenceStream,
  TextRequest,
  ImageRequest,
  VideoRequest,
  AudioRequest,
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
  /**
   * Stage configuration for any Smart Model slots in the request. Present
   * when SMART_MODEL_ID was in `models` and the user could afford at least
   * one eligible model + classifier overhead. Consumed by the pipeline to
   * build the per-slot Smart Model stage before inference.
   */
  smartModelResolution?: SmartModelResolution;
}

/**
 * Pre-computed Smart Model stage configuration produced during billing
 * resolution. The pipeline uses it to construct a {@link SmartModelStage}
 * per Smart Model slot — the conversation context is filled in there since
 * messagesForInference is the same across all parallel slots.
 */
export interface SmartModelResolution {
  /** Cheapest eligible text model — used to make the classifier call. */
  classifierModelId: string;
  /** Eligible inference model ids the classifier may pick from. */
  eligibleInferenceIds: readonly string[];
  /** Worst-case cents (with fees) reserved for the classifier call itself. */
  classifierWorstCaseCents: number;
  /** Lookup for resolved model name + description (descriptions for prompt, name for SSE). */
  modelMetadataById: ReadonlyMap<string, { name: string; description: string }>;
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
  const publicModelsUrl = c.env.PUBLIC_MODELS_URL;
  if (!publicModelsUrl) throw new Error('PUBLIC_MODELS_URL required for streaming');
  const gatewayModels = await fetchModels({ apiKey, publicModelsUrl });
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
  //    for all downstream steps (Smart Model filtering, budget, reservation).
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

  // 7. Smart Model: resolve eligible models and override per-slot pricing
  //    to max-of-eligible. Runs after payer resolution so affordability uses
  //    the actual payer's balance. The classifier worst-case is added to the
  //    final reservation below; per-stage logic lives in `SmartModelStage`.
  let smartModelResolution: SmartModelResolution | undefined;
  if (models.includes(SMART_MODEL_ID)) {
    const { models: poolModels, premiumIds } = processModels(gatewayModels);
    const eligibility = buildEligibleModels({
      textModels: poolModels.filter((m) => m.modality === 'text' && !m.isSmartModel),
      premiumIds: new Set(premiumIds),
      payerTier,
      payerBalanceCents,
      payerFreeAllowanceCents,
      promptCharacterCount,
    });

    if (eligibility === null) {
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

    // Pricing override: every Smart Model slot reserves at the most expensive
    // eligible model so the budget can absorb whichever model the classifier picks.
    const eligibleSet = new Set(eligibility.eligibleInferenceIds);
    let maxInputFee = 0;
    let maxOutputFee = 0;
    for (const pm of poolModels) {
      if (!eligibleSet.has(pm.id)) continue;
      const inputFee = applyFees(pm.pricePerInputToken);
      const outputFee = applyFees(pm.pricePerOutputToken);
      if (inputFee > maxInputFee) maxInputFee = inputFee;
      if (outputFee > maxOutputFee) maxOutputFee = outputFee;
    }

    for (const [index, modelId] of models.entries()) {
      if (modelId !== SMART_MODEL_ID) continue;
      const existing = allPricing[index];
      if (!existing) throw new Error(`invariant: allPricing missing entry ${String(index)}`);
      allPricing[index] = {
        inputPricePerToken: maxInputFee,
        outputPricePerToken: maxOutputFee,
        contextLength: existing.contextLength,
      };
    }

    // Build metadata lookup for the eligible models — used by the SmartModelStage
    // when constructing the classifier prompt and reporting the resolved name.
    const metadata = new Map<string, { name: string; description: string }>();
    for (const id of eligibility.eligibleInferenceIds) {
      const raw = gatewayModels.find((m) => m.id === id);
      if (!raw) continue;
      metadata.set(id, {
        name: raw.name,
        description: raw.description,
      });
    }

    smartModelResolution = {
      classifierModelId: eligibility.classifierModelId,
      eligibleInferenceIds: eligibility.eligibleInferenceIds,
      classifierWorstCaseCents: eligibility.classifierWorstCaseCents,
      modelMetadataById: metadata,
    };
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

  // 8. Calculate worst case cost for reservation (derived from budget — single source of truth).
  //    Add per-stage worst-case cents to cover any pre-inference stages
  //    (Smart Model classifier, future prompt enhancers, etc.) that haven't
  //    run yet but will be billed as separate usage_records.
  const effectiveMaxOutputTokens =
    safeMaxTokens ?? minContextLength - budgetResult.estimatedInputTokens;
  const inferenceWorstCaseCents = computeWorstCaseCents(
    budgetResult.estimatedInputCost,
    effectiveMaxOutputTokens,
    budgetResult.outputCostPerToken
  );
  const stageReservationCents = smartModelResolution?.classifierWorstCaseCents ?? 0;
  const worstCaseCents = inferenceWorstCaseCents + stageReservationCents;

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
      ...(smartModelResolution !== undefined && { smartModelResolution }),
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
    ...(smartModelResolution !== undefined && { smartModelResolution }),
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
  /**
   * Per-image price for each selected model, keyed by model ID. The pipeline
   * uses this map to bill each model at its own price (not the max) after
   * generation completes.
   */
  perImageByModel: Map<string, number>;
}

export interface ResolveAndReserveImageBillingInput {
  billingResult: BuildBillingResult;
  userId: string;
  models: string[];
  /** Actual per-image price for each selected model (pre-fee, USD). */
  perImageByModel: Map<string, number>;
  clientFundingSource: FundingSource;
  memberContext?: MemberContext;
  conversationId?: string;
}

interface MediaBillingReservationContext {
  redis: Redis;
  c: Context<AppEnv>;
  billingResult: BuildBillingResult;
  worstCaseCents: number;
  payerTier: UserTier;
}

/** Shared reservation result used by every media-modality billing resolver. */
interface MediaReservationBase {
  worstCaseCents: number;
  groupBudget?: GroupBudgetReservation;
  billingUserId: string;
}

async function reserveMediaGroupBudget(
  ctx: MediaBillingReservationContext,
  memberContext: MemberContext,
  conversationId: string
): Promise<MediaReservationBase | BillingValidationFailure> {
  const { redis, c, billingResult, worstCaseCents, payerTier } = ctx;
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
    worstCaseCents,
    groupBudget: groupReservation,
    billingUserId: memberContext.ownerId,
  };
}

async function reserveMediaPersonalBudget(
  ctx: MediaBillingReservationContext,
  userId: string,
  fundingSource: FundingSource
): Promise<MediaReservationBase | BillingValidationFailure> {
  const { redis, c, billingResult, worstCaseCents, payerTier } = ctx;
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
    worstCaseCents,
    billingUserId: userId,
  };
}

/**
 * Common pre-reservation checks shared by image/video/audio billing resolvers.
 * Returns a validated reservation OR a failure response, letting each
 * modality-specific caller append its own result shape.
 */
async function resolveAndReserveMediaBilling(
  c: Context<AppEnv>,
  input: {
    billingResult: BuildBillingResult;
    userId: string;
    worstCaseCents: number;
    clientFundingSource: FundingSource;
    memberContext?: MemberContext;
    conversationId?: string;
  }
): Promise<MediaReservationBase | BillingValidationFailure> {
  const {
    billingResult,
    userId,
    worstCaseCents,
    clientFundingSource,
    memberContext,
    conversationId,
  } = input;
  const redis = c.get('redis');

  billingResult.input.estimatedMinimumCostCents = worstCaseCents;
  const billingDecision = resolveBilling(billingResult.input);

  if (billingDecision.fundingSource === 'denied') {
    return {
      success: false,
      response: handleBillingDenial(c, billingDecision.reason, billingResult.input),
    };
  }

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

  const isGroupBilling =
    billingDecision.fundingSource === 'owner_balance' && billingResult.input.group !== undefined;
  const payerTier =
    isGroupBilling && billingResult.input.group
      ? billingResult.input.group.ownerTier
      : billingResult.input.tier;

  const reservationCtx: MediaBillingReservationContext = {
    redis,
    c,
    billingResult,
    worstCaseCents,
    payerTier,
  };

  if (isGroupBilling && memberContext && conversationId) {
    return reserveMediaGroupBudget(reservationCtx, memberContext, conversationId);
  }
  return reserveMediaPersonalBudget(reservationCtx, userId, billingDecision.fundingSource);
}

/**
 * Resolve billing for image generation. Flat cost — no token math.
 * Reserves the exact sum of per-model prices plus per-model storage; the
 * pipeline bills each model at its own price after generation.
 */
export async function resolveAndReserveImageBilling(
  c: Context<AppEnv>,
  input: ResolveAndReserveImageBillingInput
): Promise<ImageBillingValidationSuccess | BillingValidationFailure> {
  const {
    billingResult,
    userId,
    perImageByModel,
    clientFundingSource,
    memberContext,
    conversationId,
  } = input;

  const exactCents = computeImageExactCents([...perImageByModel.values()]);

  const base = await resolveAndReserveMediaBilling(c, {
    billingResult,
    userId,
    worstCaseCents: exactCents,
    clientFundingSource,
    ...(memberContext !== undefined && { memberContext }),
    ...(conversationId !== undefined && { conversationId }),
  });
  if ('success' in base) return base;

  return {
    success: true,
    ...base,
    perImageByModel,
  };
}

// ============================================================================
// resolveAndReserveVideoBilling
// ============================================================================

export interface VideoBillingValidationSuccess {
  success: true;
  worstCaseCents: number;
  groupBudget?: GroupBudgetReservation;
  billingUserId: string;
  /**
   * Per-second price at the chosen resolution for each selected video model,
   * keyed by model ID. The pipeline uses this map for per-model billing.
   */
  perSecondByModel: Map<string, number>;
  durationSeconds: number;
  resolution: string;
}

export interface ResolveAndReserveVideoBillingInput {
  billingResult: BuildBillingResult;
  userId: string;
  models: string[];
  /** Actual per-second price at the chosen resolution for each selected video model. */
  perSecondByModel: Map<string, number>;
  durationSeconds: number;
  resolution: string;
  clientFundingSource: FundingSource;
  memberContext?: MemberContext;
  conversationId?: string;
}

/**
 * Resolve billing for video generation. Flat cost — no token math.
 * Computes worst-case as N × (perSecond × duration + storage) per model, reserves budget.
 */
export async function resolveAndReserveVideoBilling(
  c: Context<AppEnv>,
  input: ResolveAndReserveVideoBillingInput
): Promise<VideoBillingValidationSuccess | BillingValidationFailure> {
  const {
    billingResult,
    userId,
    perSecondByModel,
    durationSeconds,
    resolution,
    clientFundingSource,
    memberContext,
    conversationId,
  } = input;

  const exactCents = computeVideoExactCents([...perSecondByModel.values()], durationSeconds);

  const base = await resolveAndReserveMediaBilling(c, {
    billingResult,
    userId,
    worstCaseCents: exactCents,
    clientFundingSource,
    ...(memberContext !== undefined && { memberContext }),
    ...(conversationId !== undefined && { conversationId }),
  });
  if ('success' in base) return base;

  return {
    success: true,
    ...base,
    perSecondByModel,
    durationSeconds,
    resolution,
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

/**
 * Extract the most recent user message and assistant message from the
 * inference history, for the Smart Model classifier's truncation algorithm.
 * Both are plain strings — empty when no message of that role exists.
 *
 * Pure helper; lives next to the pipeline that consumes it. Future stages
 * that need conversation context can reuse this.
 */
function findLatestByRole(
  messages: readonly MessageForInference[],
  role: MessageForInference['role']
): string {
  return messages.findLast((m) => m.role === role)?.content ?? '';
}

function extractConversationContextForClassifier(
  messagesForInference: readonly MessageForInference[]
): { latestUserMessage: string; latestAssistantMessage: string } {
  return {
    latestUserMessage: findLatestByRole(messagesForInference, 'user'),
    latestAssistantMessage: findLatestByRole(messagesForInference, 'assistant'),
  };
}

interface BuildAssistantMessagesOptions {
  successfulModels: [string, StreamResult][];
  getAssistantId: (modelId: string) => string;
  aiClient: AIClient;
  lastInferenceMessage: { content: string } | undefined;
  /**
   * Per-slot metadata produced by pre-inference. Keyed by the slot's user-facing
   * modelId (the same key used for SSE events). Slots without metadata behave
   * as before — no stages, no Smart Model badge, model id is the selection.
   */
  slotMetadataByModelId: ReadonlyMap<string, SlotPreInferenceMetadata>;
}

interface AssistantPersistInput {
  modality: 'text';
  id: string;
  content: string;
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  isSmartModel?: boolean;
  preInferenceBillings?: PreInferenceBillingPersistence[];
}

interface SlotAssistantInput {
  assistantMessageId: string;
  result: StreamResult;
  /** Always present — buildAssistantMessages synthesises a no-stage default for slots without pre-inference. */
  meta: SlotPreInferenceMetadata;
  inputContent: string;
  aiClient: AIClient;
}

function baseAssistantPersist(input: {
  assistantMessageId: string;
  fullContent: string;
  persistedModelId: string;
  cost: number;
  inputContent: string;
  isSmartModel: boolean;
}): AssistantPersistInput {
  return {
    modality: 'text' as const,
    id: input.assistantMessageId,
    content: input.fullContent,
    model: input.persistedModelId,
    cost: input.cost,
    inputTokens: estimateTokenCount(input.inputContent),
    outputTokens: estimateTokenCount(input.fullContent),
    ...(input.isSmartModel && { isSmartModel: true }),
  };
}

/**
 * Slot ran pre-inference stages (Smart Model classifier today). Cost
 * calculator returns the total + per-stage breakdown; persistence writes
 * the main usage_records row plus one row per stage.
 */
async function buildStagedPersistInput(
  input: SlotAssistantInput,
  modelId: string,
  generationId: string
): Promise<AssistantPersistInput> {
  const { assistantMessageId, result, meta, inputContent, aiClient } = input;
  const costResult = await calculateMessageCostWithStages({
    aiClient,
    mainGenerationId: generationId,
    stageBillings: meta.preInferenceBillings,
    inputContent,
    outputContent: result.fullContent,
  });
  const stagePersistence: PreInferenceBillingPersistence[] = costResult.stageBreakdown.map((b) => ({
    stageId: b.billing.stageId,
    modelId: b.billing.modelId,
    costDollars: b.costDollars,
    inputTokens: estimateTokenCount(b.billing.inputContent),
    outputTokens: estimateTokenCount(b.billing.outputContent),
  }));
  return {
    ...baseAssistantPersist({
      assistantMessageId,
      fullContent: result.fullContent,
      persistedModelId: modelId,
      cost: costResult.mainCostDollars,
      inputContent,
      isSmartModel: true,
    }),
    preInferenceBillings: stagePersistence,
  };
}

async function buildSlotPersistInput(input: SlotAssistantInput): Promise<AssistantPersistInput> {
  const { assistantMessageId, result, meta, inputContent, aiClient } = input;

  // generationId is required to compute exact cost — fall back to 0 if missing
  // (only happens for failed/incomplete streams that still produced content).
  if (!result.generationId) {
    return baseAssistantPersist({
      assistantMessageId,
      fullContent: result.fullContent,
      persistedModelId: meta.resolvedModelId,
      cost: 0,
      inputContent,
      isSmartModel: meta.isSmartModel,
    });
  }

  if (meta.preInferenceBillings.length > 0) {
    return buildStagedPersistInput(input, meta.resolvedModelId, result.generationId);
  }

  const totalCost = await calculateMessageCost({
    aiClient,
    generationId: result.generationId,
    inputContent,
    outputContent: result.fullContent,
  });
  return baseAssistantPersist({
    assistantMessageId,
    fullContent: result.fullContent,
    persistedModelId: meta.resolvedModelId,
    cost: totalCost,
    inputContent,
    isSmartModel: meta.isSmartModel,
  });
}

/** Builds the assistant message array from successful model results for persistence. */
async function buildAssistantMessages(
  options: BuildAssistantMessagesOptions
): Promise<AssistantPersistInput[]> {
  const {
    successfulModels,
    getAssistantId,
    aiClient,
    lastInferenceMessage,
    slotMetadataByModelId,
  } = options;
  const inputContent = lastInferenceMessage?.content ?? '';
  return Promise.all(
    successfulModels.map(([modelId, result]) =>
      buildSlotPersistInput({
        assistantMessageId: getAssistantId(modelId),
        result,
        meta: slotMetadataByModelId.get(modelId) ?? {
          modelId,
          assistantMessageId: getAssistantId(modelId),
          resolvedModelId: modelId,
          isSmartModel: false,
          preInferenceBillings: [],
        },
        inputContent,
        aiClient,
      })
    )
  );
}

/**
 * Pre-inference outcome for a single slot, captured before stream entries are
 * built. Successful slots contribute streamEntries; failed slots are reported
 * via `writeModelError` and excluded.
 */
interface SlotPreInferenceMetadata {
  modelId: string;
  assistantMessageId: string;
  resolvedModelId: string;
  isSmartModel: boolean;
  preInferenceBillings: PreInferenceBilling[];
}

interface RunPreInferenceForSlotsArgs {
  models: readonly string[];
  getAssistantId: (modelId: string) => string;
  smartModelResolution: SmartModelResolution | undefined;
  conversationContext: { latestUserMessage: string; latestAssistantMessage: string };
  aiClient: AIClient;
  writer: SSEEventWriter;
}

/**
 * The `is_smart_model` flag must be tied to the routing stage specifically,
 * not "any stage that produces a `resolvedModelId`" — future stages (model
 * fallback, safety redirect) might also rewrite the model id without being
 * routing. Exported so the discriminator can be unit-tested directly.
 *
 * The cast to `string` widens `b.stageId` away from today's literal union so
 * the comparison reads as forward-compat against future stage types, not
 * "is the only existing stage equal to itself."
 */
export function derivedIsSmartModel(billings: readonly PreInferenceBilling[]): boolean {
  return billings.some((b) => (b.stageId as string) === 'smart-model');
}

async function runPreInferenceForSlot(
  modelId: string,
  args: RunPreInferenceForSlotsArgs
): Promise<SlotPreInferenceMetadata | null> {
  const { getAssistantId, smartModelResolution, conversationContext, aiClient, writer } = args;
  const assistantMsgId = getAssistantId(modelId);
  const stages = resolveStagesForSlot({
    modality: 'text',
    selectedModelId: modelId,
    ...(smartModelResolution !== undefined && {
      smartModelResolution: { ...smartModelResolution, conversationContext },
    }),
  });

  if (stages.length === 0) {
    return {
      modelId,
      assistantMessageId: assistantMsgId,
      resolvedModelId: modelId,
      isSmartModel: false,
      preInferenceBillings: [],
    };
  }

  const chainResult = await executePreInferenceChain({
    stages,
    aiClient,
    writer,
    assistantMessageId: assistantMsgId,
  });

  if (!chainResult.ok) {
    await writer.writeModelError({
      modelId,
      message: 'Pre-inference stage failed',
      code: chainResult.errorCode,
    });
    return null;
  }

  return {
    modelId,
    assistantMessageId: assistantMsgId,
    resolvedModelId: chainResult.transformation.resolvedModelId ?? modelId,
    isSmartModel: derivedIsSmartModel(chainResult.billings),
    preInferenceBillings: chainResult.billings,
  };
}

/**
 * Per-slot pre-inference: each slot runs its stage chain (currently only Smart
 * Model). Successful slots produce a {@link SlotPreInferenceMetadata}; failed
 * slots emit `model:error` and are excluded so sibling slots stream
 * independently.
 *
 * Sequential by design today — Smart Model is the only stage and the user can
 * select it at most once, so at most one slot has stages and parallelism would
 * add no value. Switch to `Promise.all` when multiple slots ever carry stages
 * (e.g., per-slot prompt enhancers).
 */
async function runPreInferenceForSlots(
  args: RunPreInferenceForSlotsArgs
): Promise<Map<string, SlotPreInferenceMetadata>> {
  const slotMetadataByModelId = new Map<string, SlotPreInferenceMetadata>();
  for (const modelId of args.models) {
    const meta = await runPreInferenceForSlot(modelId, args);
    if (meta !== null) slotMetadataByModelId.set(modelId, meta);
  }
  return slotMetadataByModelId;
}

interface BuildSlotStreamEntriesArgs {
  models: readonly string[];
  slotMetadataByModelId: ReadonlyMap<string, SlotPreInferenceMetadata>;
  aiMessages: ReturnType<typeof buildAIMessages>;
  safeMaxTokens: number | undefined;
  aiClient: AIClient;
  envBindings: Bindings;
  conversationId: string;
  senderId: string;
}

/**
 * Build one stream entry per slot that survived pre-inference. The SSE key
 * remains the user-facing modelId (e.g., 'smart-model'); the actual
 * `aiClient.stream` call uses the resolved model id when stages produced one.
 */
function buildSlotStreamEntries(args: BuildSlotStreamEntriesArgs): ModelStreamEntry[] {
  const entries: ModelStreamEntry[] = [];
  for (const modelId of args.models) {
    const meta = args.slotMetadataByModelId.get(modelId);
    if (!meta) continue;
    const textRequest: TextRequest = {
      modality: 'text',
      model: meta.resolvedModelId,
      messages: args.aiMessages,
      ...(args.safeMaxTokens === undefined ? {} : { maxOutputTokens: args.safeMaxTokens }),
    };
    const rawStream = args.aiClient.stream(textRequest);
    entries.push({
      modelId,
      assistantMessageId: meta.assistantMessageId,
      stream: withBroadcast(rawStream, {
        env: args.envBindings,
        conversationId: args.conversationId,
        assistantMessageId: meta.assistantMessageId,
        modelName: meta.resolvedModelId,
        senderId: args.senderId,
      }),
    });
  }
  return entries;
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
  const { safeMaxTokens, billingUserId, smartModelResolution } = billingValidation;
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
  const conversationContext = extractConversationContextForClassifier(messagesForInference);

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

  return streamSSE(c, async (stream) => {
    const writer = createSSEEventWriter(stream);
    try {
      await runStreamingTurn({
        writer,
        models,
        getAssistantId,
        smartModelResolution,
        conversationContext,
        aiMessages,
        safeMaxTokens,
        lastInferenceMessage,
        aiClient,
        db,
        c,
        userMessage,
        billingValidation,
        memberContext,
        parentMessageId,
        forkId,
        senderId,
        conversationId,
        billingUserId,
        primaryModel: model,
      });
    } finally {
      await releaseReservation();
    }
  });
}

interface RunStreamingTurnArgs {
  writer: SSEEventWriter;
  models: string[];
  getAssistantId: (modelId: string) => string;
  smartModelResolution: SmartModelResolution | undefined;
  conversationContext: { latestUserMessage: string; latestAssistantMessage: string };
  aiMessages: ReturnType<typeof buildAIMessages>;
  safeMaxTokens: number | undefined;
  lastInferenceMessage: MessageForInference | undefined;
  aiClient: AIClient;
  db: AppEnv['Variables']['db'];
  c: Context<AppEnv>;
  userMessage: { id: string; content: string };
  billingValidation: BillingValidationSuccess;
  memberContext: MemberContext | undefined;
  parentMessageId: string | null;
  forkId: string | undefined;
  senderId: string;
  conversationId: string;
  billingUserId: string;
  primaryModel: string;
}

/**
 * Drive the per-turn SSE streaming flow inside the streamSSE callback. Pulled
 * out so the outer pipeline only owns the writer lifecycle and reservation
 * release; this function owns event emission, pre-inference, multi-model
 * collection, persistence, and broadcast.
 */
async function runStreamingTurn(args: RunStreamingTurnArgs): Promise<void> {
  const { writer, models, getAssistantId, userMessage } = args;

  await writer.writeStart({
    userMessageId: userMessage.id,
    models: models.map((modelId) => ({
      modelId,
      assistantMessageId: getAssistantId(modelId),
    })),
  });

  const slotMetadataByModelId = await runPreInferenceForSlots({
    models,
    getAssistantId,
    smartModelResolution: args.smartModelResolution,
    conversationContext: args.conversationContext,
    aiClient: args.aiClient,
    writer,
  });

  const streamEntries = buildSlotStreamEntries({
    models,
    slotMetadataByModelId,
    aiMessages: args.aiMessages,
    safeMaxTokens: args.safeMaxTokens,
    aiClient: args.aiClient,
    envBindings: args.c.env,
    conversationId: args.conversationId,
    senderId: args.senderId,
  });

  if (streamEntries.length === 0) {
    await writer.writeError({
      message: 'All slots failed pre-inference',
      code: ERROR_CODE_CLASSIFIER_FAILED,
    });
    return;
  }

  const multiResults = await collectMultiModelStreams(streamEntries, writer);
  const successfulModels = [...multiResults.entries()].filter(
    ([, r]) => r.error === null && r.fullContent.length > 0
  );

  if (successfulModels.length === 0) {
    await writeFirstStreamError(multiResults, writer);
    return;
  }

  await persistAndBroadcastTurn({
    ...args,
    successfulModels,
    multiResults,
    slotMetadataByModelId,
  });
}

interface PersistAndBroadcastArgs extends RunStreamingTurnArgs {
  successfulModels: [string, StreamResult][];
  multiResults: Map<string, StreamResult>;
  slotMetadataByModelId: ReadonlyMap<string, SlotPreInferenceMetadata>;
}

async function persistAndBroadcastTurn(args: PersistAndBroadcastArgs): Promise<void> {
  const assistantMessages = await buildAssistantMessages({
    successfulModels: args.successfulModels,
    getAssistantId: args.getAssistantId,
    aiClient: args.aiClient,
    lastInferenceMessage: args.lastInferenceMessage,
    slotMetadataByModelId: args.slotMetadataByModelId,
  });

  const billingPromise = saveChatTurn(args.db, {
    userMessageId: args.userMessage.id,
    userContent: args.userMessage.content,
    conversationId: args.conversationId,
    userId: args.billingUserId,
    senderId: args.senderId,
    assistantMessages,
    ...(args.memberContext !== undefined &&
      args.billingValidation.groupBudget !== undefined && {
        groupBillingContext: { memberId: args.memberContext.memberId },
      }),
    parentMessageId: args.parentMessageId,
    ...(args.forkId !== undefined && { forkId: args.forkId }),
  });

  const billingResult = await handleBillingResult({
    c: args.c,
    billingPromise,
    assistantMessageId: args.getAssistantId(args.primaryModel),
    userId: args.billingUserId,
    senderId: args.senderId,
    model: args.primaryModel,
    generationId: args.multiResults.get(args.primaryModel)?.generationId,
  });

  if (!billingResult) {
    await args.writer.writeError({
      message: 'Failed to save message',
      code: ERROR_CODE_BILLING_ERROR,
    });
    return;
  }

  // Broadcast events use the RESOLVED model id — what `content_items.model_name`
  // stores — so other group members see the actual model that produced the
  // response, not the user-facing slot id (e.g., 'smart-model').
  const resolveBroadcastModelName = (modelId: string): string =>
    args.slotMetadataByModelId.get(modelId)?.resolvedModelId ?? modelId;

  await broadcastAndFinish({
    c: args.c,
    conversationId: args.conversationId,
    userMessageId: args.userMessage.id,
    assistantMessageId: args.getAssistantId(args.primaryModel),
    billingResult,
    writer: args.writer,
    modelName: resolveBroadcastModelName(args.primaryModel),
  });

  for (const [modelId] of args.successfulModels) {
    if (modelId === args.primaryModel) continue;
    broadcastFireAndForget(
      args.c.env,
      args.conversationId,
      createEvent('message:complete', {
        messageId: args.getAssistantId(modelId),
        conversationId: args.conversationId,
        sequenceNumber: billingResult.aiSequence,
        epochNumber: billingResult.epochNumber,
        modelName: resolveBroadcastModelName(modelId),
      })
    );
  }
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

/**
 * Per-kind pricing and output metadata for the shared media persistence helper.
 * Discriminates the fields that vary by media kind (per-image vs per-second,
 * dimensions vs duration) so one code path handles all media modalities.
 *
 * Note for audio: `durationSeconds` is derived from the actual generated
 * `durationMs`, not from the request — TTS duration is determined by the
 * synthesis. The pricing factory in the audio pipeline reads `result.durationMs`
 * via the `pricingFor` callback's second argument.
 */
export type MediaPersistPricing =
  | { kind: 'image'; perImage: number }
  | { kind: 'video'; perSecond: number; durationSeconds: number; resolution: string }
  | { kind: 'audio'; perSecond: number; durationSeconds: number };

interface EncryptAndStoreMediaResult {
  assistantMessage: MediaAssistantMessageInput;
  contentItemId: string;
  downloadUrl: string;
}

interface EncryptAndStoreMediaInput {
  mediaStorage: MediaStorage;
  epochPublicKey: Uint8Array;
  conversationId: string;
  modelId: string;
  assistantMsgId: string;
  mediaBytes: Uint8Array;
  mimeType: string | undefined;
  width: number | undefined;
  height: number | undefined;
  durationMs: number | undefined;
  pricing: MediaPersistPricing;
}

function defaultMimeType(kind: MediaPersistPricing['kind']): string {
  switch (kind) {
    case 'image': {
      return 'image/png';
    }
    case 'video': {
      return 'video/mp4';
    }
    case 'audio': {
      return 'audio/mpeg';
    }
  }
}

function computeMediaCost(pricing: MediaPersistPricing, sizeBytes: number): number {
  switch (pricing.kind) {
    case 'image': {
      return calculateMediaGenerationCost({
        pricing: { kind: 'image', perImage: pricing.perImage },
        sizeBytes,
        imageCount: 1,
      });
    }
    case 'video': {
      return calculateMediaGenerationCost({
        pricing: { kind: 'video', perSecond: pricing.perSecond },
        sizeBytes,
        durationSeconds: pricing.durationSeconds,
      });
    }
    case 'audio': {
      return calculateMediaGenerationCost({
        pricing: { kind: 'audio', perSecond: pricing.perSecond },
        sizeBytes,
        durationSeconds: pricing.durationSeconds,
      });
    }
  }
}

interface MediaStorageRef {
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
}

interface MediaDimensions {
  width: number | undefined;
  height: number | undefined;
  durationMs: number | undefined;
}

interface BuildMediaAssistantMessageInput {
  assistantMsgId: string;
  contentItemId: string;
  wrappedContentKey: Uint8Array;
  pricing: MediaPersistPricing;
  storage: MediaStorageRef;
  metadata: MediaDimensions;
  modelId: string;
  totalCost: number;
}

function buildMediaAssistantMessage(
  input: BuildMediaAssistantMessageInput
): MediaAssistantMessageInput {
  const {
    assistantMsgId,
    contentItemId,
    wrappedContentKey,
    pricing,
    storage,
    metadata,
    modelId,
    totalCost,
  } = input;
  const kind = pricing.kind;
  return {
    modality: kind,
    id: assistantMsgId,
    wrappedContentKey,
    contentItems: [
      {
        id: contentItemId,
        contentType: kind,
        position: 0,
        storageKey: storage.storageKey,
        mimeType: storage.mimeType,
        sizeBytes: storage.sizeBytes,
        ...(metadata.width !== undefined && { width: metadata.width }),
        ...(metadata.height !== undefined && { height: metadata.height }),
        ...(metadata.durationMs !== undefined && { durationMs: metadata.durationMs }),
        modelName: modelId,
        cost: totalCost.toFixed(8),
        isSmartModel: false,
      },
    ],
    model: modelId,
    cost: totalCost,
    mediaType: kind,
    ...(kind === 'image' && { imageCount: 1 }),
    ...(metadata.durationMs !== undefined && { durationMs: metadata.durationMs }),
    ...(kind === 'video' && { resolution: pricing.resolution }),
  };
}

/** Encrypts a single media item (image/video/audio), stores it in R2, and returns the assistant message input. */
async function encryptAndStoreMedia(
  input: EncryptAndStoreMediaInput
): Promise<EncryptAndStoreMediaResult> {
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
    durationMs,
    pricing,
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

  const totalCost = computeMediaCost(pricing, ciphertext.byteLength);

  return {
    contentItemId,
    downloadUrl,
    assistantMessage: buildMediaAssistantMessage({
      assistantMsgId,
      contentItemId,
      wrappedContentKey,
      pricing,
      storage: {
        storageKey,
        mimeType: mimeType ?? defaultMimeType(pricing.kind),
        sizeBytes: ciphertext.byteLength,
      },
      metadata: { width, height, durationMs },
      modelId,
      totalCost,
    }),
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
  writer: SSEEventWriter,
  noContentMessage: string
): Promise<void> {
  const firstError = [...mediaResults.values()].find((r) => r.error !== null)?.error;
  await writer.writeError({
    message: firstError?.message ?? noContentMessage,
    code: ERROR_CODE_STREAM_ERROR,
  });
}

interface ProcessMediaResultsInput {
  mediaStorage: MediaStorage;
  epochPublicKey: Uint8Array;
  conversationId: string;
  /**
   * Per-result pricing factory — called once per successful model result.
   * Receives the result so audio can derive `durationSeconds` from
   * `result.durationMs`. Image/video implementations ignore the second arg.
   */
  pricingFor: (modelId: string, result: MediaStreamResult) => MediaPersistPricing;
  getAssistantId: (modelId: string) => string;
  successfulModels: [string, MediaStreamResult][];
}

interface ProcessMediaResultsOutput {
  assistantMessages: MediaAssistantMessageInput[];
  downloadUrls: Map<string, string>;
}

/** Encrypts and stores media for all successful models, returning assistant messages and download URLs. */
async function processMediaResults(
  input: ProcessMediaResultsInput
): Promise<ProcessMediaResultsOutput> {
  const {
    mediaStorage,
    epochPublicKey,
    conversationId,
    pricingFor,
    getAssistantId,
    successfulModels,
  } = input;

  const assistantMessages: MediaAssistantMessageInput[] = [];
  const downloadUrls = new Map<string, string>();

  for (const [modelId, result] of successfulModels) {
    if (result.mediaBytes === undefined) continue;
    const stored = await encryptAndStoreMedia({
      mediaStorage,
      epochPublicKey,
      conversationId,
      modelId,
      assistantMsgId: getAssistantId(modelId),
      mediaBytes: result.mediaBytes,
      mimeType: result.mimeType,
      width: result.width,
      height: result.height,
      durationMs: result.durationMs,
      pricing: pricingFor(modelId, result),
    });
    assistantMessages.push(stored.assistantMessage);
    downloadUrls.set(stored.contentItemId, stored.downloadUrl);
  }

  return { assistantMessages, downloadUrls };
}

interface MediaPipelineInput {
  c: Context<AppEnv>;
  conversationId: string;
  models: string[];
  userMessage: { id: string; content: string };
  prompt: string;
  billingUserId: string;
  groupBudget: GroupBudgetReservation | undefined;
  memberContext: MemberContext | undefined;
  releaseReservation: () => Promise<void>;
  senderId: string;
  forkId: string | undefined;
  parentMessageId: string | null;
  pricingFor: (modelId: string, result: MediaStreamResult) => MediaPersistPricing;
  buildRequest: (modelId: string) => InferenceRequest;
  /** Message written to SSE when every model in the batch fails. */
  noContentErrorMessage: string;
}

/**
 * Shared pipeline for image/video/audio generation.
 * Fans out per-model inference, encrypts results, stores in R2, persists,
 * attaches presigned download URLs to the SSE done event.
 */
function executeMediaPipeline(input: MediaPipelineInput): Response {
  const {
    c,
    conversationId,
    models,
    userMessage,
    prompt,
    billingUserId,
    groupBudget,
    memberContext,
    releaseReservation,
    senderId,
    forkId,
    parentMessageId,
    pricingFor,
    buildRequest,
    noContentErrorMessage,
  } = input;
  const db = c.get('db');
  const aiClient = c.get('aiClient');
  const mediaStorage: MediaStorage = c.get('mediaStorage');

  const getAssistantId = createAssistantIdLookup(models);

  const primaryModel = models[0];
  if (!primaryModel) throw new Error('invariant: models must have at least one entry');

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

  const streamEntries: MediaModelStreamEntry[] = models.map((modelId) => ({
    modelId,
    assistantMessageId: getAssistantId(modelId),
    stream: aiClient.stream(buildRequest(modelId)),
  }));

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
        await writeFirstMediaError(mediaResults, writer, noContentErrorMessage);
        return;
      }

      const [conv] = await db
        .select({ currentEpoch: conversations.currentEpoch })
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      const currentEpoch = conv?.currentEpoch ?? 1;
      const { epochPublicKey } = await fetchEpochPublicKey(db, conversationId, currentEpoch);

      const { assistantMessages, downloadUrls } = await processMediaResults({
        mediaStorage,
        epochPublicKey,
        conversationId,
        pricingFor,
        getAssistantId,
        successfulModels,
      });

      const billingPromise = saveChatTurn(db, {
        userMessageId: userMessage.id,
        userContent: userMessage.content,
        conversationId,
        userId: billingUserId,
        senderId,
        assistantMessages,
        ...(memberContext !== undefined &&
          groupBudget !== undefined && {
            groupBillingContext: { memberId: memberContext.memberId },
          }),
        parentMessageId,
        ...(forkId !== undefined && { forkId }),
      });

      const billingResult = await handleBillingResult({
        c,
        billingPromise,
        assistantMessageId: getAssistantId(primaryModel),
        userId: billingUserId,
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

  return executeMediaPipeline({
    c,
    conversationId,
    models,
    userMessage,
    prompt,
    billingUserId: imageBilling.billingUserId,
    groupBudget: imageBilling.groupBudget,
    memberContext,
    releaseReservation,
    senderId,
    forkId,
    parentMessageId,
    pricingFor: (modelId: string): MediaPersistPricing => {
      const perImage = imageBilling.perImageByModel.get(modelId);
      if (perImage === undefined) {
        throw new Error(`invariant: perImageByModel missing entry for ${modelId}`);
      }
      return { kind: 'image', perImage };
    },
    buildRequest: (modelId): ImageRequest => ({
      modality: 'image',
      model: modelId,
      prompt,
      ...(aspectRatio !== undefined && { aspectRatio }),
    }),
    noContentErrorMessage: 'No image generated',
  });
}

// ============================================================================
// executeVideoPipeline
// ============================================================================

export interface VideoPipelineInput {
  c: Context<AppEnv>;
  conversationId: string;
  models: string[];
  userMessage: { id: string; content: string };
  prompt: string;
  videoBilling: VideoBillingValidationSuccess;
  memberContext?: MemberContext;
  releaseReservation: () => Promise<void>;
  senderId: string;
  forkId?: string;
  parentMessageId: string | null;
  aspectRatio: string;
}

/**
 * Execute the full video generation pipeline: generate videos from N models in parallel,
 * encrypt, store in R2, compute costs (duration × perSecond), persist, and emit SSE done events.
 */
export function executeVideoPipeline(input: VideoPipelineInput): Response {
  const {
    c,
    conversationId,
    models,
    userMessage,
    prompt,
    videoBilling,
    memberContext,
    releaseReservation,
    senderId,
    forkId,
    parentMessageId,
    aspectRatio,
  } = input;

  return executeMediaPipeline({
    c,
    conversationId,
    models,
    userMessage,
    prompt,
    billingUserId: videoBilling.billingUserId,
    groupBudget: videoBilling.groupBudget,
    memberContext,
    releaseReservation,
    senderId,
    forkId,
    parentMessageId,
    pricingFor: (modelId: string): MediaPersistPricing => {
      const perSecond = videoBilling.perSecondByModel.get(modelId);
      if (perSecond === undefined) {
        throw new Error(`invariant: perSecondByModel missing entry for ${modelId}`);
      }
      return {
        kind: 'video',
        perSecond,
        durationSeconds: videoBilling.durationSeconds,
        resolution: videoBilling.resolution,
      };
    },
    buildRequest: (modelId): VideoRequest => ({
      modality: 'video',
      model: modelId,
      prompt,
      aspectRatio,
      durationSeconds: videoBilling.durationSeconds,
      resolution: videoBilling.resolution,
    }),
    noContentErrorMessage: 'No video generated',
  });
}

// ============================================================================
// resolveAndReserveAudioBilling
// ============================================================================

export interface AudioBillingValidationSuccess {
  success: true;
  worstCaseCents: number;
  groupBudget?: GroupBudgetReservation;
  billingUserId: string;
  /** Per-second price for each selected audio model, keyed by model ID. */
  perSecondByModel: Map<string, number>;
  /** Upper bound the user picked for worst-case reservation. */
  maxDurationSeconds: number;
}

export interface ResolveAndReserveAudioBillingInput {
  billingResult: BuildBillingResult;
  userId: string;
  models: string[];
  /** Per-second USD price for each selected audio model. */
  perSecondByModel: Map<string, number>;
  /** Cap on the synthesized audio duration; reservation uses this as the upper bound. */
  maxDurationSeconds: number;
  clientFundingSource: FundingSource;
  memberContext?: MemberContext;
  conversationId?: string;
}

/**
 * Resolve billing for audio (TTS) generation.
 *
 * Audio differs from image and video in that the output duration is not
 * user-specified — it emerges from synthesizing the input text. We can't
 * compute an exact pre-flight cost, so we reserve against `maxDurationSeconds`
 * and rebill at the actual generated duration.
 */
export async function resolveAndReserveAudioBilling(
  c: Context<AppEnv>,
  input: ResolveAndReserveAudioBillingInput
): Promise<AudioBillingValidationSuccess | BillingValidationFailure> {
  const {
    billingResult,
    userId,
    perSecondByModel,
    maxDurationSeconds,
    clientFundingSource,
    memberContext,
    conversationId,
  } = input;

  const worstCaseCents = computeAudioWorstCaseCents(
    [...perSecondByModel.values()],
    maxDurationSeconds
  );

  const base = await resolveAndReserveMediaBilling(c, {
    billingResult,
    userId,
    worstCaseCents,
    clientFundingSource,
    ...(memberContext !== undefined && { memberContext }),
    ...(conversationId !== undefined && { conversationId }),
  });
  if ('success' in base) return base;

  return {
    success: true,
    ...base,
    perSecondByModel,
    maxDurationSeconds,
  };
}

// ============================================================================
// executeAudioPipeline
// ============================================================================

export interface AudioPipelineInput {
  c: Context<AppEnv>;
  conversationId: string;
  models: string[];
  userMessage: { id: string; content: string };
  prompt: string;
  audioBilling: AudioBillingValidationSuccess;
  memberContext?: MemberContext;
  releaseReservation: () => Promise<void>;
  senderId: string;
  forkId?: string;
  parentMessageId: string | null;
  format: 'mp3' | 'wav' | 'ogg';
  voice?: string;
}

/**
 * Execute the full audio (TTS) generation pipeline.
 *
 * Audio billing is post-hoc per-model: each model's actual cost is its
 * `perSecond × actualDurationMs/1000`, computed in `pricingFor` once the
 * generation completes. The pre-flight reservation (in
 * `resolveAndReserveAudioBilling`) covers worst-case via `maxDurationSeconds`.
 */
export function executeAudioPipeline(input: AudioPipelineInput): Response {
  const {
    c,
    conversationId,
    models,
    userMessage,
    prompt,
    audioBilling,
    memberContext,
    releaseReservation,
    senderId,
    forkId,
    parentMessageId,
    format,
    voice,
  } = input;

  return executeMediaPipeline({
    c,
    conversationId,
    models,
    userMessage,
    prompt,
    billingUserId: audioBilling.billingUserId,
    groupBudget: audioBilling.groupBudget,
    memberContext,
    releaseReservation,
    senderId,
    forkId,
    parentMessageId,
    pricingFor: (modelId, result): MediaPersistPricing => {
      const perSecond = audioBilling.perSecondByModel.get(modelId);
      if (perSecond === undefined) {
        throw new Error(`invariant: perSecondByModel missing entry for ${modelId}`);
      }
      // TTS duration is determined by the synthesis, not the request — read
      // from the actual stream result. Fall back to 0 if absent (which yields
      // storage-only cost; the model cost component is 0 when duration is 0).
      const durationSeconds = (result.durationMs ?? 0) / 1000;
      return { kind: 'audio', perSecond, durationSeconds };
    },
    buildRequest: (modelId): AudioRequest => ({
      modality: 'audio',
      model: modelId,
      prompt,
      format,
      ...(voice !== undefined && { voice }),
    }),
    noContentErrorMessage: 'No audio generated',
  });
}
