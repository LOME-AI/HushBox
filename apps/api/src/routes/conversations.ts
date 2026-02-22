import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  createConversationRequestSchema,
  updateConversationRequestSchema,
  conversationResponseSchema,
  messageResponseSchema,
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_CONVERSATION_NOT_FOUND,
  toBase64,
  fromBase64,
} from '@hushbox/shared';
import type { Conversation, Message } from '@hushbox/db';
import { createErrorResponse } from '../lib/error-response.js';
import { requireAuth } from '../middleware/require-auth.js';
import {
  listConversations,
  getConversation,
  createOrGetConversation,
  updateConversation,
  deleteConversation,
} from '../services/conversations/index.js';
import type { AppEnv } from '../types.js';

/** Serialize a conversation entity for API responses. */
function serializeConversation(conv: Conversation): z.infer<typeof conversationResponseSchema> {
  return {
    id: conv.id,
    userId: conv.userId,
    title: toBase64(conv.title),
    currentEpoch: conv.currentEpoch,
    titleEpochNumber: conv.titleEpochNumber,
    nextSequence: conv.nextSequence,
    createdAt: conv.createdAt.toISOString(),
    updatedAt: conv.updatedAt.toISOString(),
  };
}

/** Serialize a message entity for API responses. */
function serializeMessage(msg: Message): z.infer<typeof messageResponseSchema> {
  return {
    id: msg.id,
    conversationId: msg.conversationId,
    encryptedBlob: toBase64(msg.encryptedBlob),
    // DB CHECK constraint guarantees senderType IN ('user', 'ai')
    senderType: msg.senderType as 'user' | 'ai',
    senderId: msg.senderId ?? null,
    senderDisplayName: msg.senderDisplayName ?? null,
    payerId: msg.payerId ?? null,
    cost: msg.cost ?? null,
    epochNumber: msg.epochNumber,
    sequenceNumber: msg.sequenceNumber,
    createdAt: msg.createdAt.toISOString(),
  };
}

export const conversationsRoute = new Hono<AppEnv>()
  .use('*', requireAuth())
  .get('/', async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');

    const userConversations = await listConversations(db, user.id);
    return c.json(
      {
        conversations: userConversations.map(
          ({ conversation, acceptedAt, invitedByUsername, privilege }) => ({
            ...serializeConversation(conversation),
            accepted: acceptedAt !== null,
            invitedByUsername,
            privilege,
          })
        ),
      },
      200
    );
  })
  .get('/:id', zValidator('param', z.object({ id: z.string() })), async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
    const { id: conversationId } = c.req.valid('param');

    const result = await getConversation(db, conversationId, user.id);
    if (!result) {
      return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
    }

    return c.json(
      {
        conversation: serializeConversation(result.conversation),
        messages: result.messages.map((msg) => serializeMessage(msg)),
        accepted: result.acceptedAt !== null,
        invitedByUsername: result.invitedByUsername,
      },
      200
    );
  })
  .post('/', zValidator('json', createConversationRequestSchema), async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
    const body = c.req.valid('json');

    const result = await createOrGetConversation(db, user.id, {
      id: body.id,
      title: body.title ? fromBase64(body.title) : undefined,
      epochPublicKey: fromBase64(body.epochPublicKey),
      confirmationHash: fromBase64(body.confirmationHash),
      memberWrap: fromBase64(body.memberWrap),
      userPublicKey: user.publicKey,
    });

    // Service returns null = ID exists but belongs to different user
    if (!result) {
      return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
    }

    const response = {
      conversation: serializeConversation(result.conversation),
      messages: result.messages?.map((msg) => serializeMessage(msg)),
      isNew: result.isNew,
      accepted: true as const, // creator is always auto-accepted
      invitedByUsername: null as string | null,
    };

    // HTTP status based on whether new or existing
    const status = result.isNew ? 201 : 200;
    return c.json(response, status);
  })
  .patch(
    '/:id',
    zValidator('param', z.object({ id: z.string() })),
    zValidator('json', updateConversationRequestSchema),
    async (c) => {
      const user = c.get('user');
      if (!user) {
        return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
      }
      const db = c.get('db');
      const { id: conversationId } = c.req.valid('param');
      const body = c.req.valid('json');

      const conversation = await updateConversation(db, conversationId, user.id, {
        title: fromBase64(body.title),
        titleEpochNumber: body.titleEpochNumber,
      });

      if (!conversation) {
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }

      return c.json(
        {
          conversation: serializeConversation(conversation),
          accepted: true as const, // only owner can update, always accepted
          invitedByUsername: null as string | null,
        },
        200
      );
    }
  )
  .delete('/:id', zValidator('param', z.object({ id: z.string() })), async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
    const { id: conversationId } = c.req.valid('param');

    const deleted = await deleteConversation(db, conversationId, user.id);
    if (!deleted) {
      return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
    }

    return c.json({ deleted: true }, 200);
  });
