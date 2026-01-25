import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { selectConversationSchema, selectMessageSchema } from '@lome-chat/db';
import {
  createConversationRequestSchema,
  updateConversationRequestSchema,
  createMessageRequestSchema,
  errorResponseSchema,
  ERROR_CODE_NOT_FOUND,
  ERROR_CODE_UNAUTHORIZED,
} from '@lome-chat/shared';
import { createErrorResponse } from '../lib/error-response.js';
import { ERROR_CONVERSATION_NOT_FOUND, ERROR_UNAUTHORIZED } from '../constants/errors.js';
import { requireAuth } from '../middleware/require-auth.js';
import {
  listConversations,
  getConversation,
  createOrGetConversation,
  updateConversation,
  deleteConversation,
  createMessage,
} from '../services/conversations/index.js';
import type { AppEnv } from '../types.js';

const errorSchema = errorResponseSchema;

const conversationsListResponseSchema = z.object({
  conversations: z.array(selectConversationSchema),
});

const conversationDetailResponseSchema = z.object({
  conversation: selectConversationSchema,
  messages: z.array(selectMessageSchema),
});

const createConversationResponseSchema = z.object({
  conversation: selectConversationSchema,
  message: selectMessageSchema.optional(), // First message when newly created
  messages: z.array(selectMessageSchema).optional(), // All messages when returning existing
  isNew: z.boolean(), // true = 201 Created, false = 200 OK (idempotent return)
});

const updateConversationResponseSchema = z.object({
  conversation: selectConversationSchema,
});

const deleteConversationResponseSchema = z.object({
  deleted: z.boolean(),
});

const createMessageResponseSchema = z.object({
  message: selectMessageSchema,
});

const listConversationsRoute = createRoute({
  method: 'get',
  path: '/',
  responses: {
    200: {
      content: { 'application/json': { schema: conversationsListResponseSchema } },
      description: 'List of conversations for authenticated user',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
  },
});

const getConversationRoute = createRoute({
  method: 'get',
  path: '/{id}',
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationDetailResponseSchema } },
      description: 'Conversation with messages',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Conversation not found',
    },
  },
});

const createConversationRoute = createRoute({
  method: 'post',
  path: '/',
  request: {
    body: {
      content: {
        'application/json': {
          schema: createConversationRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: createConversationResponseSchema } },
      description: 'Existing conversation returned (idempotent)',
    },
    201: {
      content: { 'application/json': { schema: createConversationResponseSchema } },
      description: 'Conversation created',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Conversation ID exists but belongs to another user',
    },
  },
});

const updateConversationRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: updateConversationRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: updateConversationResponseSchema } },
      description: 'Conversation updated',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid request',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Conversation not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal server error',
    },
  },
});

const deleteConversationRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: deleteConversationResponseSchema } },
      description: 'Conversation deleted',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Conversation not found',
    },
  },
});

const createMessageRoute = createRoute({
  method: 'post',
  path: '/{id}/messages',
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: createMessageRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: createMessageResponseSchema } },
      description: 'Message created',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid request',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Conversation not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal server error',
    },
  },
});

export function createConversationsRoutes(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.use('*', requireAuth());

  app.openapi(listConversationsRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');

    const userConversations = await listConversations(db, user.id);
    const response = conversationsListResponseSchema.parse({ conversations: userConversations });
    return c.json(response, 200);
  });

  app.openapi(getConversationRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
    const { id: conversationId } = c.req.valid('param');

    const result = await getConversation(db, conversationId, user.id);
    if (!result) {
      return c.json(createErrorResponse(ERROR_CONVERSATION_NOT_FOUND, ERROR_CODE_NOT_FOUND), 404);
    }

    const response = conversationDetailResponseSchema.parse(result);
    return c.json(response, 200);
  });

  app.openapi(createConversationRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
    const body = c.req.valid('json');

    const result = await createOrGetConversation(db, user.id, {
      id: body.id,
      title: body.title,
      firstMessage: body.firstMessage,
    });

    // Service returns null = ID exists but belongs to different user
    if (!result) {
      return c.json(createErrorResponse(ERROR_CONVERSATION_NOT_FOUND, ERROR_CODE_NOT_FOUND), 404);
    }

    const response = createConversationResponseSchema.parse(result);
    // HTTP status based on whether new or existing
    const status = result.isNew ? 201 : 200;
    return c.json(response, status);
  });

  app.openapi(updateConversationRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
    const { id: conversationId } = c.req.valid('param');
    const body = c.req.valid('json');

    const conversation = await updateConversation(db, conversationId, user.id, {
      title: body.title,
    });

    if (!conversation) {
      return c.json(createErrorResponse(ERROR_CONVERSATION_NOT_FOUND, ERROR_CODE_NOT_FOUND), 404);
    }

    const response = updateConversationResponseSchema.parse({ conversation });
    return c.json(response, 200);
  });

  app.openapi(deleteConversationRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
    const { id: conversationId } = c.req.valid('param');

    const deleted = await deleteConversation(db, conversationId, user.id);
    if (!deleted) {
      return c.json(createErrorResponse(ERROR_CONVERSATION_NOT_FOUND, ERROR_CODE_NOT_FOUND), 404);
    }

    const response = deleteConversationResponseSchema.parse({ deleted: true });
    return c.json(response, 200);
  });

  app.openapi(createMessageRoute, async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }
    const db = c.get('db');
    const { id: conversationId } = c.req.valid('param');
    const body = c.req.valid('json');

    const message = await createMessage(db, conversationId, user.id, {
      role: body.role,
      content: body.content,
      model: body.model,
    });

    if (!message) {
      return c.json(createErrorResponse(ERROR_CONVERSATION_NOT_FOUND, ERROR_CODE_NOT_FOUND), 404);
    }

    const response = createMessageResponseSchema.parse({ message });
    return c.json(response, 201);
  });

  return app;
}
