import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { conversations as conversationsTable, messages as messagesTable } from '@lome-chat/db';
import { createChatRoutes } from './chat.js';
import type { AppEnv } from '../types.js';
import type { OpenRouterClient } from '../services/openrouter/types.js';

/**
 * Create a fast mock OpenRouter client for testing (no delays).
 */
function createFastMockOpenRouterClient(): OpenRouterClient {
  return {
    chatCompletion() {
      return Promise.resolve({
        id: 'mock-123',
        model: 'openai/gpt-4-turbo',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Echo: Hello' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for fast tests
    async *chatCompletionStream() {
      // Yield tokens without delay for fast tests
      for (const char of 'Echo: Hello') {
        yield char;
      }
    },
    listModels() {
      return Promise.resolve([]);
    },
    getModel() {
      return Promise.reject(new Error('Model not found'));
    },
  };
}

interface MockConversation {
  id: string;
  userId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

interface MockMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  model: string | null;
  createdAt: Date;
}

/**
 * Create a mock database for testing.
 */
function createMockDb(options: {
  conversations?: MockConversation[];
  messages?: MockMessage[];
  onInsert?: (table: unknown, values: unknown) => void;
}) {
  const { conversations = [], messages = [], onInsert } = options;

  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: (n: number) => ({
            then: (cb: (rows: unknown[]) => unknown) => {
              if (table === conversationsTable) {
                return Promise.resolve(cb(conversations.slice(0, n)));
              }
              return Promise.resolve(cb([]));
            },
          }),
          orderBy: () => Promise.resolve(table === messagesTable ? messages : []),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        if (onInsert) {
          onInsert(table, values);
        }
        return Promise.resolve();
      },
    }),
  };
}

function createTestApp(dbOptions?: Parameters<typeof createMockDb>[0]) {
  const app = new Hono<AppEnv>();
  const mockUser = {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
  };
  const mockSession = {
    id: 'session-123',
    userId: 'user-123',
    expiresAt: new Date(Date.now() + 86400000),
  };

  const defaultDbOptions = {
    conversations: [
      {
        id: 'conv-123',
        userId: 'user-123',
        title: 'Test Conversation',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    messages: [
      {
        id: 'msg-1',
        conversationId: 'conv-123',
        role: 'user',
        content: 'Hello',
        model: null,
        createdAt: new Date(),
      },
    ],
  };

  // Mock dependencies middleware
  app.use('*', async (c, next) => {
    c.set('user', mockUser);
    c.set('session', mockSession);
    c.set('openrouter', createFastMockOpenRouterClient());
    c.set(
      'db',
      createMockDb(dbOptions ?? defaultDbOptions) as unknown as AppEnv['Variables']['db']
    );
    await next();
  });

  app.route('/', createChatRoutes());
  return app;
}

function createUnauthenticatedTestApp() {
  const app = new Hono<AppEnv>();

  // Mock dependencies middleware without user
  app.use('*', async (c, next) => {
    c.set('user', null);
    c.set('session', null);
    c.set('openrouter', createFastMockOpenRouterClient());
    c.set('db', createMockDb({}) as unknown as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', createChatRoutes());
  return app;
}

describe('chat routes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('POST /stream', () => {
    it('returns 401 for unauthenticated requests', async () => {
      const app = createUnauthenticatedTestApp();
      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conv-123',
          model: 'openai/gpt-4-turbo',
        }),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    it('returns 400 when conversationId is missing', async () => {
      const app = createTestApp();
      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai/gpt-4-turbo' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when model is missing', async () => {
      const app = createTestApp();
      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 'conv-123' }),
      });

      expect(res.status).toBe(400);
    });

    it('streams SSE response for valid request', async () => {
      vi.useRealTimers(); // SSE streaming needs real timers
      const app = createTestApp();
      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conv-123',
          model: 'openai/gpt-4-turbo',
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(res.headers.get('cache-control')).toBe('no-cache');
    });

    it('returns start event with assistantMessageId', async () => {
      vi.useRealTimers(); // SSE streaming needs real timers
      const app = createTestApp();
      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conv-123',
          model: 'openai/gpt-4-turbo',
        }),
      });

      const text = await res.text();
      expect(text).toContain('event: start');
      expect(text).toContain('"assistantMessageId"');
    });

    it('returns token events with content', async () => {
      vi.useRealTimers(); // SSE streaming needs real timers
      const app = createTestApp();
      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conv-123',
          model: 'openai/gpt-4-turbo',
        }),
      });

      const text = await res.text();
      expect(text).toContain('event: token');
      expect(text).toContain('"content"');
    });

    it('returns done event at the end', async () => {
      vi.useRealTimers(); // SSE streaming needs real timers
      const app = createTestApp();
      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conv-123',
          model: 'openai/gpt-4-turbo',
        }),
      });

      const text = await res.text();
      expect(text).toContain('event: done');
    });

    it('returns error event when stream fails', async () => {
      vi.useRealTimers(); // SSE streaming needs real timers

      // Create app with a failing OpenRouter client
      const app = new Hono<AppEnv>();
      const failingClient: OpenRouterClient = {
        chatCompletion() {
          return Promise.reject(new Error('API Error'));
        },
        // eslint-disable-next-line @typescript-eslint/require-await, require-yield -- intentionally throws for error test
        async *chatCompletionStream() {
          throw new Error('Stream failed');
        },
        listModels() {
          return Promise.resolve([]);
        },
        getModel() {
          return Promise.reject(new Error('Model not found'));
        },
      };

      const mockDb = createMockDb({
        conversations: [
          {
            id: 'conv-123',
            userId: 'user-123',
            title: 'Test',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        messages: [
          {
            id: 'msg-1',
            conversationId: 'conv-123',
            role: 'user',
            content: 'Hello',
            model: null,
            createdAt: new Date(),
          },
        ],
      });

      app.use('*', async (c, next) => {
        c.set('user', { id: 'user-123', email: 'test@example.com', name: 'Test' });
        c.set('session', { id: 'session-123', userId: 'user-123', expiresAt: new Date() });
        c.set('openrouter', failingClient);
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        await next();
      });
      app.route('/', createChatRoutes());

      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conv-123',
          model: 'openai/gpt-4-turbo',
        }),
      });

      const text = await res.text();
      expect(text).toContain('event: error');
      expect(text).toContain('Stream failed');
    });

    it('returns 404 when conversation not found', async () => {
      const app = createTestApp({ conversations: [], messages: [] });
      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'nonexistent',
          model: 'openai/gpt-4-turbo',
        }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ error: 'Conversation not found' });
    });

    it('returns 404 when conversation belongs to another user', async () => {
      const app = createTestApp({
        conversations: [
          {
            id: 'conv-123',
            userId: 'other-user',
            title: 'Test',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        messages: [],
      });

      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conv-123',
          model: 'openai/gpt-4-turbo',
        }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ error: 'Conversation not found' });
    });

    it('returns 400 when last message is not from user', async () => {
      const app = createTestApp({
        conversations: [
          {
            id: 'conv-123',
            userId: 'user-123',
            title: 'Test',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        messages: [
          {
            id: 'msg-1',
            conversationId: 'conv-123',
            role: 'assistant',
            content: 'Hello there!',
            model: 'openai/gpt-4-turbo',
            createdAt: new Date(),
          },
        ],
      });

      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conv-123',
          model: 'openai/gpt-4-turbo',
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({ error: 'Last message must be from user' });
    });

    it('returns 400 when conversation has no messages', async () => {
      const app = createTestApp({
        conversations: [
          {
            id: 'conv-123',
            userId: 'user-123',
            title: 'Test',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        messages: [],
      });

      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conv-123',
          model: 'openai/gpt-4-turbo',
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({ error: 'Last message must be from user' });
    });

    it('saves assistant message to database after stream completes', async () => {
      vi.useRealTimers(); // SSE streaming needs real timers

      let insertedMessage: unknown = null;

      const app = createTestApp({
        conversations: [
          {
            id: 'conv-123',
            userId: 'user-123',
            title: 'Test',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        messages: [
          {
            id: 'msg-1',
            conversationId: 'conv-123',
            role: 'user',
            content: 'Hello',
            model: null,
            createdAt: new Date(),
          },
        ],
        onInsert: (_table, values) => {
          insertedMessage = values;
        },
      });

      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conv-123',
          model: 'openai/gpt-4-turbo',
        }),
      });

      // Consume the stream to trigger the insert
      await res.text();

      expect(insertedMessage).not.toBeNull();
      expect(insertedMessage).toMatchObject({
        conversationId: 'conv-123',
        role: 'assistant',
        content: 'Echo: Hello',
        model: 'openai/gpt-4-turbo',
      });
    });

    it('includes userMessageId in start event', async () => {
      vi.useRealTimers(); // SSE streaming needs real timers
      const app = createTestApp();
      const res = await app.request('/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conv-123',
          model: 'openai/gpt-4-turbo',
        }),
      });

      const text = await res.text();
      expect(text).toContain('event: start');
      expect(text).toContain('"userMessageId":"msg-1"');
    });

    describe('concurrent requests', () => {
      it('handles multiple simultaneous stream requests independently', async () => {
        vi.useRealTimers(); // SSE streaming needs real timers

        const app = createTestApp();

        // Start two concurrent stream requests
        const [res1, res2] = await Promise.all([
          app.request('/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              conversationId: 'conv-123',
              model: 'openai/gpt-4-turbo',
            }),
          }),
          app.request('/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              conversationId: 'conv-123',
              model: 'openai/gpt-4-turbo',
            }),
          }),
        ]);

        // Both should succeed (200 status)
        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);

        // Both should return SSE content
        const [text1, text2] = await Promise.all([res1.text(), res2.text()]);

        expect(text1).toContain('event: start');
        expect(text1).toContain('event: done');
        expect(text2).toContain('event: start');
        expect(text2).toContain('event: done');
      });
    });
  });
});
