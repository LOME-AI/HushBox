import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { conversationForks } from '@hushbox/db';
import {
  streamChatRequestSchema,
  userOnlyMessageSchema,
  regenerateRequestSchema,
  ERROR_CODE_LAST_MESSAGE_NOT_USER,
  ERROR_CODE_REGENERATION_BLOCKED_BY_OTHER_USER,
  ERROR_CODE_FORK_NOT_FOUND,
  ERROR_CODE_STREAM_ERROR,
  ERROR_CODE_MEDIA_TRIAL_BLOCKED,
  ERROR_CODE_MODEL_NOT_FOUND,
  ERROR_CODE_MODALITY_MISMATCH,
  ERROR_CODE_MODEL_TIER_LOCKED,
  ERROR_CODE_UNSUPPORTED_RESOLUTION,
  ERROR_CODE_AUDIO_DISABLED,
  ERROR_CODE_DUPLICATE_MESSAGE,
  ERROR_CODE_FORK_TIP_CONFLICT,
  FEATURE_FLAGS,
  estimateTokenCount,
  assertNever,
} from '@hushbox/shared';
import { processModels, type RawModel } from '@hushbox/shared/models';
import { createEvent } from '@hushbox/realtime/events';
import { collectSingleSlot } from '../lib/multi-stream.js';
import {
  validateLastMessageIsFromUser,
  buildAIMessages,
  saveUserOnlyMessage,
} from '../services/chat/index.js';
import { canRegenerate } from '../services/chat/regeneration-guard.js';
import {
  saveRegeneratedResponse,
  saveEditedChatTurn,
} from '../services/chat/regeneration-persistence.js';
import { createErrorResponse } from '../lib/error-response.js';
import { createSSEEventWriter } from '../lib/stream-handler.js';
import { requirePrivilege, rateLimitByUser } from '../middleware/index.js';
import { broadcastFireAndForget } from '../lib/broadcast.js';
import {
  buildBillingInput,
  buildGuestBillingInput,
  calculateMessageCost,
} from '../services/billing/index.js';
import { buildPrompt } from '../services/prompt/builder.js';
import { getUserTierInfo } from '../services/billing/balance.js';
import { resolveParentMessageId, ForkTipConflictError } from '../services/chat/message-helpers.js';
import {
  releaseBudget,
  releaseGroupBudget,
  type GroupBudgetReservation,
} from '../lib/speculative-balance.js';
import {
  resolveAndReserveBilling,
  resolveAndReserveImageBilling,
  resolveAndReserveVideoBilling,
  resolveAndReserveAudioBilling,
  executeStreamPipeline,
  executeImagePipeline,
  executeVideoPipeline,
  executeAudioPipeline,
  resolveWebSearchCost,
  BATCH_INTERVAL_MS,
} from '../lib/stream-pipeline.js';
import { classifyStreamErrorCode } from '../lib/classify-stream-error.js';
import { getStrategy } from '../lib/modality-strategies.js';
import { buildGroupBillingContext } from '../lib/billing-types.js';
import { getPushClient, sendPushForNewMessage } from '../services/push/index.js';
import { fireAndForget } from '../lib/fire-and-forget.js';
import { safeExecutionCtx } from '../lib/safe-execution-ctx.js';
import type { TextRequest } from '../services/ai/index.js';
import type { MemberContext } from '../services/billing/index.js';
import type { AppEnv, Bindings } from '../types.js';
import type {
  FundingSource,
  RegenerateRequest,
  ImageConfig,
  VideoConfig,
  AudioConfig,
} from '@hushbox/shared';
import type { BroadcastContext, StreamResult } from '../lib/stream-pipeline.js';

// Re-export for existing test imports
export { computeWorstCaseCents } from '../lib/stream-pipeline.js';

interface InferenceMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

function matchesUniqueViolationMessage(msg: string): boolean {
  return msg.includes('duplicate key') || msg.includes('unique constraint');
}

/**
 * Detects Postgres unique-violation (SQLSTATE 23505) wrapped by Drizzle.
 * Used to surface PK / unique-index races as 409 rather than 500.
 */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (matchesUniqueViolationMessage(error.message)) return true;
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && matchesUniqueViolationMessage(cause.message)) return true;
  if (cause && typeof cause === 'object' && 'code' in cause && cause.code === '23505') return true;
  return false;
}

const noOpRelease = (): Promise<void> => Promise.resolve();

/** Retrieves the member from the members Map. Throws if not found (invariant after requirePrivilege). */
function getMember(
  c: Context<AppEnv>,
  conversationId: string
): { id: string; privilege: string; visibleFromEpoch: number } {
  const member = c.get('members').get(conversationId);
  if (!member) throw new Error('Member required after requirePrivilege');
  return member;
}

/** Picks the right budget release strategy based on billing context. */
function resolveReleaseReservation(
  redis: AppEnv['Variables']['redis'],
  groupBudget: GroupBudgetReservation | undefined,
  user: AppEnv['Variables']['user'],
  worstCaseCents: number
): () => Promise<void> {
  if (groupBudget) {
    return (): Promise<void> => releaseGroupBudget(redis, groupBudget);
  }
  if (user) {
    return (): Promise<void> => releaseBudget(redis, user.id, worstCaseCents);
  }
  return noOpRelease;
}

type SSEEventWriter = ReturnType<typeof createSSEEventWriter>;

interface BroadcastAndWriteCompletionParams {
  writer: SSEEventWriter;
  env: Bindings | undefined;
  conversationId: string;
  assistantMessageId: string;
  model: string;
  aiSequence: number;
  epochNumber: number;
  cost: string;
  userMessageId: string;
  userSequence?: number;
}

/**
 * Broadcasts a message:complete event to the room and writes the SSE done event.
 * Shared between the edit and regenerate branches.
 */
async function broadcastAndWriteCompletion(
  params: BroadcastAndWriteCompletionParams
): Promise<void> {
  broadcastFireAndForget(
    params.env,
    params.conversationId,
    createEvent('message:complete', {
      messageId: params.assistantMessageId,
      conversationId: params.conversationId,
      sequenceNumber: params.aiSequence,
      epochNumber: params.epochNumber,
      modelName: params.model,
    })
  );

  await params.writer.writeDone({
    userMessageId: params.userMessageId,
    assistantMessageId: params.assistantMessageId,
    ...(params.userSequence !== undefined && { userSequence: params.userSequence }),
    aiSequence: params.aiSequence,
    epochNumber: params.epochNumber,
    cost: params.cost,
  });
}

/** Sends a buffered broadcast token to the room. */
function flushBroadcastBuffer(broadcast: BroadcastContext, tokenBuffer: string): void {
  broadcastFireAndForget(
    broadcast.env,
    broadcast.conversationId,
    createEvent('message:stream', {
      messageId: broadcast.assistantMessageId,
      token: tokenBuffer,
      ...(broadcast.modelName !== undefined && { modelName: broadcast.modelName }),
    })
  );
}

/**
 * Pre-billing tier gate: rejects requests where the caller has selected a
 * premium model but their tier (free/trial/guest) doesn't allow it. Returns
 * the locked model id when blocked, or null when the request can proceed.
 *
 * Distinct from the balance-based denial in `handleBillingDenial` (which
 * fires for paid users with insufficient funds): this one fires earlier with
 * a 403 + {@link ERROR_CODE_MODEL_TIER_LOCKED} so the client renders an
 * "upgrade your account" message rather than "top up your balance".
 *
 * Owner-paid group chats are not gated here — the owner's tier governs model
 * access via the existing `resolveBilling` group-billing path. This only
 * gates the personal-billing path.
 */
async function findTierLockedModel(
  c: Context<AppEnv>,
  models: readonly string[],
  callerId: string | null
): Promise<string | null> {
  const db = c.get('db');
  const [tierInfo, rawModels] = await Promise.all([
    getUserTierInfo(db, callerId),
    c.var.aiClient.listRawModels(),
  ]);
  if (tierInfo.canAccessPremium) return null;
  const { premiumIds } = processModels(rawModels);
  const premiumSet = new Set(premiumIds);
  for (const modelId of models) {
    if (premiumSet.has(modelId)) return modelId;
  }
  return null;
}

/** Subset of ModelInfo fields the lookup needs — only `pricing` is read. */
type ModelInfoForLookup = Awaited<
  ReturnType<AppEnv['Variables']['aiClient']['listModels']>
>[number];

/**
 * Per-modality extract callback for {@link lookupMediaModels}. Returns a
 * discriminated outcome: `ok` carries the per-model price datum to record;
 * `mismatch` and `unsupported-resolution` push the model id into the
 * matching reject bucket.
 */
type MediaExtractOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'mismatch' }
  | { kind: 'unsupported-resolution' };

type MediaPriceExtract<T> = (info: ModelInfoForLookup) => MediaExtractOutcome<T>;

interface MediaModelLookupResult<T> {
  perModelByModel: Map<string, T>;
  mismatches: string[];
  notFound: string[];
  unsupportedResolutions: string[];
}

/**
 * Generic media-model lookup. Walks selected model IDs, fetches the gateway's
 * model list once, and bins each model into a per-model price map, mismatches,
 * notFound, or unsupportedResolutions. Per-modality `extract` plugs in the
 * pricing rule (`pricing.image`, `pricing.perSecondByResolution[r]`,
 * `pricing.audio`).
 */
export async function lookupMediaModels<T>(
  aiClient: AppEnv['Variables']['aiClient'],
  models: string[],
  extract: MediaPriceExtract<T>
): Promise<MediaModelLookupResult<T>> {
  const allModels = await aiClient.listModels();
  const mismatches: string[] = [];
  const notFound: string[] = [];
  const unsupportedResolutions: string[] = [];
  const perModelByModel = new Map<string, T>();

  for (const modelId of models) {
    const info = allModels.find((m) => m.id === modelId);
    if (!info) {
      notFound.push(modelId);
      continue;
    }
    const outcome = extract(info);
    switch (outcome.kind) {
      case 'ok': {
        perModelByModel.set(modelId, outcome.value);
        break;
      }
      case 'mismatch': {
        mismatches.push(modelId);
        break;
      }
      case 'unsupported-resolution': {
        unsupportedResolutions.push(modelId);
        break;
      }
      default: {
        assertNever(outcome);
      }
    }
  }

  return { perModelByModel, mismatches, notFound, unsupportedResolutions };
}

const extractImagePrice: MediaPriceExtract<number> = (info) =>
  info.pricing.kind === 'image'
    ? { kind: 'ok', value: info.pricing.perImage }
    : { kind: 'mismatch' };

function buildVideoExtractor(resolution: string): MediaPriceExtract<number> {
  return (info) => {
    if (info.pricing.kind !== 'video') return { kind: 'mismatch' };
    const price = info.pricing.perSecondByResolution[resolution];
    return price === undefined ? { kind: 'unsupported-resolution' } : { kind: 'ok', value: price };
  };
}

const extractAudioPrice: MediaPriceExtract<number> = (info) =>
  info.pricing.kind === 'audio'
    ? { kind: 'ok', value: info.pricing.perSecond }
    : { kind: 'mismatch' };

interface MediaBranchInputBase {
  c: Context<AppEnv>;
  conversationId: string;
  callerId: string;
  user: AppEnv['Variables']['user'];
  billingContext: BillingContext;
  models: string[];
  userMessage: { id: string; content: string };
  parentMessageId: string | null;
  forkId: string | undefined;
}

interface ImageBranchInput extends MediaBranchInputBase {
  imageConfig: ImageConfig | undefined;
}

interface VideoBranchInput extends MediaBranchInputBase {
  videoConfig: VideoConfig;
}

interface AudioBranchInput extends MediaBranchInputBase {
  audioConfig: AudioConfig;
}

/**
 * Result of running a per-modality lookup. Either an early-return error
 * Response (model not found, modality mismatch, unsupported resolution) OR
 * the per-model price map needed by the modality-specific billing call.
 */
type LookupResult<T> = { ok: true; perModel: T } | { ok: false; response: Response };

/**
 * Build an ERROR_CODE_MODEL_NOT_FOUND / ERROR_CODE_MODALITY_MISMATCH response
 * shared by every media lookup. Returns null when the lookup succeeds.
 */
function lookupRejectResponse(
  c: Context<AppEnv>,
  notFound: string[],
  mismatches: string[]
): Response | null {
  if (notFound.length > 0) {
    return c.json(createErrorResponse(ERROR_CODE_MODEL_NOT_FOUND, { models: notFound }), 400);
  }
  if (mismatches.length > 0) {
    return c.json(
      createErrorResponse(ERROR_CODE_MODALITY_MISMATCH, { invalidModels: mismatches }),
      400
    );
  }
  return null;
}

/**
 * Shared skeleton for media (image/video/audio) stream handlers. Three steps:
 * 1. Run modality-specific lookup → reject on `notFound` / `mismatches` /
 *    `unsupportedResolutions`.
 * 2. Run modality-specific billing reservation → reject on billing failure.
 * 3. Resolve the release-on-failure callback and dispatch the pipeline with
 *    the resolved billing.
 *
 * Each modality plugs in its `lookup`, `reserveBilling`, and `runPipeline`
 * callbacks. Behavior is identical to the inlined handlers — same SSE events,
 * same DB writes, same billing math, same error codes.
 */
async function runMediaBranch<
  TBilling extends { worstCaseCents: number; groupBudget?: unknown },
>(args: {
  input: MediaBranchInputBase;
  lookup: LookupResult<Map<string, number>>;
  reserveBilling: (
    perModel: Map<string, number>
  ) => Promise<({ success: true } & TBilling) | { success: false; response: Response }>;
  runPipeline: (billing: TBilling, release: () => Promise<void>) => Response;
}): Promise<Response> {
  const { input, lookup, reserveBilling, runPipeline } = args;
  if (!lookup.ok) return lookup.response;

  const billing = await reserveBilling(lookup.perModel);
  if (!billing.success) return billing.response;

  const release = resolveReleaseReservation(
    input.c.get('redis'),
    billing.groupBudget as GroupBudgetReservation | undefined,
    input.user,
    billing.worstCaseCents
  );

  return runPipeline(billing, release);
}

async function handleImageStreamRequest(input: ImageBranchInput): Promise<Response> {
  const { memberContext, billingUserId, clientFundingSource, billingResult } = input.billingContext;
  return runMediaBranch({
    input,
    lookup: await lookupImageBranch(input.c, input.models),
    reserveBilling: async (perImageByModel) =>
      resolveAndReserveImageBilling(input.c, {
        billingResult,
        userId: billingUserId,
        models: input.models,
        perImageByModel,
        clientFundingSource,
        ...(memberContext !== undefined && { memberContext }),
        conversationId: input.conversationId,
      }),
    runPipeline: (imageBilling, releaseReservation) =>
      executeImagePipeline({
        c: input.c,
        conversationId: input.conversationId,
        models: input.models,
        userMessage: input.userMessage,
        prompt: input.userMessage.content,
        imageBilling,
        ...(memberContext !== undefined && { memberContext }),
        releaseReservation,
        senderId: input.callerId,
        ...(input.forkId !== undefined && { forkId: input.forkId }),
        parentMessageId: input.parentMessageId,
        ...(input.imageConfig?.aspectRatio !== undefined && {
          aspectRatio: input.imageConfig.aspectRatio,
        }),
      }),
  });
}

async function lookupImageBranch(
  c: Context<AppEnv>,
  models: string[]
): Promise<LookupResult<Map<string, number>>> {
  const { perModelByModel, mismatches, notFound } = await lookupMediaModels(
    c.get('aiClient'),
    models,
    extractImagePrice
  );
  const reject = lookupRejectResponse(c, notFound, mismatches);
  if (reject) return { ok: false, response: reject };
  return { ok: true, perModel: perModelByModel };
}

async function handleVideoStreamRequest(input: VideoBranchInput): Promise<Response> {
  const { memberContext, billingUserId, clientFundingSource, billingResult } = input.billingContext;
  return runMediaBranch({
    input,
    lookup: await lookupVideoBranch(input.c, input.models, input.videoConfig.resolution),
    reserveBilling: async (perSecondByModel) =>
      resolveAndReserveVideoBilling(input.c, {
        billingResult,
        userId: billingUserId,
        models: input.models,
        perSecondByModel,
        durationSeconds: input.videoConfig.durationSeconds,
        resolution: input.videoConfig.resolution,
        clientFundingSource,
        ...(memberContext !== undefined && { memberContext }),
        conversationId: input.conversationId,
      }),
    runPipeline: (videoBilling, releaseReservation) =>
      executeVideoPipeline({
        c: input.c,
        conversationId: input.conversationId,
        models: input.models,
        userMessage: input.userMessage,
        prompt: input.userMessage.content,
        videoBilling,
        ...(memberContext !== undefined && { memberContext }),
        releaseReservation,
        senderId: input.callerId,
        ...(input.forkId !== undefined && { forkId: input.forkId }),
        parentMessageId: input.parentMessageId,
        aspectRatio: input.videoConfig.aspectRatio,
      }),
  });
}

async function lookupVideoBranch(
  c: Context<AppEnv>,
  models: string[],
  resolution: string
): Promise<LookupResult<Map<string, number>>> {
  const { perModelByModel, mismatches, notFound, unsupportedResolutions } = await lookupMediaModels(
    c.get('aiClient'),
    models,
    buildVideoExtractor(resolution)
  );
  const reject = lookupRejectResponse(c, notFound, mismatches);
  if (reject) return { ok: false, response: reject };
  if (unsupportedResolutions.length > 0) {
    return {
      ok: false,
      response: c.json(
        createErrorResponse(ERROR_CODE_UNSUPPORTED_RESOLUTION, {
          invalidModels: unsupportedResolutions,
          resolution,
        }),
        400
      ),
    };
  }
  return { ok: true, perModel: perModelByModel };
}

async function handleAudioStreamRequest(input: AudioBranchInput): Promise<Response> {
  const { memberContext, billingUserId, clientFundingSource, billingResult } = input.billingContext;
  return runMediaBranch({
    input,
    lookup: await lookupAudioBranch(input.c, input.models),
    reserveBilling: async (perSecondByModel) =>
      resolveAndReserveAudioBilling(input.c, {
        billingResult,
        userId: billingUserId,
        models: input.models,
        perSecondByModel,
        maxDurationSeconds: input.audioConfig.maxDurationSeconds,
        clientFundingSource,
        ...(memberContext !== undefined && { memberContext }),
        conversationId: input.conversationId,
      }),
    runPipeline: (audioBilling, releaseReservation) =>
      executeAudioPipeline({
        c: input.c,
        conversationId: input.conversationId,
        models: input.models,
        userMessage: input.userMessage,
        prompt: input.userMessage.content,
        audioBilling,
        ...(memberContext !== undefined && { memberContext }),
        releaseReservation,
        senderId: input.callerId,
        ...(input.forkId !== undefined && { forkId: input.forkId }),
        parentMessageId: input.parentMessageId,
        format: input.audioConfig.format,
        ...(input.audioConfig.voice !== undefined && { voice: input.audioConfig.voice }),
      }),
  });
}

async function lookupAudioBranch(
  c: Context<AppEnv>,
  models: string[]
): Promise<LookupResult<Map<string, number>>> {
  const { perModelByModel, mismatches, notFound } = await lookupMediaModels(
    c.get('aiClient'),
    models,
    extractAudioPrice
  );
  const reject = lookupRejectResponse(c, notFound, mismatches);
  if (reject) return { ok: false, response: reject };
  return { ok: true, perModel: perModelByModel };
}

interface TextBranchInput {
  c: Context<AppEnv>;
  conversationId: string;
  callerId: string;
  user: AppEnv['Variables']['user'];
  billingContext: BillingContext;
  models: string[];
  userMessage: { id: string; content: string };
  messagesForInference: InferenceMessage[];
  parentMessageId: string | null;
  forkId: string | undefined;
  webSearchEnabled: boolean;
  customInstructions: string | undefined;
}

async function handleTextStreamRequest(input: TextBranchInput): Promise<Response> {
  const {
    c,
    conversationId,
    callerId,
    user,
    billingContext,
    models,
    userMessage,
    messagesForInference,
    parentMessageId,
    forkId,
    webSearchEnabled,
    customInstructions,
  } = input;
  const { memberContext, billingUserId, clientFundingSource, billingResult } = billingContext;
  const redis = c.get('redis');

  const billingValidation = await resolveAndReserveBilling(c, {
    billingResult,
    userId: billingUserId,
    models,
    messagesForInference,
    clientFundingSource,
    ...(memberContext !== undefined && { memberContext }),
    conversationId,
    webSearchEnabled,
    ...(customInstructions !== undefined && { customInstructions }),
  });
  if (!billingValidation.success) {
    return billingValidation.response;
  }

  const { worstCaseCents, groupBudget } = billingValidation;
  const releaseReservation = resolveReleaseReservation(redis, groupBudget, user, worstCaseCents);

  return executeStreamPipeline({
    c,
    conversationId,
    models,
    userMessage,
    messagesForInference,
    billingValidation,
    ...(memberContext !== undefined && { memberContext }),
    webSearchEnabled,
    ...(customInstructions !== undefined && { customInstructions }),
    releaseReservation,
    senderId: callerId,
    ...(forkId !== undefined && { forkId }),
    parentMessageId,
  });
}

interface BillingContext {
  memberContext: MemberContext | undefined;
  billingUserId: string;
  clientFundingSource: FundingSource;
  billingResult: Awaited<ReturnType<typeof buildBillingInput>>;
}

async function resolveGuestBillingContext(
  db: AppEnv['Variables']['db'],
  redis: AppEnv['Variables']['redis'],
  params: {
    member: { id: string };
    ownerId: string;
    models: string[];
    conversationId: string;
    aiClient: AppEnv['Variables']['aiClient'];
  }
): Promise<BillingContext> {
  const billingResult = await buildGuestBillingInput(db, redis, {
    ownerId: params.ownerId,
    memberId: params.member.id,
    models: params.models,
    conversationId: params.conversationId,
    aiClient: params.aiClient,
  });
  return {
    memberContext: { memberId: params.member.id, ownerId: params.ownerId },
    billingUserId: params.ownerId,
    clientFundingSource: 'owner_balance',
    billingResult,
  };
}

async function resolveUserBillingContext(
  db: AppEnv['Variables']['db'],
  redis: AppEnv['Variables']['redis'],
  params: {
    callerId: string;
    ownerId: string;
    member: { id: string };
    models: string[];
    conversationId: string;
    fundingSource: FundingSource;
    aiClient: AppEnv['Variables']['aiClient'];
  }
): Promise<BillingContext> {
  const isOwner = params.callerId === params.ownerId;
  const memberContext: MemberContext | undefined = isOwner
    ? undefined
    : { memberId: params.member.id, ownerId: params.ownerId };
  const billingResult = await buildBillingInput(db, redis, {
    userId: params.callerId,
    models: params.models,
    ...(memberContext !== undefined && { memberContext }),
    conversationId: params.conversationId,
    aiClient: params.aiClient,
  });
  return {
    memberContext,
    billingUserId: params.callerId,
    clientFundingSource: params.fundingSource,
    billingResult,
  };
}

interface PersistAndBroadcastRegenerationParams {
  db: AppEnv['Variables']['db'];
  writer: SSEEventWriter;
  env: Bindings | undefined;
  conversationId: string;
  model: string;
  assistantMessageId: string;
  result: StreamResult;
  aiClient: AppEnv['Variables']['aiClient'];
  lastInferenceMessage: { role: string; content: string } | undefined;
  memberContext: MemberContext | undefined;
  billingValidation: { groupBudget?: GroupBudgetReservation };
  billingUserId: string;
  user: { id: string };
  targetMessageId: string;
  userMessage: { id: string; content: string };
  action: 'edit' | 'regenerate';
  forkId?: string | undefined;
  forkTipMessageId?: string | undefined;
}

/** Builds the optional spread fields shared between edit and regenerate persistence. */
function buildOptionalPersistenceFields(
  groupBillingContext: { memberId: string } | undefined,
  forkId: string | undefined,
  forkTipMessageId: string | undefined
): Record<string, unknown> {
  return {
    ...(groupBillingContext !== undefined && { groupBillingContext }),
    ...(forkId !== undefined && { forkId }),
    ...(forkTipMessageId !== undefined && { forkTipMessageId }),
  };
}

/** Persists the regeneration result (edit or regenerate) and broadcasts completion. */
async function persistAndBroadcastRegeneration(
  params: PersistAndBroadcastRegenerationParams
): Promise<void> {
  const {
    db,
    writer,
    env,
    conversationId,
    model,
    assistantMessageId,
    result,
    aiClient,
    lastInferenceMessage,
    memberContext,
    billingValidation,
    billingUserId,
    user,
    targetMessageId,
    userMessage,
    action,
    forkId,
    forkTipMessageId,
  } = params;

  const totalCost = result.generationId
    ? await calculateMessageCost({
        aiClient,
        generationId: result.generationId,
        inputContent: lastInferenceMessage?.content ?? '',
        outputContent: result.fullContent,
      })
    : 0;

  const inputTokens = estimateTokenCount(lastInferenceMessage?.content ?? '');
  const outputTokens = estimateTokenCount(result.fullContent);

  const groupBillingContext = buildGroupBillingContext(
    memberContext,
    billingValidation.groupBudget
  );

  const optionalFields = buildOptionalPersistenceFields(
    groupBillingContext,
    forkId,
    forkTipMessageId
  );

  if (action === 'edit') {
    const editResult = await saveEditedChatTurn(db, {
      conversationId,
      userId: billingUserId,
      senderId: user.id,
      targetMessageId,
      newUserMessageId: userMessage.id,
      newUserContent: userMessage.content,
      assistantMessageId,
      assistantContent: result.fullContent,
      model,
      totalCost,
      inputTokens,
      outputTokens,
      ...optionalFields,
    });

    await broadcastAndWriteCompletion({
      writer,
      env,
      conversationId,
      assistantMessageId,
      model,
      aiSequence: editResult.aiSequence,
      epochNumber: editResult.epochNumber,
      cost: editResult.cost,
      userMessageId: userMessage.id,
      userSequence: editResult.userSequence,
    });
  } else {
    const regenResult = await saveRegeneratedResponse(db, {
      conversationId,
      userId: billingUserId,
      anchorMessageId: targetMessageId,
      assistantMessageId,
      assistantContent: result.fullContent,
      model,
      totalCost,
      inputTokens,
      outputTokens,
      ...optionalFields,
    });

    await broadcastAndWriteCompletion({
      writer,
      env,
      conversationId,
      assistantMessageId,
      model,
      aiSequence: regenResult.aiSequence,
      epochNumber: regenResult.epochNumber,
      cost: regenResult.cost,
      userMessageId: targetMessageId,
    });
  }
}

/** Resolves fork tip message ID. Returns null if fork doesn't exist, undefined if no forkId. */
async function resolveForkTipMessageId(
  db: AppEnv['Variables']['db'],
  forkId: string | undefined
): Promise<string | null | undefined> {
  if (!forkId) return undefined;

  const [fork] = await db
    .select({ tipMessageId: conversationForks.tipMessageId })
    .from(conversationForks)
    .where(eq(conversationForks.id, forkId));

  if (!fork) return null;
  return fork.tipMessageId ?? undefined;
}

/** Checks stream result for errors or empty content, writes error to writer if found. Returns true if error was handled. */
async function handleStreamResultError(
  result: StreamResult,
  writer: SSEEventWriter
): Promise<boolean> {
  if (result.error) {
    await writer.writeError({
      message: result.error.message,
      code: classifyStreamErrorCode(result.error),
    });
    return true;
  }
  if (result.fullContent.length === 0) {
    await writer.writeError({
      message: 'No content generated',
      code: ERROR_CODE_STREAM_ERROR,
    });
    return true;
  }
  return false;
}

interface RegenerateValidationParams {
  db: AppEnv['Variables']['db'];
  redis: AppEnv['Variables']['redis'];
  conversationId: string;
  userId: string;
  targetMessageId: string;
  forkId: string | undefined;
  model: string;
  messagesForInference: RegenerateRequest['messagesForInference'];
  memberContext: MemberContext | undefined;
  fundingSource: FundingSource;
  webSearchEnabled: boolean;
  customInstructions: string | undefined;
}

type RegenerateValidationResult =
  | { ok: false; response: Response }
  | {
      ok: true;
      forkTipMessageId: string | undefined;
      billingValidation: Awaited<ReturnType<typeof resolveAndReserveBilling>> & { success: true };
      billingUserId: string;
      safeMaxTokens: number | undefined;
      gatewayModels: RawModel[];
      worstCaseCents: number;
      groupBudget: GroupBudgetReservation | undefined;
      webSearchCost: number;
    };

/** Validates regeneration preconditions (fork, guard, billing) and returns prepared billing context. */
async function validateRegenerationRequest(
  c: Context<AppEnv>,
  params: RegenerateValidationParams
): Promise<RegenerateValidationResult> {
  const {
    db,
    redis,
    conversationId,
    userId,
    targetMessageId,
    forkId,
    model,
    messagesForInference,
    memberContext,
    fundingSource,
    webSearchEnabled,
    customInstructions,
  } = params;

  if (!validateLastMessageIsFromUser(messagesForInference)) {
    return {
      ok: false,
      response: c.json(createErrorResponse(ERROR_CODE_LAST_MESSAGE_NOT_USER), 400),
    };
  }

  const forkTipMessageId = await resolveForkTipMessageId(db, forkId);
  if (forkTipMessageId === null) {
    return { ok: false, response: c.json(createErrorResponse(ERROR_CODE_FORK_NOT_FOUND), 404) };
  }

  const allowed = await canRegenerate(db, {
    conversationId,
    targetMessageId,
    userId,
    ...(forkTipMessageId !== undefined && { forkTipMessageId }),
  });
  if (!allowed) {
    return {
      ok: false,
      response: c.json(createErrorResponse(ERROR_CODE_REGENERATION_BLOCKED_BY_OTHER_USER), 403),
    };
  }

  const billingInput = await buildBillingInput(db, redis, {
    userId,
    models: [model],
    aiClient: c.var.aiClient,
    ...(memberContext !== undefined && { memberContext }),
    conversationId,
  });

  const billingValidation = await resolveAndReserveBilling(c, {
    billingResult: billingInput,
    userId,
    models: [model],
    messagesForInference,
    clientFundingSource: fundingSource,
    ...(memberContext !== undefined && { memberContext }),
    conversationId,
    webSearchEnabled,
    ...(customInstructions !== undefined && { customInstructions }),
  });
  if (!billingValidation.success) {
    return { ok: false, response: billingValidation.response };
  }

  return {
    ok: true,
    forkTipMessageId,
    billingValidation,
    billingUserId: billingValidation.billingUserId,
    safeMaxTokens: billingValidation.safeMaxTokens,
    gatewayModels: billingValidation.gatewayModels,
    worstCaseCents: billingValidation.worstCaseCents,
    groupBudget: billingValidation.groupBudget,
    webSearchCost: resolveWebSearchCost(webSearchEnabled, model, billingValidation.gatewayModels),
  };
}

interface DispatchModalityInput {
  modality: 'text' | 'image' | 'video' | 'audio';
  c: Context<AppEnv>;
  conversationId: string;
  callerId: string;
  user: AppEnv['Variables']['user'];
  billingContext: BillingContext;
  models: string[];
  userMessage: { id: string; content: string };
  messagesForInference: InferenceMessage[];
  parentMessageId: string | null;
  forkId: string | undefined;
  webSearchEnabled: boolean;
  customInstructions: string | undefined;
  imageConfig: ImageConfig | undefined;
  videoConfig: VideoConfig | undefined;
  audioConfig: AudioConfig | undefined;
}

/** Dispatches a stream request to the modality-specific handler. */
export async function dispatchModalityRequest(input: DispatchModalityInput): Promise<Response> {
  // `getStrategy` owns the canonical Modality switch with an `assertNever`
  // exhaustiveness guard. Calling it here is the runtime gate against rogue
  // values that bypass strict typing (e.g. test casts). The dispatch switch
  // below has no `default` because every Modality case returns; adding a new
  // modality fails typecheck in BOTH places.
  getStrategy(input.modality);
  switch (input.modality) {
    case 'image': {
      return handleImageStreamRequest({
        c: input.c,
        conversationId: input.conversationId,
        callerId: input.callerId,
        user: input.user,
        billingContext: input.billingContext,
        models: input.models,
        userMessage: input.userMessage,
        parentMessageId: input.parentMessageId,
        forkId: input.forkId,
        imageConfig: input.imageConfig,
      });
    }
    case 'video': {
      if (!input.videoConfig) {
        throw new Error('invariant: videoConfig required for video modality');
      }
      return handleVideoStreamRequest({
        c: input.c,
        conversationId: input.conversationId,
        callerId: input.callerId,
        user: input.user,
        billingContext: input.billingContext,
        models: input.models,
        userMessage: input.userMessage,
        parentMessageId: input.parentMessageId,
        forkId: input.forkId,
        videoConfig: input.videoConfig,
      });
    }
    case 'audio': {
      if (!input.audioConfig) {
        throw new Error('invariant: audioConfig required for audio modality');
      }
      return handleAudioStreamRequest({
        c: input.c,
        conversationId: input.conversationId,
        callerId: input.callerId,
        user: input.user,
        billingContext: input.billingContext,
        models: input.models,
        userMessage: input.userMessage,
        parentMessageId: input.parentMessageId,
        forkId: input.forkId,
        audioConfig: input.audioConfig,
      });
    }
    case 'text': {
      return handleTextStreamRequest({
        c: input.c,
        conversationId: input.conversationId,
        callerId: input.callerId,
        user: input.user,
        billingContext: input.billingContext,
        models: input.models,
        userMessage: input.userMessage,
        messagesForInference: input.messagesForInference,
        parentMessageId: input.parentMessageId,
        forkId: input.forkId,
        webSearchEnabled: input.webSearchEnabled,
        customInstructions: input.customInstructions,
      });
    }
  }
}

interface StreamRequestGatesParams {
  c: Context<AppEnv>;
  modality: 'text' | 'image' | 'video' | 'audio';
  linkGuest: AppEnv['Variables']['linkGuest'];
  callerId: string;
  ownerId: string;
  models: string[];
  messagesForInference: InferenceMessage[];
}

/**
 * Tier gate: free/trial/guest users picking a premium model get a dedicated
 * 403 + MODEL_TIER_LOCKED so the UI can render an "upgrade your account"
 * message rather than the balance-focused PREMIUM_REQUIRES_BALANCE that fires
 * later in handleBillingDenial.
 *
 * Only applied to direct-billing requests (caller is conversation owner, not
 * a link guest). Group-billed and link-guest paths defer model-access
 * decisions to `resolveBilling`, which evaluates the OWNER's tier — those
 * paths still surface PREMIUM_REQUIRES_BALANCE / GROUP_BUDGET_EXHAUSTED via
 * `handleBillingDenial`.
 */
interface TierLockParams {
  c: Context<AppEnv>;
  linkGuest: AppEnv['Variables']['linkGuest'];
  callerId: string;
  ownerId: string;
  models: string[];
}

async function enforceTierLock(params: TierLockParams): Promise<Response | null> {
  const { c, linkGuest, callerId, ownerId, models } = params;
  const isDirectBilling = !linkGuest && callerId === ownerId;
  if (!isDirectBilling) return null;
  const lockedModel = await findTierLockedModel(c, models, callerId);
  if (lockedModel === null) return null;
  return c.json(createErrorResponse(ERROR_CODE_MODEL_TIER_LOCKED, { modelId: lockedModel }), 403);
}

/**
 * Runs all preconditions for POST /:conversationId/stream and returns the
 * matching error response if any gate fails. Returns null when every gate
 * passes so the caller can proceed to billing resolution and dispatch.
 *
 * Gates (in order):
 *   - last message is user-authored (LAST_MESSAGE_NOT_USER, 400)
 *   - link guests can't request media generation (MEDIA_TRIAL_BLOCKED, 403)
 *   - audio modality respects FEATURE_FLAGS.AUDIO_ENABLED (AUDIO_DISABLED, 503)
 *   - direct-billing callers can't pick a premium model their tier locks
 *     (MODEL_TIER_LOCKED, 403) — see {@link enforceTierLock}.
 */
async function validateStreamRequestGates(
  params: StreamRequestGatesParams
): Promise<Response | null> {
  const { c, modality, linkGuest, callerId, ownerId, models, messagesForInference } = params;

  if (!validateLastMessageIsFromUser(messagesForInference)) {
    return c.json(createErrorResponse(ERROR_CODE_LAST_MESSAGE_NOT_USER), 400);
  }

  const isMediaModality = modality === 'image' || modality === 'video' || modality === 'audio';
  if (isMediaModality && linkGuest) {
    return c.json(createErrorResponse(ERROR_CODE_MEDIA_TRIAL_BLOCKED), 403);
  }

  // Audio is dead-coded behind FEATURE_FLAGS.AUDIO_ENABLED until the AI
  // Gateway ships speech-model support. 503 (Service Unavailable) is the
  // right code: the request is well-formed; the feature is temporarily
  // off and will return when the gateway adds speech support.
  if (modality === 'audio' && !FEATURE_FLAGS.AUDIO_ENABLED) {
    return c.json(createErrorResponse(ERROR_CODE_AUDIO_DISABLED), 503);
  }

  return enforceTierLock({ c, linkGuest, callerId, ownerId, models });
}

const conversationIdParameterSchema = z.object({ conversationId: z.string().min(1) });

export const chatRoute = new Hono<AppEnv>()

  .post(
    '/:conversationId/stream',
    zValidator('param', conversationIdParameterSchema),
    rateLimitByUser('chatStreamUserRateLimit'),
    zValidator('json', streamChatRequestSchema),
    requirePrivilege('write', { allowLinkGuest: true, includeOwnerId: true }),

    async (c) => {
      const { conversationId } = c.req.param();
      const callerId = c.get('callerId');
      const member = getMember(c, conversationId);
      const linkGuest = c.get('linkGuest');
      const ownerId = c.get('conversationOwnerId');
      const db = c.get('db');
      const redis = c.get('redis');

      const {
        modality,
        models,
        userMessage,
        messagesForInference,
        fundingSource,
        webSearchEnabled = false,
        customInstructions,
        forkId,
        imageConfig,
        videoConfig,
        audioConfig,
      } = c.req.valid('json');

      const gateError = await validateStreamRequestGates({
        c,
        modality,
        linkGuest,
        callerId,
        ownerId,
        models,
        messagesForInference,
      });
      if (gateError) return gateError;

      // --- Resolve billing (focused branch) ---
      const billingContext = linkGuest
        ? await resolveGuestBillingContext(db, redis, {
            member,
            ownerId,
            models,
            conversationId,
            aiClient: c.var.aiClient,
          })
        : await resolveUserBillingContext(db, redis, {
            callerId,
            ownerId,
            member,
            models,
            conversationId,
            fundingSource,
            aiClient: c.var.aiClient,
          });
      const user = c.get('user');

      // Resolve parentMessageId: fork tip when in a fork, latest message otherwise
      const parentMessageId = await resolveParentMessageId(db, conversationId, forkId);

      return dispatchModalityRequest({
        modality,
        c,
        conversationId,
        callerId,
        user,
        billingContext,
        models,
        userMessage,
        messagesForInference,
        parentMessageId,
        forkId,
        webSearchEnabled,
        customInstructions,
        imageConfig,
        videoConfig,
        audioConfig,
      });
    }
  )
  .post(
    '/:conversationId/message',
    zValidator('param', conversationIdParameterSchema),
    zValidator('json', userOnlyMessageSchema),
    requirePrivilege('write', { includeOwnerId: true }),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const { conversationId } = c.req.param();
      const { messageId, content } = c.req.valid('json');
      const db = c.get('db');

      // Resolve parentMessageId from latest message in the conversation
      const parentMessageId = await resolveParentMessageId(db, conversationId);

      // Save message — free, no billing. A retry that hits the same messageId
      // surfaces 409 instead of crashing on the PK collision; a concurrent
      // writer that advanced the (conversation, sequence) pair surfaces 409
      // via the unique index. Either way, the client should refresh.
      let result;
      try {
        result = await saveUserOnlyMessage(db, {
          conversationId,
          userId: user.id,
          senderId: user.id,
          messageId,
          content,
          parentMessageId,
        });
      } catch (error) {
        if (error instanceof ForkTipConflictError) {
          return c.json(createErrorResponse(ERROR_CODE_FORK_TIP_CONFLICT), 409);
        }
        if (isUniqueViolation(error)) {
          return c.json(createErrorResponse(ERROR_CODE_DUPLICATE_MESSAGE), 409);
        }
        throw error;
      }

      // Broadcast to group chat members
      broadcastFireAndForget(
        c.env,
        conversationId,
        createEvent('message:new', {
          messageId,
          conversationId,
          senderType: 'user',
          senderId: user.id,
        }),
        safeExecutionCtx(c)
      );

      // Fire-and-forget push notifications to other conversation members
      fireAndForget(
        sendPushForNewMessage({
          db,
          pushClient: getPushClient(c.env),
          conversationId,
          senderUserId: user.id,
          title: 'New Message',
          body: 'You have a new message',
        }),
        'send push notifications for user message',
        safeExecutionCtx(c)
      );

      return c.json({
        messageId,
        sequenceNumber: result.sequenceNumber,
        epochNumber: result.epochNumber,
      });
    }
  )

  .post(
    '/:conversationId/regenerate',
    zValidator('param', conversationIdParameterSchema),
    rateLimitByUser('chatStreamUserRateLimit'),
    zValidator('json', regenerateRequestSchema),
    requirePrivilege('write', { includeOwnerId: true }),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const { conversationId } = c.req.param();
      const ownerId = c.get('conversationOwnerId');
      const member = getMember(c, conversationId);
      const isOwner = user.id === ownerId;
      const memberContext: MemberContext | undefined = isOwner
        ? undefined
        : { memberId: member.id, ownerId };

      const {
        targetMessageId,
        action,
        model,
        userMessage,
        messagesForInference,
        fundingSource,
        forkId,
        webSearchEnabled = false,
        customInstructions,
      } = c.req.valid('json');
      const db = c.get('db');
      const aiClient = c.get('aiClient');
      const redis = c.get('redis');

      const validation = await validateRegenerationRequest(c, {
        db,
        redis,
        conversationId,
        userId: user.id,
        targetMessageId,
        forkId,
        model,
        messagesForInference,
        memberContext,
        fundingSource,
        webSearchEnabled,
        customInstructions,
      });
      if (!validation.ok) return validation.response;

      const {
        forkTipMessageId,
        billingValidation,
        billingUserId,
        safeMaxTokens,
        worstCaseCents,
        groupBudget,
      } = validation;

      const releaseReservation = groupBudget
        ? (): Promise<void> => releaseGroupBudget(redis, groupBudget)
        : (): Promise<void> => releaseBudget(redis, user.id, worstCaseCents);

      const assistantMessageId = crypto.randomUUID();

      const { systemPrompt } = buildPrompt({
        modelId: model,
        supportedCapabilities: [],
        ...(customInstructions !== undefined && { customInstructions }),
      });

      const aiMessages = buildAIMessages(systemPrompt, messagesForInference);
      const lastInferenceMessage = messagesForInference.at(-1);

      const textRequest: TextRequest = getStrategy('text').buildRequest({
        modelId: model,
        messages: aiMessages,
        webSearchEnabled,
        ...(safeMaxTokens !== undefined && { maxOutputTokens: safeMaxTokens }),
      });

      return streamSSE(c, async (stream) => {
        const writer = createSSEEventWriter(stream);
        try {
          await writer.writeStart({
            userMessageId: action === 'edit' ? userMessage.id : targetMessageId,
            models: [{ modelId: model, assistantMessageId }],
          });

          const inferenceStream = aiClient.stream(textRequest);

          const broadcast: BroadcastContext = {
            env: c.env,
            conversationId,
            assistantMessageId,
            modelName: model,
          };

          const slotResult = await collectSingleSlot({
            modelId: model,
            assistantMessageId,
            stream: inferenceStream,
            writer,
            onTokenBatch: (_modelId, content) => {
              flushBroadcastBuffer(broadcast, content);
            },
            batchIntervalMs: BATCH_INTERVAL_MS,
            // Regenerate writes its own top-level error event below; suppress
            // the per-slot model:error so the SSE error sequence stays the
            // same as before this refactor.
            emitErrorEvent: false,
          });

          const result: StreamResult = {
            fullContent: slotResult.content,
            generationId: slotResult.generationId,
            error: slotResult.error,
          };

          if (await handleStreamResultError(result, writer)) return;

          await persistAndBroadcastRegeneration({
            db,
            writer,
            env: c.env,
            conversationId,
            model,
            assistantMessageId,
            result,
            aiClient,
            lastInferenceMessage,
            memberContext,
            billingValidation,
            billingUserId,
            user,
            targetMessageId,
            userMessage,
            action: action === 'retry' ? 'regenerate' : action,
            forkId,
            forkTipMessageId,
          });

          // Fire-and-forget push notifications to other conversation members
          fireAndForget(
            sendPushForNewMessage({
              db,
              pushClient: getPushClient(c.env),
              conversationId,
              senderUserId: user.id,
              title: 'New Message',
              body: 'You have a new message',
            }),
            'send push notifications for AI response',
            safeExecutionCtx(c)
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          await writer.writeError({ message, code: classifyStreamErrorCode(error) });
        } finally {
          await releaseReservation();
        }
      });
    }
  );
