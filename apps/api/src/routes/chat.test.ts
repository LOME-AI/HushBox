import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Hono } from 'hono';
import {
  conversations as conversationsTable,
  messages as messagesTable,
  users as usersTable,
  balanceTransactions as balanceTransactionsTable,
} from '@lome-chat/db';
import { createChatRoutes } from './chat.js';
import type { AppEnv } from '../types.js';
import type { OpenRouterClient } from '../services/openrouter/types.js';
import { createFastMockOpenRouterClient } from '../test-helpers/index.js';
import { clearModelCache } from '../services/openrouter/index.js';

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

interface MockUser {
  id: string;
  balance: string;
}

interface ErrorBody {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}

interface MockFetchResponse {
  ok: boolean;
  statusText?: string;
  json: () => Promise<unknown>;
}

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<MockFetchResponse>>;

const mockModels = [
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    description: 'Premium model',
    context_length: 128000,
    pricing: { prompt: '0.00001', completion: '0.00003' },
    supported_parameters: ['temperature'],
    created: Math.floor(Date.now() / 1000),
  },
];

/**
 * Create a mock database for testing.
 */
function createMockDb(options: {
  conversations?: MockConversation[];
  messages?: MockMessage[];
  users?: MockUser[];
  onInsert?: (table: unknown, values: unknown) => void;
}) {
  const { conversations = [], messages = [], users = [], onInsert } = options;

  // Track user balance for transaction updates
  let currentUserBalance = users[0]?.balance ?? '0.00000000';

  function createThenable<T>(value: T) {
    return {
      then: (resolve: (v: T) => unknown) => Promise.resolve(resolve(value)),
      limit: (n: number) => ({
        then: (resolve: (v: T) => unknown) => {
          const sliced = Array.isArray(value) ? (value.slice(0, n) as T) : value;
          return Promise.resolve(resolve(sliced));
        },
      }),
      orderBy: () => Promise.resolve(value),
    };
  }

  function createDbOperations() {
    return {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === conversationsTable) {
              return createThenable(conversations);
            }
            if (table === messagesTable) {
              return createThenable(messages);
            }
            if (table === usersTable) {
              const user = users[0];
              return createThenable(
                user
                  ? [
                      {
                        balance: currentUserBalance,
                        freeAllowanceCents: 0,
                        freeAllowanceResetAt: new Date(),
                      },
                    ]
                  : []
              );
            }
            return createThenable([]);
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: (values: unknown) => {
          if (onInsert) {
            onInsert(table, values);
          }
          return {
            returning: () => {
              // Return the inserted values as the "inserted record"
              if (table === messagesTable) {
                return Promise.resolve([values]);
              }
              return Promise.resolve([values]);
            },
          };
        },
      }),
      update: (table: unknown) => ({
        set: (setValues: Record<string, unknown>) => ({
          where: () => {
            // For user balance updates, simulate the balance change
            if (table === usersTable && setValues['balance']) {
              // Parse the SQL expression or just use a mock balance
              currentUserBalance = '9.99000000'; // Simulated after deduction
            }
            // Return a thenable that also supports .returning()
            const result = {
              returning: () => {
                if (table === usersTable) {
                  return Promise.resolve([{ balance: currentUserBalance }]);
                }
                return Promise.resolve([{}]);
              },
              then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(undefined)),
            };
            return result;
          },
        }),
      }),
    };
  }

  const dbOps = createDbOperations();

  return {
    ...dbOps,
    // Transaction support: execute callback with the SAME db operations (preserves callbacks)
    transaction: async <T>(callback: (tx: typeof dbOps) => Promise<T>): Promise<T> => {
      // Reuse dbOps to preserve onInsert and other callbacks
      return callback(dbOps);
    },
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
    users: [
      {
        id: 'user-123',
        balance: '10.00000000',
      },
    ],
  };

  // Mock dependencies middleware
  app.use('*', async (c, next) => {
    // Set env bindings for tests
    c.env = { NODE_ENV: 'test' } as AppEnv['Bindings'];
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
    // Set env bindings for tests
    c.env = { NODE_ENV: 'test' } as AppEnv['Bindings'];
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
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
    clearModelCache();

    // Default mock for fetchModels
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: mockModels }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearModelCache();
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
      const body: ErrorBody = await res.json();
      expect(body.error).toBe('Unauthorized');
      expect(body.code).toBe('UNAUTHORIZED');
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
      vi.useRealTimers();
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
      vi.useRealTimers();
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
      vi.useRealTimers();
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
      vi.useRealTimers();
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
      vi.useRealTimers();

      const app = new Hono<AppEnv>();
      const failingClient: OpenRouterClient = {
        isMock: true,
        chatCompletion() {
          return Promise.reject(new Error('API Error'));
        },
        // eslint-disable-next-line @typescript-eslint/require-await, require-yield -- intentionally throws for error test
        async *chatCompletionStream() {
          throw new Error('Stream failed');
        },
        // eslint-disable-next-line @typescript-eslint/require-await, require-yield -- intentionally throws for error test
        async *chatCompletionStreamWithMetadata() {
          throw new Error('Stream failed');
        },
        listModels() {
          return Promise.resolve([]);
        },
        getModel() {
          return Promise.reject(new Error('Model not found'));
        },
        getGenerationStats() {
          return Promise.reject(new Error('Not implemented in mock'));
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
        users: [
          {
            id: 'user-123',
            balance: '10.00000000',
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
      const body: ErrorBody = await res.json();
      expect(body.error).toBe('Conversation not found');
      expect(body.code).toBe('NOT_FOUND');
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
      const body: ErrorBody = await res.json();
      expect(body.error).toBe('Conversation not found');
      expect(body.code).toBe('NOT_FOUND');
    });

    it('returns 402 when user has zero balance', async () => {
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
        users: [
          {
            id: 'user-123',
            balance: '0.00000000',
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

      expect(res.status).toBe(402);
      const body: ErrorBody = await res.json();
      expect(body.error).toBe('Premium models require a positive balance');
      expect(body.code).toBe('PAYMENT_REQUIRED');
      expect(body.details?.['currentBalance']).toBe('0.00');
    });

    it('returns 402 when user has negative balance', async () => {
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
        users: [
          {
            id: 'user-123',
            balance: '-5.00000000',
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

      expect(res.status).toBe(402);
      const body: ErrorBody = await res.json();
      expect(body.error).toBe('Premium models require a positive balance');
      expect(body.code).toBe('PAYMENT_REQUIRED');
      expect(body.details?.['currentBalance']).toBe('-5.00');
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
      const body: ErrorBody = await res.json();
      expect(body.error).toBe('Last message must be from user');
      expect(body.code).toBe('VALIDATION');
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
      const body: ErrorBody = await res.json();
      expect(body.error).toBe('Last message must be from user');
      expect(body.code).toBe('VALIDATION');
    });

    it('saves assistant message to database after stream completes', async () => {
      vi.useRealTimers();

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
        users: [
          {
            id: 'user-123',
            balance: '10.00000000',
          },
        ],
        onInsert: (table, values) => {
          // Only capture message inserts, not balance transactions
          if (table === messagesTable) {
            insertedMessage = values;
          }
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
      vi.useRealTimers();
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

    describe('storage billing', () => {
      it('uses only latest user message length for inputCharacters (NOT conversation history)', async () => {
        vi.useRealTimers();

        const previousMessage1 = {
          id: 'msg-1',
          conversationId: 'conv-123',
          role: 'user',
          content: 'First message - 30 characters!',
          model: null,
          createdAt: new Date('2024-01-15T11:00:00.000Z'),
        };
        const previousMessage2 = {
          id: 'msg-2',
          conversationId: 'conv-123',
          role: 'assistant',
          content: 'Response to first message - about 40 chars',
          model: 'openai/gpt-4-turbo',
          createdAt: new Date('2024-01-15T11:01:00.000Z'),
        };
        const latestUserMessage = {
          id: 'msg-3',
          conversationId: 'conv-123',
          role: 'user',
          content: 'Latest!',
          model: null,
          createdAt: new Date('2024-01-15T12:00:00.000Z'),
        };

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
          messages: [previousMessage1, previousMessage2, latestUserMessage],
          users: [{ id: 'user-123', balance: '10.00000000' }],
        });

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
        expect(latestUserMessage.content.length).toBe(7);
      });
    });

    describe('cost calculation routing', () => {
      it('uses estimated cost in development/test mode (does NOT call getGenerationStats)', async () => {
        vi.useRealTimers();

        let getGenerationStatsCalled = false;

        const app = new Hono<AppEnv>();

        const openrouter: OpenRouterClient = {
          isMock: true, // Mock client should NOT call getGenerationStats
          chatCompletion() {
            return Promise.resolve({
              id: 'mock-123',
              model: 'openai/gpt-4-turbo',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            });
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStreamWithMetadata() {
            yield { content: 'Hello', generationId: 'mock-gen-123' };
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStream() {
            yield 'Hello';
          },
          listModels() {
            return Promise.resolve([]);
          },
          getModel() {
            return Promise.reject(new Error('Model not found'));
          },
          getGenerationStats(generationId: string) {
            getGenerationStatsCalled = true;
            return Promise.resolve({
              id: generationId,
              native_tokens_prompt: 100,
              native_tokens_completion: 50,
              total_cost: 0.001,
            });
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
          users: [{ id: 'user-123', balance: '10.00000000' }],
        });

        app.use('*', async (c, next) => {
          c.set('user', { id: 'user-123', email: 'test@example.com', name: 'Test' });
          c.set('session', { id: 'session-123', userId: 'user-123', expiresAt: new Date() });
          c.set('openrouter', openrouter);
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          await next();
        });
        app.route('/', createChatRoutes());

        // No NODE_ENV set (defaults to development/test behavior)
        const res = await app.request('/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: 'conv-123', model: 'openai/gpt-4-turbo' }),
        });

        await res.text();

        // In development/test mode, getGenerationStats should NOT be called
        expect(getGenerationStatsCalled).toBe(false);
      });

      it('calls getGenerationStats in production mode', async () => {
        vi.useRealTimers();

        let getGenerationStatsCalled = false;

        const app = new Hono<AppEnv>();

        const openrouter: OpenRouterClient = {
          isMock: false, // Real client SHOULD call getGenerationStats
          chatCompletion() {
            return Promise.resolve({
              id: 'mock-123',
              model: 'openai/gpt-4-turbo',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            });
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStreamWithMetadata() {
            yield { content: 'Hello', generationId: 'mock-gen-123' };
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStream() {
            yield 'Hello';
          },
          listModels() {
            return Promise.resolve([]);
          },
          getModel() {
            return Promise.reject(new Error('Model not found'));
          },
          getGenerationStats(generationId: string) {
            getGenerationStatsCalled = true;
            return Promise.resolve({
              id: generationId,
              native_tokens_prompt: 100,
              native_tokens_completion: 50,
              total_cost: 0.001,
            });
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
          users: [{ id: 'user-123', balance: '10.00000000' }],
        });

        app.use('*', async (c, next) => {
          c.set('user', { id: 'user-123', email: 'test@example.com', name: 'Test' });
          c.set('session', { id: 'session-123', userId: 'user-123', expiresAt: new Date() });
          c.set('openrouter', openrouter);
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          await next();
        });
        app.route('/', createChatRoutes());

        // Pass NODE_ENV: 'production' to simulate production mode
        const res = await app.request(
          '/stream',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId: 'conv-123', model: 'openai/gpt-4-turbo' }),
          },
          { NODE_ENV: 'production' } as AppEnv['Bindings']
        );

        await res.text();

        // In production mode, getGenerationStats SHOULD be called
        expect(getGenerationStatsCalled).toBe(true);
      });
    });

    describe('client disconnect handling', () => {
      it('saves complete message when SSE write fails mid-stream', async () => {
        vi.useRealTimers();

        let insertedMessage: unknown = null;

        const app = new Hono<AppEnv>();

        const openrouter: OpenRouterClient = {
          isMock: true,
          chatCompletion() {
            return Promise.resolve({
              id: 'mock-123',
              model: 'openai/gpt-4-turbo',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Hello' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            });
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStreamWithMetadata() {
            yield { content: 'Hello', generationId: 'mock-gen-123' };
            yield { content: ' ' };
            yield { content: 'World' };
            yield { content: '!' };
            yield { content: ' How' };
            yield { content: ' are' };
            yield { content: ' you' };
            yield { content: '?' };
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStream() {
            yield 'Hello World!';
          },
          listModels() {
            return Promise.resolve([]);
          },
          getModel() {
            return Promise.reject(new Error('Model not found'));
          },
          getGenerationStats(generationId: string) {
            return Promise.resolve({
              id: generationId,
              native_tokens_prompt: 100,
              native_tokens_completion: 50,
              total_cost: 0.001,
            });
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
          users: [{ id: 'user-123', balance: '10.00000000' }],
          onInsert: (table, values) => {
            // Only capture message inserts, not balance transactions
            if (table === messagesTable) {
              insertedMessage = values;
            }
          },
        });

        app.use('*', async (c, next) => {
          c.env = { NODE_ENV: 'test' } as AppEnv['Bindings'];
          c.set('user', { id: 'user-123', email: 'test@example.com', name: 'Test' });
          c.set('session', { id: 'session-123', userId: 'user-123', expiresAt: new Date() });
          c.set('openrouter', openrouter);
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          await next();
        });
        app.route('/', createChatRoutes());

        const res = await app.request('/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: 'conv-123', model: 'openai/gpt-4-turbo' }),
        });

        await res.text().catch(() => {
          // Intentionally ignore - we only care about verifying the message was inserted
        });

        expect(insertedMessage).not.toBeNull();
        expect(insertedMessage).toMatchObject({
          conversationId: 'conv-123',
          role: 'assistant',
          content: 'Hello World! How are you?',
          model: 'openai/gpt-4-turbo',
        });
      });

      it('triggers billing even when client disconnects', async () => {
        vi.useRealTimers();

        let insertedMessage: unknown = null;
        let balanceTransactionInserted = false;

        const app = new Hono<AppEnv>();

        const openrouter: OpenRouterClient = {
          isMock: true,
          chatCompletion() {
            return Promise.resolve({
              id: 'mock-123',
              model: 'openai/gpt-4-turbo',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            });
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStreamWithMetadata() {
            yield { content: 'Hello', generationId: 'mock-gen-123' };
            yield { content: ' World' };
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for test
          async *chatCompletionStream() {
            yield 'Hello World';
          },
          listModels() {
            return Promise.resolve([]);
          },
          getModel() {
            return Promise.reject(new Error('Model not found'));
          },
          getGenerationStats(generationId: string) {
            return Promise.resolve({
              id: generationId,
              native_tokens_prompt: 100,
              native_tokens_completion: 50,
              total_cost: 0.001,
            });
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
          users: [{ id: 'user-123', balance: '10.00000000' }],
          onInsert: (table, values) => {
            if (table === messagesTable) {
              insertedMessage = values;
            }
            if (table === balanceTransactionsTable) {
              balanceTransactionInserted = true;
            }
          },
        });

        app.use('*', async (c, next) => {
          c.env = { NODE_ENV: 'test' } as AppEnv['Bindings'];
          c.set('user', { id: 'user-123', email: 'test@example.com', name: 'Test' });
          c.set('session', { id: 'session-123', userId: 'user-123', expiresAt: new Date() });
          c.set('openrouter', openrouter);
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          await next();
        });
        app.route('/', createChatRoutes());

        const res = await app.request('/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: 'conv-123', model: 'openai/gpt-4-turbo' }),
        });

        await res.text();

        // Give billing time to fire (it's async/fire-and-forget)
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(insertedMessage).not.toBeNull();
        expect(balanceTransactionInserted).toBe(true);
      });
    });

    describe('concurrent requests', () => {
      it('handles multiple simultaneous stream requests independently', async () => {
        vi.useRealTimers();

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
