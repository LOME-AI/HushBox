import { Hono } from 'hono';
import { eq, desc, and } from 'drizzle-orm';
import type { createDb } from '@lome-chat/db';
import { conversations, messages } from '@lome-chat/db';
import type { createAuth } from '../auth/index.js';

type Db = ReturnType<typeof createDb>;
type Auth = ReturnType<typeof createAuth>;

interface User {
  id: string;
  email: string;
  name: string;
}

interface Env {
  Variables: {
    user: User | null;
    session: unknown;
  };
}

export function createConversationsRoutes(
  db: Db,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future auth middleware
  _auth: Auth
): Hono<Env> {
  const app = new Hono<Env>();

  // GET / - List all conversations for authenticated user
  app.get('/', async (c) => {
    const user = c.get('user');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const userConversations = await db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, user.id))
      .orderBy(desc(conversations.updatedAt));

    return c.json({ conversations: userConversations });
  });

  // GET /:id - Get single conversation with messages
  app.get('/:id', async (c) => {
    const user = c.get('user');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const conversationId = c.req.param('id');

    // Get conversation and verify ownership
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)));

    if (!conversation) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    // Get messages for conversation
    const conversationMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt);

    return c.json({ conversation, messages: conversationMessages });
  });

  return app;
}

// Legacy placeholder export for backwards compatibility during migration
export const conversationsRoute = new Hono()
  .get('/', (c) => c.json({ error: 'Not implemented' }, 501))
  .post('/', (c) => c.json({ error: 'Not implemented' }, 501))
  .get('/:id', (c) => c.json({ error: 'Not implemented' }, 501))
  .delete('/:id', (c) => c.json({ error: 'Not implemented' }, 501))
  .patch('/:id', (c) => c.json({ error: 'Not implemented' }, 501));
