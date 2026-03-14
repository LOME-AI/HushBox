import { Hono } from 'hono';
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
  estimateTokenCount,
} from '@hushbox/shared';
import type { FundingSource } from '@hushbox/shared';
import type { AppEnv, Bindings } from '../types.js';
import { buildPrompt } from '../services/prompt/builder.js';
import {
  buildBillingInput,
  buildGuestBillingInput,
  calculateMessageCost,
} from '../services/billing/index.js';
import type { MemberContext } from '../services/billing/index.js';
import { ContextCapacityError } from '../services/openrouter/openrouter.js';
import {
  validateLastMessageIsFromUser,
  buildOpenRouterMessages,
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
import { broadcastToRoom } from '../lib/broadcast.js';
import { createEvent } from '@hushbox/realtime/events';
import { releaseBudget, releaseGroupBudget } from '../lib/speculative-balance.js';
import {
  resolveAndReserveBilling,
  executeStreamPipeline,
  resolveWebSearchCost,
  buildOpenRouterRequest,
  BATCH_INTERVAL_MS,
} from '../lib/stream-pipeline.js';
import type { BroadcastContext, StreamResult } from '../lib/stream-pipeline.js';

// Re-export for existing test imports
export { computeWorstCaseCents } from '../lib/stream-pipeline.js';

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
  void broadcastToRoom(
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

// eslint-disable-next-line sonarjs/cognitive-complexity -- streaming loop with broadcast batching is inherently nested
async function collectStreamTokens(
  tokenStream: AsyncIterable<{ content: string; generationId?: string }>,
  writer: SSEEventWriter,
  modelContext: { modelId: string; assistantMessageId: string },
  broadcast?: BroadcastContext
): Promise<StreamResult> {
  const { modelId, assistantMessageId: modelAssistantMessageId } = modelContext;
  let fullContent = '';
  let generationId: string | undefined;
  let error: Error | null = null;
  let tokenBuffer = '';
  let lastBroadcastTime = Date.now();

  try {
    for await (const token of tokenStream) {
      if (token.generationId) {
        generationId = token.generationId;
      }
      fullContent += token.content;
      await writer.writeModelToken({ modelId, content: token.content });

      if (broadcast) {
        tokenBuffer += token.content;
        if (Date.now() - lastBroadcastTime >= BATCH_INTERVAL_MS) {
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
          lastBroadcastTime = Date.now();
        }
      }
    }
  } catch (error_) {
    error = error_ instanceof Error ? error_ : new Error('Unknown error');
  }

  // Flush remaining buffered tokens
  if (broadcast && tokenBuffer) {
    void broadcastToRoom(
      broadcast.env,
      broadcast.conversationId,
      createEvent('message:stream', {
        messageId: broadcast.assistantMessageId,
        token: tokenBuffer,
        ...(broadcast.modelName !== undefined && { modelName: broadcast.modelName }),
      })
    );
  }

  if (!error) {
    await writer.writeModelDone({ modelId, assistantMessageId: modelAssistantMessageId, cost: '0' });
  }

  return { fullContent, generationId, error };
}

export const chatRoute = new Hono<AppEnv>()

  .post(
    '/:conversationId/stream',
    zValidator('json', streamChatRequestSchema),
    requirePrivilege('write', { allowLinkGuest: true, includeOwnerId: true }),
    async (c) => {
      const { conversationId } = c.req.param();
      const callerId = c.get('callerId');
      const member = c.get('member');
      const linkGuest = c.get('linkGuest');
      const ownerId = c.get('conversationOwnerId');
      const db = c.get('db');
      const redis = c.get('redis');

      const {
        models,
        userMessage,
        messagesForInference,
        fundingSource,
        webSearchEnabled = false,
        customInstructions,
        forkId,
      } = c.req.valid('json');

      // Validate last message
      if (!validateLastMessageIsFromUser(messagesForInference)) {
        return c.json(createErrorResponse(ERROR_CODE_LAST_MESSAGE_NOT_USER), 400);
      }

      // --- Resolve billing (focused branch) ---
      let memberContext: MemberContext | undefined;
      let billingUserId: string;
      let clientFundingSource: FundingSource;
      let billingResult: Awaited<ReturnType<typeof buildBillingInput>>;

      if (linkGuest) {
        memberContext = { memberId: member.id, ownerId };
        billingUserId = ownerId;
        clientFundingSource = 'owner_balance';
        billingResult = await buildGuestBillingInput(db, redis, {
          ownerId,
          memberId: member.id,
          models,
          conversationId,
        });
      } else {
        const isOwner = callerId === ownerId;
        memberContext = isOwner ? undefined : { memberId: member.id, ownerId };
        billingUserId = callerId;
        clientFundingSource = fundingSource;
        billingResult = await buildBillingInput(db, redis, {
          userId: callerId,
          models,
          ...(memberContext !== undefined && { memberContext }),
          conversationId,
        });
      }

      // --- Unified billing validation + stream ---
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
      const user = c.get('user');
      const releaseReservation = groupBudget
        ? (): Promise<void> => releaseGroupBudget(redis, groupBudget)
        : user
          ? (): Promise<void> => releaseBudget(redis, user.id, worstCaseCents)
          : (): Promise<void> => Promise.resolve();

      // Resolve parentMessageId: fork tip when in a fork, latest message otherwise
      const parentMessageId = await resolveParentMessageId(db, conversationId, forkId);

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
  )
  .post(
    '/:conversationId/message',
    zValidator('json', userOnlyMessageSchema),
    requirePrivilege('write', { includeOwnerId: true }),
    async (c) => {
      const user = c.get('user')!;
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
      const broadcastPromise = broadcastToRoom(
        c.env,
        conversationId,
        createEvent('message:new', {
          messageId,
          conversationId,
          senderType: 'user',
          senderId: user.id,
        })
      );

      try {
        // eslint-disable-next-line promise/prefer-await-to-then -- waitUntil requires a non-awaited promise; catch prevents unhandled rejection
        c.executionCtx.waitUntil(broadcastPromise.catch(() => null));
      } catch {
        // executionCtx unavailable outside Workers runtime
      }

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
      const user = c.get('user')!;
      const { conversationId } = c.req.param();
      const ownerId = c.get('conversationOwnerId');
      const member = c.get('member');
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
      const openrouter = c.get('openrouter');

      // 1. Validate last message is from user
      if (!validateLastMessageIsFromUser(messagesForInference)) {
        return c.json(createErrorResponse(ERROR_CODE_LAST_MESSAGE_NOT_USER), 400);
      }

      // 2. If forkId provided, look up fork's tip message ID
      let forkTipMessageId: string | undefined;
      if (forkId) {
        const [fork] = await db
          .select({ tipMessageId: conversationForks.tipMessageId })
          .from(conversationForks)
          .where(eq(conversationForks.id, forkId));

        if (!fork) {
          return c.json(createErrorResponse(ERROR_CODE_FORK_NOT_FOUND), 404);
        }
        forkTipMessageId = fork.tipMessageId ?? undefined;
      }

      // 3. Check regeneration guard (group chats: blocked if other user replied after target)
      const allowed = await canRegenerate(db, {
        conversationId,
        targetMessageId,
        userId: user.id,
        ...(forkTipMessageId !== undefined && { forkTipMessageId }),
      });
      if (!allowed) {
        return c.json(createErrorResponse(ERROR_CODE_REGENERATION_BLOCKED_BY_OTHER_USER), 403);
      }

      // 4. Validate billing
      const redis = c.get('redis');
      const billingInput = await buildBillingInput(db, redis, {
        userId: user.id,
        models: [model],
        ...(memberContext !== undefined && { memberContext }),
        conversationId,
      });

      const billingValidation = await resolveAndReserveBilling(c, {
        billingResult: billingInput,
        userId: user.id,
        models: [model],
        messagesForInference,
        clientFundingSource: fundingSource,
        ...(memberContext !== undefined && { memberContext }),
        conversationId,
        webSearchEnabled,
        ...(customInstructions !== undefined && { customInstructions }),
      });
      if (!billingValidation.success) {
        return billingValidation.response;
      }
      const { safeMaxTokens, openrouterModels, worstCaseCents, groupBudget, billingUserId } =
        billingValidation;

      const webSearchCost = resolveWebSearchCost(webSearchEnabled, model, openrouterModels);

      const releaseReservation = groupBudget
        ? (): Promise<void> => releaseGroupBudget(redis, groupBudget)
        : (): Promise<void> => releaseBudget(redis, user.id, worstCaseCents);

      const assistantMessageId = crypto.randomUUID();

      const { systemPrompt } = buildPrompt({
        modelId: model,
        supportedCapabilities: [],
        ...(customInstructions !== undefined && { customInstructions }),
      });

      const openRouterMessages = buildOpenRouterMessages(systemPrompt, messagesForInference);
      const lastInferenceMessage = messagesForInference.at(-1);

      const openRouterRequest = buildOpenRouterRequest(
        model,
        openRouterMessages,
        safeMaxTokens,
        webSearchEnabled,
        billingValidation.autoRouterAllowedModels
      );

      return streamSSE(c, async (stream) => {
        const writer = createSSEEventWriter(stream);
        try {
          await writer.writeStart({
            userMessageId: action === 'edit' ? userMessage.id : targetMessageId,
            models: [{ modelId: model, assistantMessageId }],
          });

          const tokenStream = openrouter.chatCompletionStreamWithMetadata(openRouterRequest);

          const result = await collectStreamTokens(tokenStream, writer, { modelId: model, assistantMessageId }, {
            env: c.env,
            conversationId,
            assistantMessageId,
            modelName: model,
          });

          if (result.error) {
            const code =
              result.error instanceof ContextCapacityError
                ? ERROR_CODE_CONTEXT_LENGTH_EXCEEDED
                : ERROR_CODE_STREAM_ERROR;
            await writer.writeError({ message: result.error.message, code });
            return;
          }

          if (result.fullContent.length === 0) {
            await writer.writeError({
              message: 'No content generated',
              code: ERROR_CODE_STREAM_ERROR,
            });
            return;
          }

          const modelInfo = openrouterModels.find((m) => m.id === model);
          const totalCost = await calculateMessageCost({
            openrouter,
            modelInfo,
            generationId: result.generationId,
            inputContent: lastInferenceMessage?.content ?? '',
            outputContent: result.fullContent,
            webSearchCost,
          });

          const inputTokens = estimateTokenCount(lastInferenceMessage?.content ?? '');
          const outputTokens = estimateTokenCount(result.fullContent);

          const groupBillingContext =
            memberContext !== undefined && billingValidation.groupBudget !== undefined
              ? { memberId: memberContext.memberId }
              : undefined;

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
              ...(groupBillingContext !== undefined && { groupBillingContext }),
              ...(forkId !== undefined && { forkId }),
              ...(forkTipMessageId !== undefined && { forkTipMessageId }),
            });

            await broadcastAndWriteCompletion({
              writer,
              env: c.env,
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
              ...(groupBillingContext !== undefined && { groupBillingContext }),
              ...(forkId !== undefined && { forkId }),
              ...(forkTipMessageId !== undefined && { forkTipMessageId }),
            });

            await broadcastAndWriteCompletion({
              writer,
              env: c.env,
              conversationId,
              assistantMessageId,
              model,
              aiSequence: regenResult.aiSequence,
              epochNumber: regenResult.epochNumber,
              cost: regenResult.cost,
              userMessageId: targetMessageId,
            });
          }
        } catch (error) {
          const code =
            error instanceof ContextCapacityError
              ? ERROR_CODE_CONTEXT_LENGTH_EXCEEDED
              : ERROR_CODE_STREAM_ERROR;
          const message = error instanceof Error ? error.message : 'Unknown error';
          await writer.writeError({ message, code });
        } finally {
          await releaseReservation();
        }
      });
    }
  );
