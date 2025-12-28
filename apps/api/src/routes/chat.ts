import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { eq, asc } from 'drizzle-orm';
import { conversations, messages } from '@lome-chat/db';
import type { AppEnv } from '../types.js';
import type { ChatMessage } from '../services/openrouter/types.js';
import { buildPrompt } from '../services/prompt/builder.js';

const errorSchema = z.object({
  error: z.string(),
});

const streamChatRequestSchema = z.object({
  conversationId: z.string(),
  model: z.string(),
});

const streamChatRoute = createRoute({
  method: 'post',
  path: '/stream',
  request: {
    body: {
      content: {
        'application/json': {
          schema: streamChatRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'SSE stream of chat response tokens',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid request (e.g., last message not from user)',
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

export function createChatRoutes(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(streamChatRoute, async (c) => {
    const user = c.get('user');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { conversationId, model } = c.req.valid('json');
    const db = c.get('db');
    const openrouter = c.get('openrouter');

    const conversation = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!conversation) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    if (conversation.userId !== user.id) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    const messageHistory = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));

    const lastMessage = messageHistory[messageHistory.length - 1];
    if (lastMessage?.role !== 'user') {
      return c.json({ error: 'Last message must be from user' }, 400);
    }

    const assistantMessageId = crypto.randomUUID();

    // TODO: Remove empty capabilities when Python/JavaScript execution is implemented.
    // Currently we don't have sandbox execution, so don't send tools to avoid
    // the model trying to use them. When ready, check model.supported_parameters
    // to determine which capabilities to enable.
    const { systemPrompt } = buildPrompt({
      modelId: model,
      supportedCapabilities: [],
    });

    const openRouterMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messageHistory.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
    ];

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'start',
        data: JSON.stringify({
          userMessageId: lastMessage.id,
          assistantMessageId,
        }),
      });

      let fullContent = '';

      try {
        for await (const token of openrouter.chatCompletionStream({
          model,
          messages: openRouterMessages,
        })) {
          fullContent += token;
          await stream.writeSSE({
            event: 'token',
            data: JSON.stringify({ content: token }),
          });
        }

        await db.insert(messages).values({
          id: assistantMessageId,
          conversationId,
          role: 'assistant',
          content: fullContent,
          model,
        });

        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({}),
        });
      } catch (error) {
        // Send error event - do NOT save partial message
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: errorMessage, code: 'STREAM_ERROR' }),
        });
      }
    });
  });

  return app;
}

export const chatRoute = createChatRoutes();
