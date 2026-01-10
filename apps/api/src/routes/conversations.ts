import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { selectConversationSchema, selectMessageSchema } from '@lome-chat/db';
import {
  createConversationRequestSchema,
  updateConversationRequestSchema,
  createMessageRequestSchema,
  errorResponseSchema,
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_NOT_FOUND,
} from '@lome-chat/shared';
import { createErrorResponse } from '../lib/error-response.js';
import { ERROR_UNAUTHORIZED, ERROR_CONVERSATION_NOT_FOUND } from '../constants/errors.js';
import {
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
  createMessage,
} from '../services/conversations/index.js';
import type { AppEnv } from '../types.js';

// Response schemas for OpenAPI documentation
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
  message: selectMessageSchema.optional(),
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

// Route definitions
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
    201: {
      content: { 'application/json': { schema: createConversationResponseSchema } },
      description: 'Conversation created',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
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

/**
 * Creates conversations routes with OpenAPI documentation.
 * Requires dbMiddleware, authMiddleware, and sessionMiddleware to be applied.
 */
export function createConversationsRoutes(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  // GET / - List all conversations for authenticated user
  app.openapi(listConversationsRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');

    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }

    const userConversations = await listConversations(db, user.id);
    return c.json({ conversations: userConversations }, 200);
  });

  // GET /:id - Get single conversation with messages
  app.openapi(getConversationRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');

    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }

    const { id: conversationId } = c.req.valid('param');
    const result = await getConversation(db, conversationId, user.id);

    if (!result) {
      return c.json(createErrorResponse(ERROR_CONVERSATION_NOT_FOUND, ERROR_CODE_NOT_FOUND), 404);
    }

    return c.json(result, 200);
  });

  // POST / - Create a new conversation
  app.openapi(createConversationRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');

    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }

    const body = c.req.valid('json');
    const result = await createConversation(db, user.id, {
      title: body.title,
      firstMessage: body.firstMessage,
    });

    return c.json(result, 201);
  });

  // PATCH /:id - Update conversation (rename)
  app.openapi(updateConversationRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');

    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }

    const { id: conversationId } = c.req.valid('param');
    const body = c.req.valid('json');
    const conversation = await updateConversation(db, conversationId, user.id, {
      title: body.title,
    });

    if (!conversation) {
      return c.json(createErrorResponse(ERROR_CONVERSATION_NOT_FOUND, ERROR_CODE_NOT_FOUND), 404);
    }

    return c.json({ conversation }, 200);
  });

  // DELETE /:id - Delete conversation
  app.openapi(deleteConversationRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');

    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }

    const { id: conversationId } = c.req.valid('param');
    const deleted = await deleteConversation(db, conversationId, user.id);

    if (!deleted) {
      return c.json(createErrorResponse(ERROR_CONVERSATION_NOT_FOUND, ERROR_CODE_NOT_FOUND), 404);
    }

    return c.json({ deleted: true }, 200);
  });

  // POST /:id/messages - Add message to conversation
  app.openapi(createMessageRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');

    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }

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

    return c.json({ message }, 201);
  });

  return app;
}
