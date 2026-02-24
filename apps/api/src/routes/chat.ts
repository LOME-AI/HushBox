import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { streamSSE } from 'hono/streaming';
import { and, eq, isNull } from 'drizzle-orm';
import { conversations, conversationMembers, type Database } from '@hushbox/db';
import {
  streamChatRequestSchema,
  userOnlyMessageSchema,
  ERROR_CODE_INSUFFICIENT_BALANCE,
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_BILLING_MISMATCH,
  ERROR_CODE_CONVERSATION_NOT_FOUND,
  ERROR_CODE_LAST_MESSAGE_NOT_USER,
  ERROR_CODE_PREMIUM_REQUIRES_BALANCE,
  ERROR_CODE_BALANCE_RESERVED,
  ERROR_CODE_PRIVILEGE_INSUFFICIENT,
  calculateBudget,
  applyFees,
  buildSystemPrompt,
  estimateTokenCount,
  estimateTokensForTier,
  effectiveBudgetCents,
  resolveBilling,
  canSendMessages,
  getCushionCents,
  charsPerTokenForTier,
  MINIMUM_OUTPUT_TOKENS,
  STORAGE_COST_PER_CHARACTER,
} from '@hushbox/shared';
import type { FundingSource, DenialReason, ResolveBillingInput } from '@hushbox/shared';
import type { AppEnv, Bindings } from '../types.js';
import { buildPrompt } from '../services/prompt/builder.js';
import { buildBillingInput, calculateMessageCost } from '../services/billing/index.js';
import type { MemberContext } from '../services/billing/index.js';
import { fetchModels } from '../services/openrouter/index.js';
import { ContextCapacityError } from '../services/openrouter/openrouter.js';
import {
  validateLastMessageIsFromUser,
  buildOpenRouterMessages,
  saveChatTurn,
  saveUserOnlyMessage,
} from '../services/chat/index.js';
import type { SaveChatTurnResult } from '../services/chat/index.js';
import { computeSafeMaxTokens } from '../services/chat/max-tokens.js';
import { createErrorResponse } from '../lib/error-response.js';
import { createSSEEventWriter } from '../lib/stream-handler.js';
import { requireAuth } from '../middleware/require-auth.js';
import { broadcastToRoom } from '../lib/broadcast.js';
import { createEvent } from '@hushbox/realtime/events';
import {
  reserveBudget,
  releaseBudget,
  reserveGroupBudget,
  releaseGroupBudget,
  type GroupBudgetReservation,
} from '../lib/speculative-balance.js';
import type { Context } from 'hono';

interface MessageForInference {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatValidationSuccess {
  success: true;
  memberContext?: MemberContext;
}

interface ChatValidationFailure {
  success: false;
  response: Response;
}

interface ChatValidationOptions {
  c: Context<AppEnv>;
  conversationId: string;
  userId: string;
  messagesForInference: MessageForInference[];
}

async function validateChatRequest(
  options: ChatValidationOptions
): Promise<ChatValidationSuccess | ChatValidationFailure> {
  const { c, conversationId, userId, messagesForInference } = options;
  const db = c.get('db');

  const conversation = await db
    .select({
      userId: conversations.userId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!conversation) {
    return {
      success: false,
      response: c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404),
    };
  }

  // Determine access: owner or active member
  let memberContext: MemberContext | undefined;
  if (conversation.userId !== userId) {
    const member = await db
      .select({
        id: conversationMembers.id,
        privilege: conversationMembers.privilege,
      })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
          isNull(conversationMembers.leftAt)
        )
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!member) {
      return {
        success: false,
        response: c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404),
      };
    }

    if (!canSendMessages(member.privilege)) {
      return {
        success: false,
        response: c.json(createErrorResponse(ERROR_CODE_PRIVILEGE_INSUFFICIENT), 403),
      };
    }

    memberContext = { memberId: member.id, ownerId: conversation.userId };
  }

  if (!validateLastMessageIsFromUser(messagesForInference)) {
    return {
      success: false,
      response: c.json(createErrorResponse(ERROR_CODE_LAST_MESSAGE_NOT_USER), 400),
    };
  }

  return { success: true, ...(memberContext !== undefined && { memberContext }) };
}

interface BillingValidationSuccess {
  success: true;
  billingInput: ResolveBillingInput;
  budgetResult: ReturnType<typeof calculateBudget>;
  safeMaxTokens: number | undefined;
  openrouterModels: Awaited<ReturnType<typeof fetchModels>>;
  worstCaseCents: number;
  groupBudget?: GroupBudgetReservation;
  billingUserId: string;
}

interface BillingValidationFailure {
  success: false;
  response: Response;
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

interface ModelPricing {
  inputPricePerToken: number;
  outputPricePerToken: number;
  rawInputPricePerToken: number;
  rawOutputPricePerToken: number;
  contextLength: number;
}

function getModelPricing(
  models: Awaited<ReturnType<typeof fetchModels>>,
  modelId: string
): ModelPricing {
  const modelInfo = models.find((m) => m.id === modelId);
  const rawInputPricePerToken = modelInfo ? Number.parseFloat(modelInfo.pricing.prompt) : 0;
  const rawOutputPricePerToken = modelInfo ? Number.parseFloat(modelInfo.pricing.completion) : 0;
  const inputPricePerToken = applyFees(rawInputPricePerToken);
  const outputPricePerToken = applyFees(rawOutputPricePerToken);
  const contextLength = modelInfo?.context_length ?? 128_000;

  return {
    inputPricePerToken,
    outputPricePerToken,
    rawInputPricePerToken,
    rawOutputPricePerToken,
    contextLength,
  };
}

interface ValidateBillingInput {
  userId: string;
  model: string;
  messagesForInference: MessageForInference[];
  clientFundingSource: FundingSource;
  memberContext?: MemberContext;
  conversationId?: string;
}

// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- billing validation has inherent branching (denial, mismatch, budget computation, reservation)
async function validateBilling(
  c: Context<AppEnv>,
  input: ValidateBillingInput
): Promise<BillingValidationSuccess | BillingValidationFailure> {
  const {
    userId,
    model,
    messagesForInference,
    clientFundingSource,
    memberContext,
    conversationId,
  } = input;
  const db = c.get('db');
  const redis = c.get('redis');

  // 1. Fetch models for pricing (cached — no extra cost even though buildBillingInput also calls it)
  const openrouterModels = await fetchModels();
  const pricing = getModelPricing(openrouterModels, model);

  // 2. Compute estimated minimum cost for resolveBilling affordability check
  // Uses 'paid' tier for optimistic lower bound — if even this can't be afforded, deny early
  const systemPromptForBudget = buildSystemPrompt([]);
  const historyCharacters = messagesForInference.reduce((sum, m) => sum + m.content.length, 0);
  const promptCharacterCount = systemPromptForBudget.length + historyCharacters;
  const estimatedInputTokens = estimateTokensForTier('paid', promptCharacterCount);
  const preCheckCharsPerToken = charsPerTokenForTier('paid');
  const inputStorageCostCents = promptCharacterCount * STORAGE_COST_PER_CHARACTER * 100;
  const outputStorageCostCents =
    MINIMUM_OUTPUT_TOKENS * preCheckCharsPerToken * STORAGE_COST_PER_CHARACTER * 100;
  const estimatedMinimumCostCents = Math.ceil(
    (estimatedInputTokens * pricing.inputPricePerToken +
      MINIMUM_OUTPUT_TOKENS * pricing.outputPricePerToken) *
      100 +
      inputStorageCostCents +
      outputStorageCostCents
  );

  // 3. Gather all billing data and resolve billing decision
  const billingResult = await buildBillingInput(db, redis, {
    userId,
    model,
    estimatedMinimumCostCents,
    ...(memberContext !== undefined && { memberContext }),
    ...(conversationId !== undefined && { conversationId }),
  });
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

  // 6. Compute budget for maxOutputTokens based on payer
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
    modelInputPricePerToken: pricing.inputPricePerToken,
    modelOutputPricePerToken: pricing.outputPricePerToken,
    modelContextLength: pricing.contextLength,
  });

  const safeMaxTokens = computeSafeMaxTokens({
    budgetMaxTokens: budgetResult.maxOutputTokens,
    modelContextLength: pricing.contextLength,
    estimatedInputTokens: budgetResult.estimatedInputTokens,
  });

  // 7. Calculate worst case cost for reservation (derived from budget — single source of truth)
  const effectiveMaxOutputTokens =
    safeMaxTokens ?? pricing.contextLength - budgetResult.estimatedInputTokens;
  const worstCaseCents = Math.ceil(
    (budgetResult.estimatedInputCost + effectiveMaxOutputTokens * budgetResult.outputCostPerToken) *
      100
  );

  // 8. Reserve budget
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
    };
  }

  // Personal budget reservation with race guard
  const newTotalReserved = await reserveBudget(redis, userId, worstCaseCents);
  const finalEffective = billingResult.rawUserBalanceCents - newTotalReserved;
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
  };
}

interface StreamResult {
  fullContent: string;
  generationId: string | undefined;
  error: Error | null;
}

type SSEEventWriter = ReturnType<typeof createSSEEventWriter>;

interface BroadcastContext {
  env: Bindings;
  conversationId: string;
  assistantMessageId: string;
}

const BATCH_INTERVAL_MS = 100;

// eslint-disable-next-line sonarjs/cognitive-complexity -- streaming loop with broadcast batching is inherently nested
async function collectStreamTokens(
  tokenStream: AsyncIterable<{ content: string; generationId?: string }>,
  writer: SSEEventWriter,
  broadcast?: BroadcastContext
): Promise<StreamResult> {
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
      await writer.writeToken(token.content);

      if (broadcast) {
        tokenBuffer += token.content;
        if (Date.now() - lastBroadcastTime >= BATCH_INTERVAL_MS) {
          void broadcastToRoom(
            broadcast.env,
            broadcast.conversationId,
            createEvent('message:stream', {
              messageId: broadcast.assistantMessageId,
              token: tokenBuffer,
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
      })
    );
  }

  return { fullContent, generationId, error };
}

interface BillingOptions {
  openrouter: AppEnv['Variables']['openrouter'];
  openrouterModels: Awaited<ReturnType<typeof fetchModels>>;
  model: string;
  generationId: string | undefined;
  lastUserMessageContent: string;
  fullContent: string;
  db: Database;
  userMessageId: string;
  userContent: string;
  assistantMessageId: string;
  conversationId: string;
  userId: string;
  /** conversation_members.id — present only when a member uses the owner's balance. */
  groupMemberId?: string;
}

async function processBillingAfterStream(options: BillingOptions): Promise<SaveChatTurnResult> {
  const {
    openrouter,
    openrouterModels,
    model,
    generationId,
    lastUserMessageContent,
    fullContent,
    db,
    userMessageId,
    userContent,
    assistantMessageId,
    conversationId,
    userId,
    groupMemberId,
  } = options;

  const modelInfo = openrouterModels.find((m) => m.id === model);
  const totalCost = await calculateMessageCost({
    openrouter,
    modelInfo,
    generationId,
    inputContent: lastUserMessageContent,
    outputContent: fullContent,
  });

  const inputTokens = estimateTokenCount(lastUserMessageContent);
  const outputTokens = estimateTokenCount(fullContent);

  return saveChatTurn(db, {
    userMessageId,
    userContent,
    assistantMessageId,
    assistantContent: fullContent,
    conversationId,
    model,
    userId,
    totalCost,
    inputTokens,
    outputTokens,
    ...(groupMemberId !== undefined && {
      groupBillingContext: { memberId: groupMemberId },
    }),
  });
}

interface HandleBillingOptions {
  c: Context<AppEnv>;
  billingPromise: Promise<SaveChatTurnResult>;
  assistantMessageId: string;
  userId: string;
  model: string;
  generationId: string | undefined;
}

async function handleBillingResult(
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
}

async function broadcastAndFinish(options: BroadcastAndFinishOptions): Promise<void> {
  const { c, conversationId, userMessageId, assistantMessageId, billingResult, writer } = options;

  const broadcastPromise = broadcastToRoom(
    c.env,
    conversationId,
    createEvent('message:complete', {
      messageId: assistantMessageId,
      conversationId,
      sequenceNumber: billingResult.aiSequence,
      epochNumber: billingResult.epochNumber,
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

export const chatRoute = new Hono<AppEnv>()
  .use('*', requireAuth())
  .post('/stream', zValidator('json', streamChatRequestSchema), async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
    }
    const { conversationId, model, userMessage, messagesForInference, fundingSource } =
      c.req.valid('json');
    const db = c.get('db');
    const openrouter = c.get('openrouter');

    const chatValidation = await validateChatRequest({
      c,
      conversationId,
      userId: user.id,
      messagesForInference,
    });
    if (!chatValidation.success) {
      return chatValidation.response;
    }

    const billingValidation = await validateBilling(c, {
      userId: user.id,
      model,
      messagesForInference,
      clientFundingSource: fundingSource,
      ...(chatValidation.memberContext !== undefined && {
        memberContext: chatValidation.memberContext,
      }),
      conversationId,
    });
    if (!billingValidation.success) {
      return billingValidation.response;
    }
    const { safeMaxTokens, openrouterModels, worstCaseCents, groupBudget, billingUserId } =
      billingValidation;
    const redis = c.get('redis');

    // Build the appropriate release function for this request
    const releaseReservation = groupBudget
      ? (): Promise<void> => releaseGroupBudget(redis, groupBudget)
      : (): Promise<void> => releaseBudget(redis, user.id, worstCaseCents);

    const assistantMessageId = crypto.randomUUID();

    const { systemPrompt } = buildPrompt({
      modelId: model,
      supportedCapabilities: [],
    });

    const openRouterMessages = buildOpenRouterMessages(systemPrompt, messagesForInference);
    const lastInferenceMessage = messagesForInference.at(-1);

    // Early broadcast: notify other group members of user's message (fire-and-forget)
    // Content is plaintext from inference messages — server already has it for LLM
    const lastContent = lastInferenceMessage?.content ?? '';
    void broadcastToRoom(
      c.env,
      conversationId,
      createEvent('message:new', {
        messageId: userMessage.id,
        conversationId,
        senderType: 'user',
        senderId: user.id,
        content: lastContent,
      })
    );

    return streamSSE(c, async (stream) => {
      const writer = createSSEEventWriter(stream);
      try {
        await writer.writeStart({
          userMessageId: userMessage.id,
          assistantMessageId,
        });

        const tokenStream = openrouter.chatCompletionStreamWithMetadata({
          model,
          messages: openRouterMessages,
          ...(safeMaxTokens !== undefined && { max_tokens: safeMaxTokens }),
        });

        const result = await collectStreamTokens(tokenStream, writer, {
          env: c.env,
          conversationId,
          assistantMessageId,
        });

        if (result.error) {
          const code =
            result.error instanceof ContextCapacityError
              ? 'context_length_exceeded'
              : 'STREAM_ERROR';
          await writer.writeError({ message: result.error.message, code });
          return;
        }

        if (result.fullContent.length === 0) {
          await writer.writeError({ message: 'No content generated', code: 'STREAM_ERROR' });
          return;
        }

        const billingPromise = processBillingAfterStream({
          openrouter,
          openrouterModels,
          model,
          generationId: result.generationId,
          lastUserMessageContent: lastInferenceMessage?.content ?? '',
          fullContent: result.fullContent,
          db,
          userMessageId: userMessage.id,
          userContent: userMessage.content,
          assistantMessageId,
          conversationId,
          userId: billingUserId,
          ...(chatValidation.memberContext !== undefined &&
            billingValidation.groupBudget !== undefined && {
              groupMemberId: chatValidation.memberContext.memberId,
            }),
        });

        const billingResult = await handleBillingResult({
          c,
          billingPromise,
          assistantMessageId,
          userId: billingUserId,
          model,
          generationId: result.generationId,
        });

        if (billingResult) {
          await broadcastAndFinish({
            c,
            conversationId,
            userMessageId: userMessage.id,
            assistantMessageId,
            billingResult,
            writer,
          });
        } else {
          await writer.writeError({ message: 'Failed to save message', code: 'BILLING_ERROR' });
        }
      } finally {
        await releaseReservation();
      }
    });
  })
  .post('/message', zValidator('json', userOnlyMessageSchema), async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
    }

    const { conversationId, messageId, content } = c.req.valid('json');
    const db = c.get('db');

    // Validate conversation access (owner or active member with write privilege)
    const conversation = await db
      .select({
        userId: conversations.userId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!conversation) {
      return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
    }

    if (conversation.userId !== user.id) {
      const member = await db
        .select({
          id: conversationMembers.id,
          privilege: conversationMembers.privilege,
        })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, user.id),
            isNull(conversationMembers.leftAt)
          )
        )
        .limit(1)
        .then((rows) => rows[0]);

      if (!member) {
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }

      if (!canSendMessages(member.privilege)) {
        return c.json(createErrorResponse(ERROR_CODE_PRIVILEGE_INSUFFICIENT), 403);
      }
    }

    // Save message — free, no billing
    const result = await saveUserOnlyMessage(db, {
      conversationId,
      userId: user.id,
      messageId,
      content,
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
  });
