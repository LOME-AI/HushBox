/**
 * Shared streaming pipeline used by both authenticated chat and link-guest
 * endpoints. Owns billing resolution and reservation, the SSE multi-model
 * fan-out, and the utility functions for pricing, broadcasting, and cost
 * computation that those flows share.
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
  SMART_MODEL_ID,
  ERROR_CODE_INSUFFICIENT_BALANCE,
  ERROR_CODE_PREMIUM_REQUIRES_BALANCE,
  ERROR_CODE_STREAM_ERROR,
  ERROR_CODE_BILLING_ERROR,
  ERROR_CODE_CLASSIFIER_FAILED,
  parseTokenPrice,
  computeImageExactCents,
  computeVideoExactCents,
  computeAudioWorstCaseCents,
  worstCaseSearchCost,
  toBase64,
} from '@hushbox/shared';
import { processModels, type RawModel } from '@hushbox/shared/models';
import { createEvent } from '@hushbox/realtime/events';
import { buildPrompt } from '../services/prompt/builder.js';
import {
  calculateMessageCost,
  calculateMessageCostWithStages,
  recordBillingMismatchIfExceeded,
} from '../services/billing/index.js';
import { buildAIMessages, saveChatTurn } from '../services/chat/index.js';
import { computeSafeMaxTokens } from '../services/chat/max-tokens.js';
import { createEvidenceConfig } from './evidence-config.js';
import { executePreInferenceChain, resolveStagesForSlot } from './pre-inference/index.js';
import { createErrorResponse } from './error-response.js';
import { classifyStreamErrorCode } from './classify-stream-error.js';
import { createSSEEventWriter } from './stream-handler.js';
import { collectMultiModelStreams } from './multi-stream.js';
import { executeMediaPipeline as executeMediaPipelineImpl } from './media-pipeline.js';
import { getStrategy } from './modality-strategies.js';
import { broadcastFireAndForget } from './broadcast.js';
import {
  decideFundingSource,
  reserveGroupBudgetWithGuard,
  reservePersonalBudgetWithGuard,
  reserveMediaBilling,
} from './billing-reservation.js';
import { safeExecutionCtx } from './safe-execution-ctx.js';
import { buildGroupBillingContext } from './billing-types.js';
import type { Context } from 'hono';
import type { EvidenceConfig } from '@hushbox/db';
import type {
  PreInferenceBilling,
  FundingSource,
  DenialReason,
  ResolveBillingInput,
} from '@hushbox/shared';
import type {
  AIClient,
  InferenceEvent,
  InferenceStream,
  TextRequest,
  ImageRequest,
  VideoRequest,
  AudioRequest,
} from '../services/ai/index.js';
import type { BuildBillingResult, MemberContext } from '../services/billing/index.js';
import type { PreInferenceBillingPersistence } from '../services/chat/message-persistence.js';
import type {
  SaveChatTurnResult,
  PersistedEnvelope,
  AssistantResult,
} from '../services/chat/index.js';
import type {
  InsertedTextContentItem,
  InsertedMediaContentItem,
} from '../services/chat/message-helpers.js';
import type { DoneContentItem, DoneMessageEnvelope, DoneModelEntry } from './stream-handler.js';
import type { ModelStreamEntry, MediaStreamResult } from './multi-stream.js';
import type { MediaPipelineInput } from './media-pipeline.js';
import type { GroupBudgetReservation } from './speculative-balance.js';
import type { ReservationResult, ReserveAfterDecisionInput } from './billing-reservation.js';
import type {
  AudioBillingValidationSuccess,
  ImageBillingValidationSuccess,
  VideoBillingValidationSuccess,
} from './billing-types.js';
import type { AppEnv, Bindings } from '../types.js';
export { type MediaPersistPricing } from './media-pipeline.js';
export type {
  AudioBillingValidationSuccess,
  ImageBillingValidationSuccess,
  VideoBillingValidationSuccess,
} from './billing-types.js';

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
  gatewayModels: RawModel[];
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
  models: RawModel[],
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

/**
 * Pre-flight worst-case search cost in USD when web search is enabled.
 *
 * Returns `worstCaseSearchCost()` (MAX_SEARCH_TOOL_CALLS × SEARCH_COST_PER_CALL,
 * fee-inflated) so a single text request reserves enough budget to cover the
 * cap on Perplexity Search tool invocations. Post-flight billing pulls the
 * gateway's `totalCost`, which already includes search.
 *
 * Per-model `pricing.web_search` is intentionally ignored here — the cap is
 * uniform, not model-driven. Parameters are kept for call-site compatibility
 * and future per-model overrides.
 */
export function resolveWebSearchCost(
  webSearchEnabled: boolean,
  _model: string,
  _gatewayModels: RawModel[]
): number {
  if (!webSearchEnabled) return 0;
  return worstCaseSearchCost();
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
    ...(item.downloadUrl === undefined ? {} : { downloadUrl: item.downloadUrl }),
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
  const gatewayModels = await c.var.aiClient.listRawModels();
  const allPricing = models.map((m) => lookupModelPricing(gatewayModels, m));

  // 1b. Resolve web search cost — pre-flight worst case (per the search-cap
  // reservation policy). Sum the worst case across all models so multi-model
  // turns reserve enough to cover the search cap once per model. Gateway's
  // post-inference `totalCost` already includes actual search usage.
  let webSearchCostDollars = 0;
  if (input.webSearchEnabled) {
    webSearchCostDollars = worstCaseSearchCost() * models.length;
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

  // 4-5. Funding-source decision (denial → 402, mismatch → 409, otherwise
  //      resolved fundingSource + payerTier + isGroupBilling). Shared with
  //      every media reservation flavor; see billing-reservation.ts.
  const decision = decideFundingSource({
    c,
    billingResult,
    worstCaseCents: estimatedMinimumCostCents,
    clientFundingSource,
    handleBillingDenial,
  });
  if (!decision.success) return decision;
  const { fundingSource: resolvedFundingSource, isGroupBilling, payerTier } = decision;

  // 6. Resolve effective payer — determines balance, tier, and free allowance
  //    for all downstream steps (Smart Model filtering, budget, reservation).
  //    For group billing, constrain by group budget limits so the worst-case
  //    reservation doesn't exceed conversation/member budgets.
  const group = billingResult.input.group;
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

  // 9. Reserve budget — same group/personal race-guard flow as media; the
  //    only difference is the additional text-specific fields (budget,
  //    gatewayModels, smartModelResolution) layered onto the success result.
  const reservationCtx = {
    redis,
    c,
    billingResult,
    worstCaseCents,
    payerTier,
  };
  const reservation: ReservationResult =
    isGroupBilling && memberContext && conversationId
      ? await reserveGroupBudgetWithGuard(reservationCtx, memberContext, conversationId)
      : await reservePersonalBudgetWithGuard(reservationCtx, userId, resolvedFundingSource);
  if (!reservation.success) return reservation;

  return {
    success: true,
    billingInput: billingResult.input,
    budgetResult,
    safeMaxTokens,
    gatewayModels,
    worstCaseCents: reservation.worstCaseCents,
    ...(reservation.groupBudget !== undefined && { groupBudget: reservation.groupBudget }),
    billingUserId: reservation.billingUserId,
    ...(smartModelResolution !== undefined && { smartModelResolution }),
  };
}

// ============================================================================
// resolveAndReserveImageBilling
// ============================================================================

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

/**
 * Common pre-reservation checks shared by image/video/audio billing resolvers.
 * Lives in `billing-reservation.ts`; this thin alias keeps the historical
 * call sites readable while the core logic is reusable for any modality that
 * lands at the same gate.
 */
async function resolveAndReserveMediaBilling(
  c: Context<AppEnv>,
  input: ReserveAfterDecisionInput
): Promise<ReservationResult> {
  return reserveMediaBilling(c, input, handleBillingDenial);
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
  if (!base.success) return base;

  return {
    ...base,
    perImageByModel,
  };
}

// ============================================================================
// resolveAndReserveVideoBilling
// ============================================================================

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
  if (!base.success) return base;

  return {
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

/**
 * Writes the first model error to the SSE writer when every model in the
 * batch failed. Shared between the text and media pipelines: text passes
 * `classifyCode` so context-length failures get their dedicated code; media
 * leaves it as the default `ERROR_CODE_STREAM_ERROR`. The fallback message
 * differs per modality (no content / no image / no video / no audio).
 */
async function writeFirstError<T extends { error: Error | null }>(
  results: Map<string, T>,
  writer: SSEEventWriter,
  options: {
    fallbackMessage: string;
    classifyCode?: (error: Error) => string;
  }
): Promise<void> {
  const firstError = [...results.values()].find((r) => r.error !== null)?.error;
  if (firstError) {
    const code = options.classifyCode?.(firstError) ?? ERROR_CODE_STREAM_ERROR;
    await writer.writeError({ message: firstError.message, code });
    return;
  }
  await writer.writeError({
    message: options.fallbackMessage,
    code: ERROR_CODE_STREAM_ERROR,
  });
}

/** Writes the first stream error to the SSE writer when all models fail. */
async function writeFirstStreamError(
  multiResults: Map<string, StreamResult>,
  writer: SSEEventWriter
): Promise<void> {
  await writeFirstError(multiResults, writer, {
    fallbackMessage: 'No content generated',
    classifyCode: classifyStreamErrorCode,
  });
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
  /**
   * Per-slot pre-flight reservation estimate in USD. Compared against the
   * post-flight gateway-reported cost to record a `billing-mismatch` evidence
   * row when the deviation exceeds the threshold. Allocated as
   * `worstCaseDollars / models.length` from the turn-level reservation.
   */
  slotEstimateUsd: number;
  /**
   * Evidence config for the billing-mismatch comparison. `recordServiceEvidence`
   * itself gates the DB write on `isCI`, so production stays a no-op even when
   * supplied.
   */
  evidence: EvidenceConfig;
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
  /** Reservation estimate (USD) for this slot, used by the billing-mismatch comparison. */
  slotEstimateUsd: number;
  /** Evidence config so the comparison can persist a row when CI is detected. */
  evidence: EvidenceConfig;
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
    const persisted = await buildStagedPersistInput(
      input,
      meta.resolvedModelId,
      result.generationId
    );
    // Compare the slot's reservation estimate against the realized total
    // (main + stages, fees and storage included). Non-blocking; never throws.
    await recordBillingMismatchIfExceeded({
      estimateUsd: input.slotEstimateUsd,
      actualUsd: persisted.cost,
      evidence: input.evidence,
    });
    return persisted;
  }

  const totalCost = await calculateMessageCost({
    aiClient,
    generationId: result.generationId,
    inputContent,
    outputContent: result.fullContent,
  });
  await recordBillingMismatchIfExceeded({
    estimateUsd: input.slotEstimateUsd,
    actualUsd: totalCost,
    evidence: input.evidence,
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
    slotEstimateUsd,
    evidence,
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
        slotEstimateUsd,
        evidence,
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
  webSearchEnabled: boolean;
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
    const textRequest: TextRequest = getStrategy('text').buildRequest({
      modelId: meta.resolvedModelId,
      messages: args.aiMessages,
      webSearchEnabled: args.webSearchEnabled,
      ...(args.safeMaxTokens !== undefined && { maxOutputTokens: args.safeMaxTokens }),
    });
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
    webSearchEnabled,
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
        webSearchEnabled,
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
  webSearchEnabled: boolean;
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
    webSearchEnabled: args.webSearchEnabled,
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
  // Per-slot reservation estimate in USD. The turn-level reservation
  // (`worstCaseCents`) covers every slot, so dividing by the slot count gives
  // the budget the billing-mismatch comparison should test against.
  const slotEstimateUsd =
    args.models.length > 0 ? args.billingValidation.worstCaseCents / 100 / args.models.length : 0;

  const assistantMessages = await buildAssistantMessages({
    successfulModels: args.successfulModels,
    getAssistantId: args.getAssistantId,
    aiClient: args.aiClient,
    lastInferenceMessage: args.lastInferenceMessage,
    slotMetadataByModelId: args.slotMetadataByModelId,
    slotEstimateUsd,
    evidence: createEvidenceConfig(args.c),
  });

  const groupBillingContext = buildGroupBillingContext(
    args.memberContext,
    args.billingValidation.groupBudget
  );
  const billingPromise = saveChatTurn(args.db, {
    userMessageId: args.userMessage.id,
    userContent: args.userMessage.content,
    conversationId: args.conversationId,
    userId: args.billingUserId,
    senderId: args.senderId,
    assistantMessages,
    ...(groupBillingContext !== undefined && { groupBillingContext }),
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
 * Shared pipeline for image/video/audio generation. Lives in
 * `media-pipeline.ts`; this module wires the modality-agnostic dependencies
 * (writeFirstMediaError, handleBillingResult, broadcastAndFinish,
 * createAssistantIdLookup) and forwards the per-modality input through.
 */
function executeMediaPipeline(input: MediaPipelineInput): Response {
  return executeMediaPipelineImpl(input, {
    writeFirstMediaError,
    handleBillingResult,
    broadcastAndFinish,
    createAssistantIdLookup,
  });
}

/** Writes the first media error to the SSE writer when all models fail. */
async function writeFirstMediaError(
  mediaResults: Map<string, MediaStreamResult>,
  writer: SSEEventWriter,
  noContentMessage: string
): Promise<void> {
  await writeFirstError(mediaResults, writer, {
    fallbackMessage: noContentMessage,
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

  const imageStrategy = getStrategy('image');
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
    mediaType: imageStrategy.modality,
    pricingFor: (modelId, result) => imageStrategy.pricingFor(modelId, result, imageBilling),
    buildRequest: (modelId): ImageRequest =>
      imageStrategy.buildRequest({
        modelId,
        billing: imageBilling,
        extras: {
          prompt,
          ...(aspectRatio !== undefined && { aspectRatio }),
        },
      }),
    noContentErrorMessage: imageStrategy.noContentErrorMessage,
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

  const videoStrategy = getStrategy('video');
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
    mediaType: videoStrategy.modality,
    pricingFor: (modelId, result) => videoStrategy.pricingFor(modelId, result, videoBilling),
    buildRequest: (modelId): VideoRequest =>
      videoStrategy.buildRequest({
        modelId,
        billing: videoBilling,
        extras: { prompt, aspectRatio },
      }),
    noContentErrorMessage: videoStrategy.noContentErrorMessage,
  });
}

// ============================================================================
// resolveAndReserveAudioBilling
// ============================================================================

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
  if (!base.success) return base;

  return {
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

  const audioStrategy = getStrategy('audio');
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
    mediaType: audioStrategy.modality,
    pricingFor: (modelId, result) => audioStrategy.pricingFor(modelId, result, audioBilling),
    buildRequest: (modelId): AudioRequest =>
      audioStrategy.buildRequest({
        modelId,
        billing: audioBilling,
        extras: {
          prompt,
          format,
          ...(voice !== undefined && { voice }),
        },
      }),
    noContentErrorMessage: audioStrategy.noContentErrorMessage,
  });
}
