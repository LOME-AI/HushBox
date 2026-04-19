import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { streamSSE } from 'hono/streaming';
import { eq } from 'drizzle-orm';
import { conversationForks } from '@hushbox/db';
import { resolveParentMessageId } from '../services/chat/message-helpers.js';
import {
  streamChatRequestSchema,
  userOnlyMessageSchema,
  regenerateRequestSchema,
  ERROR_CODE_LAST_MESSAGE_NOT_USER,
  ERROR_CODE_REGENERATION_BLOCKED_BY_OTHER_USER,
  ERROR_CODE_FORK_NOT_FOUND,
  ERROR_CODE_CONTEXT_LENGTH_EXCEEDED,
  ERROR_CODE_STREAM_ERROR,
  ERROR_CODE_MEDIA_TRIAL_BLOCKED,
  ERROR_CODE_MODEL_NOT_FOUND,
  ERROR_CODE_MODALITY_MISMATCH,
  ERROR_CODE_UNSUPPORTED_RESOLUTION,
  estimateTokenCount,
} from '@hushbox/shared';
import type { FundingSource, RegenerateRequest } from '@hushbox/shared';
import type { AppEnv, Bindings } from '../types.js';
import { buildPrompt } from '../services/prompt/builder.js';
import {
  buildBillingInput,
  buildGuestBillingInput,
  calculateMessageCost,
} from '../services/billing/index.js';
import type { MemberContext } from '../services/billing/index.js';
import type { InferenceEvent, InferenceStream, TextRequest } from '../services/ai/index.js';
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
import { requirePrivilege } from '../middleware/index.js';
import { broadcastFireAndForget } from '../lib/broadcast.js';
import { createEvent } from '@hushbox/realtime/events';
import {
  releaseBudget,
  releaseGroupBudget,
  type GroupBudgetReservation,
} from '../lib/speculative-balance.js';
import {
  resolveAndReserveBilling,
  resolveAndReserveImageBilling,
  resolveAndReserveVideoBilling,
  executeStreamPipeline,
  executeImagePipeline,
  executeVideoPipeline,
  resolveWebSearchCost,
  BATCH_INTERVAL_MS,
} from '../lib/stream-pipeline.js';
import type { BroadcastContext, StreamResult } from '../lib/stream-pipeline.js';
import { getPushClient, sendPushForNewMessage } from '../services/push/index.js';
import { fireAndForget } from '../lib/fire-and-forget.js';
import { safeExecutionCtx } from '../lib/safe-execution-ctx.js';

// Re-export for existing test imports
export { computeWorstCaseCents } from '../lib/stream-pipeline.js';

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

interface BroadcastState {
  buffer: string;
  lastTime: number;
}

function writeTokenAndBroadcast(
  content: string,
  broadcast: BroadcastContext | undefined,
  state: BroadcastState
): BroadcastState {
  if (!broadcast) return state;
  const newBuffer = state.buffer + content;
  if (Date.now() - state.lastTime >= BATCH_INTERVAL_MS) {
    flushBroadcastBuffer(broadcast, newBuffer);
    return { buffer: '', lastTime: Date.now() };
  }
  return { ...state, buffer: newBuffer };
}

interface InferenceCollectorState {
  fullContent: string;
  generationId: string | undefined;
  broadcastState: BroadcastState;
}

function processInferenceEvent(
  event: InferenceEvent,
  state: InferenceCollectorState,
  broadcast: BroadcastContext | undefined
): InferenceCollectorState {
  const updated = { ...state };
  switch (event.kind) {
    case 'text-delta': {
      if (event.content.length > 0) {
        updated.fullContent += event.content;
        updated.broadcastState = writeTokenAndBroadcast(
          event.content,
          broadcast,
          state.broadcastState
        );
      }
      break;
    }
    case 'finish': {
      if (event.providerMetadata?.generationId)
        updated.generationId = event.providerMetadata.generationId;
      break;
    }
    default: {
      break;
    }
  }
  return updated;
}

async function collectInferenceEvents(
  inferenceStream: InferenceStream,
  writer: SSEEventWriter,
  modelContext: { modelId: string; assistantMessageId: string },
  broadcast?: BroadcastContext
): Promise<StreamResult> {
  const { modelId, assistantMessageId: modelAssistantMessageId } = modelContext;
  let state: InferenceCollectorState = {
    fullContent: '',
    generationId: undefined,
    broadcastState: { buffer: '', lastTime: Date.now() },
  };
  let error: Error | null = null;

  try {
    for await (const event of inferenceStream) {
      state = processInferenceEvent(event, state, broadcast);
      if (event.kind === 'text-delta' && event.content.length > 0) {
        await writer.writeModelToken({ modelId, content: event.content });
      }
    }
  } catch (error_) {
    error = error_ instanceof Error ? error_ : new Error('Unknown error');
  }

  if (broadcast && state.broadcastState.buffer.length > 0) {
    flushBroadcastBuffer(broadcast, state.broadcastState.buffer);
  }

  if (error === null) {
    await writer.writeModelDone({
      modelId,
      assistantMessageId: modelAssistantMessageId,
      cost: '0',
    });
  }

  return {
    fullContent: state.fullContent,
    generationId: state.generationId,
    error,
  };
}

/** Read the AI gateway API key from env or throw a clear error. */
function requireApiKey(c: Context<AppEnv>): string {
  const apiKey = c.env.AI_GATEWAY_API_KEY;
  if (!apiKey) throw new Error('AI_GATEWAY_API_KEY required');
  return apiKey;
}

/** Read the public models URL from env or throw a clear error. */
function requirePublicModelsUrl(c: Context<AppEnv>): string {
  const url = c.env.PUBLIC_MODELS_URL;
  if (!url) throw new Error('PUBLIC_MODELS_URL required');
  return url;
}

interface ImageModelLookup {
  /**
   * Per-image price for each selected model, keyed by model ID. Image pricing
   * is deterministic at reservation time, so we don't need a worst-case max —
   * the caller sums these for both reservation and per-model billing.
   */
  perImageByModel: Map<string, number>;
  /** Model IDs that are NOT image models (should be rejected). */
  mismatches: string[];
  /** Model IDs that were requested but not found in the gateway. */
  notFound: string[];
}

/**
 * Validate selected models against the image modality and collect each model's
 * actual per-image price. Returns mismatches/notFound lists for reject-path
 * error responses. `perImageByModel` has one entry per selected model (only
 * models that passed the image-modality check — mismatches are excluded).
 */
async function lookupImageModels(
  aiClient: AppEnv['Variables']['aiClient'],
  models: string[]
): Promise<ImageModelLookup> {
  const allModels = await aiClient.listModels();
  const mismatches: string[] = [];
  const notFound: string[] = [];
  const perImageByModel = new Map<string, number>();

  for (const modelId of models) {
    const info = allModels.find((m) => m.id === modelId);
    if (!info) {
      notFound.push(modelId);
      continue;
    }
    if (info.pricing.kind !== 'image') {
      mismatches.push(modelId);
      continue;
    }
    perImageByModel.set(modelId, info.pricing.perImage);
  }

  return { perImageByModel, mismatches, notFound };
}

interface VideoModelLookup {
  /**
   * Per-second price at the requested resolution for each selected video model,
   * keyed by model ID. Deterministic at reservation time — summing yields the
   * exact reservation cost; per-model lookup yields exact billing cost.
   */
  perSecondByModel: Map<string, number>;
  /** Model IDs that are NOT video models. */
  mismatches: string[];
  /** Model IDs that were requested but not found in the gateway. */
  notFound: string[];
  /** Model IDs that are video models but don't price the requested resolution. */
  unsupportedResolutions: string[];
}

/**
 * Validate selected models against the video modality at a specific resolution
 * and collect each model's actual per-second price for that resolution.
 * Video pricing is per-resolution, so the resolution must be known up front.
 */
async function lookupVideoModels(
  aiClient: AppEnv['Variables']['aiClient'],
  models: string[],
  resolution: string
): Promise<VideoModelLookup> {
  const allModels = await aiClient.listModels();
  const mismatches: string[] = [];
  const notFound: string[] = [];
  const unsupportedResolutions: string[] = [];
  const perSecondByModel = new Map<string, number>();

  for (const modelId of models) {
    const info = allModels.find((m) => m.id === modelId);
    if (!info) {
      notFound.push(modelId);
      continue;
    }
    if (info.pricing.kind !== 'video') {
      mismatches.push(modelId);
      continue;
    }
    const price = info.pricing.perSecondByResolution[resolution];
    if (price === undefined) {
      unsupportedResolutions.push(modelId);
      continue;
    }
    perSecondByModel.set(modelId, price);
  }

  return { perSecondByModel, mismatches, notFound, unsupportedResolutions };
}

interface ImageBranchInput {
  c: Context<AppEnv>;
  conversationId: string;
  callerId: string;
  user: AppEnv['Variables']['user'];
  billingContext: BillingContext;
  models: string[];
  userMessage: { id: string; content: string };
  parentMessageId: string | null;
  forkId: string | undefined;
  imageConfig: { aspectRatio?: string } | undefined;
}

async function handleImageStreamRequest(input: ImageBranchInput): Promise<Response> {
  const {
    c,
    conversationId,
    callerId,
    user,
    billingContext,
    models,
    userMessage,
    parentMessageId,
    forkId,
    imageConfig,
  } = input;
  const { memberContext, billingUserId, clientFundingSource, billingResult } = billingContext;
  const aiClient = c.get('aiClient');
  const redis = c.get('redis');

  const { perImageByModel, mismatches, notFound } = await lookupImageModels(aiClient, models);

  if (notFound.length > 0) {
    return c.json(createErrorResponse(ERROR_CODE_MODEL_NOT_FOUND, { models: notFound }), 400);
  }
  if (mismatches.length > 0) {
    return c.json(
      createErrorResponse(ERROR_CODE_MODALITY_MISMATCH, { invalidModels: mismatches }),
      400
    );
  }

  const imageBilling = await resolveAndReserveImageBilling(c, {
    billingResult,
    userId: billingUserId,
    models,
    perImageByModel,
    clientFundingSource,
    ...(memberContext !== undefined && { memberContext }),
    conversationId,
  });
  if (!imageBilling.success) {
    return imageBilling.response;
  }

  const releaseImageReservation = resolveReleaseReservation(
    redis,
    imageBilling.groupBudget,
    user,
    imageBilling.worstCaseCents
  );

  return executeImagePipeline({
    c,
    conversationId,
    models,
    userMessage,
    prompt: userMessage.content,
    imageBilling,
    ...(memberContext !== undefined && { memberContext }),
    releaseReservation: releaseImageReservation,
    senderId: callerId,
    ...(forkId !== undefined && { forkId }),
    parentMessageId,
    ...(imageConfig?.aspectRatio !== undefined && { aspectRatio: imageConfig.aspectRatio }),
  });
}

interface VideoBranchInput {
  c: Context<AppEnv>;
  conversationId: string;
  callerId: string;
  user: AppEnv['Variables']['user'];
  billingContext: BillingContext;
  models: string[];
  userMessage: { id: string; content: string };
  parentMessageId: string | null;
  forkId: string | undefined;
  videoConfig: { aspectRatio: string; durationSeconds: number; resolution: string };
}

async function handleVideoStreamRequest(input: VideoBranchInput): Promise<Response> {
  const {
    c,
    conversationId,
    callerId,
    user,
    billingContext,
    models,
    userMessage,
    parentMessageId,
    forkId,
    videoConfig,
  } = input;
  const { memberContext, billingUserId, clientFundingSource, billingResult } = billingContext;
  const aiClient = c.get('aiClient');
  const redis = c.get('redis');

  const { perSecondByModel, mismatches, notFound, unsupportedResolutions } =
    await lookupVideoModels(aiClient, models, videoConfig.resolution);

  if (notFound.length > 0) {
    return c.json(createErrorResponse(ERROR_CODE_MODEL_NOT_FOUND, { models: notFound }), 400);
  }
  if (mismatches.length > 0) {
    return c.json(
      createErrorResponse(ERROR_CODE_MODALITY_MISMATCH, { invalidModels: mismatches }),
      400
    );
  }
  if (unsupportedResolutions.length > 0) {
    return c.json(
      createErrorResponse(ERROR_CODE_UNSUPPORTED_RESOLUTION, {
        invalidModels: unsupportedResolutions,
        resolution: videoConfig.resolution,
      }),
      400
    );
  }

  const videoBilling = await resolveAndReserveVideoBilling(c, {
    billingResult,
    userId: billingUserId,
    models,
    perSecondByModel,
    durationSeconds: videoConfig.durationSeconds,
    resolution: videoConfig.resolution,
    clientFundingSource,
    ...(memberContext !== undefined && { memberContext }),
    conversationId,
  });
  if (!videoBilling.success) {
    return videoBilling.response;
  }

  const releaseVideoReservation = resolveReleaseReservation(
    redis,
    videoBilling.groupBudget,
    user,
    videoBilling.worstCaseCents
  );

  return executeVideoPipeline({
    c,
    conversationId,
    models,
    userMessage,
    prompt: userMessage.content,
    videoBilling,
    ...(memberContext !== undefined && { memberContext }),
    releaseReservation: releaseVideoReservation,
    senderId: callerId,
    ...(forkId !== undefined && { forkId }),
    parentMessageId,
    aspectRatio: videoConfig.aspectRatio,
  });
}

interface TextBranchInput {
  c: Context<AppEnv>;
  conversationId: string;
  callerId: string;
  user: AppEnv['Variables']['user'];
  billingContext: BillingContext;
  models: string[];
  userMessage: { id: string; content: string };
  messagesForInference: { role: 'user' | 'assistant' | 'system'; content: string }[];
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
    apiKey: string;
    publicModelsUrl: string;
  }
): Promise<BillingContext> {
  const billingResult = await buildGuestBillingInput(db, redis, {
    ownerId: params.ownerId,
    memberId: params.member.id,
    models: params.models,
    conversationId: params.conversationId,
    apiKey: params.apiKey,
    publicModelsUrl: params.publicModelsUrl,
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
    apiKey: string;
    publicModelsUrl: string;
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
    apiKey: params.apiKey,
    publicModelsUrl: params.publicModelsUrl,
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

  const groupBillingContext =
    memberContext !== undefined && billingValidation.groupBudget !== undefined
      ? { memberId: memberContext.memberId }
      : undefined;

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

/** Maps stream errors to the appropriate error code. */
function resolveStreamErrorCode(error: unknown): string {
  if (error instanceof Error && error.message.includes('context length')) {
    return ERROR_CODE_CONTEXT_LENGTH_EXCEEDED;
  }
  return ERROR_CODE_STREAM_ERROR;
}

/** Checks stream result for errors or empty content, writes error to writer if found. Returns true if error was handled. */
async function handleStreamResultError(
  result: StreamResult,
  writer: SSEEventWriter
): Promise<boolean> {
  if (result.error) {
    await writer.writeError({
      message: result.error.message,
      code: resolveStreamErrorCode(result.error),
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
      gatewayModels: Awaited<ReturnType<typeof import('@hushbox/shared/models').fetchModels>>;
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

  const apiKey = requireApiKey(c);
  const publicModelsUrl = requirePublicModelsUrl(c);
  const billingInput = await buildBillingInput(db, redis, {
    userId,
    models: [model],
    apiKey,
    publicModelsUrl,
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

export const chatRoute = new Hono<AppEnv>()

  .post(
    '/:conversationId/stream',
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
      } = c.req.valid('json');

      // Validate last message
      if (!validateLastMessageIsFromUser(messagesForInference)) {
        return c.json(createErrorResponse(ERROR_CODE_LAST_MESSAGE_NOT_USER), 400);
      }

      // Block link guests from media generation (image/video)
      if ((modality === 'image' || modality === 'video') && linkGuest) {
        return c.json(createErrorResponse(ERROR_CODE_MEDIA_TRIAL_BLOCKED), 403);
      }

      // --- Resolve billing (focused branch) ---
      const apiKey = requireApiKey(c);
      const publicModelsUrl = requirePublicModelsUrl(c);
      const billingContext = linkGuest
        ? await resolveGuestBillingContext(db, redis, {
            member,
            ownerId,
            models,
            conversationId,
            apiKey,
            publicModelsUrl,
          })
        : await resolveUserBillingContext(db, redis, {
            callerId,
            ownerId,
            member,
            models,
            conversationId,
            fundingSource,
            apiKey,
            publicModelsUrl,
          });
      const user = c.get('user');

      // Resolve parentMessageId: fork tip when in a fork, latest message otherwise
      const parentMessageId = await resolveParentMessageId(db, conversationId, forkId);

      if (modality === 'image') {
        return handleImageStreamRequest({
          c,
          conversationId,
          callerId,
          user,
          billingContext,
          models,
          userMessage,
          parentMessageId,
          forkId,
          imageConfig,
        });
      }

      if (modality === 'video') {
        // videoConfig is guaranteed present by the schema refine when modality === 'video'.
        if (!videoConfig) throw new Error('invariant: videoConfig required for video modality');
        return handleVideoStreamRequest({
          c,
          conversationId,
          callerId,
          user,
          billingContext,
          models,
          userMessage,
          parentMessageId,
          forkId,
          videoConfig,
        });
      }

      return handleTextStreamRequest({
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
      });
    }
  )
  .post(
    '/:conversationId/message',
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

      // Save message — free, no billing
      const result = await saveUserOnlyMessage(db, {
        conversationId,
        userId: user.id,
        senderId: user.id,
        messageId,
        content,
        parentMessageId,
      });

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

      const textRequest: TextRequest = {
        modality: 'text',
        model,
        messages: aiMessages,
        ...(safeMaxTokens === undefined ? {} : { maxOutputTokens: safeMaxTokens }),
      };

      return streamSSE(c, async (stream) => {
        const writer = createSSEEventWriter(stream);
        try {
          await writer.writeStart({
            userMessageId: action === 'edit' ? userMessage.id : targetMessageId,
            models: [{ modelId: model, assistantMessageId }],
          });

          const inferenceStream = aiClient.stream(textRequest);

          const result = await collectInferenceEvents(
            inferenceStream,
            writer,
            { modelId: model, assistantMessageId },
            {
              env: c.env,
              conversationId,
              assistantMessageId,
              modelName: model,
            }
          );

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
          await writer.writeError({ message, code: resolveStreamErrorCode(error) });
        } finally {
          await releaseReservation();
        }
      });
    }
  );
