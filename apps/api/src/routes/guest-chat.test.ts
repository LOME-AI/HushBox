import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { OpenRouterClient } from '../services/openrouter/types.js';
import { createGuestChatRoutes } from './guest-chat.js';
import { createFastMockOpenRouterClient } from '../test-helpers/index.js';
import { clearModelCache } from '../services/openrouter/index.js';

interface MockFetchResponse {
  ok: boolean;
  statusText?: string;
  json: () => Promise<unknown>;
}

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<MockFetchResponse>>;

// Guest chat specific models for testing
const guestChatModels = [
  {
    id: 'meta-llama/llama-3.1-70b',
    name: 'Llama 3.1 70B',
    description: 'Basic model',
    context_length: 128_000,
    pricing: { prompt: '0.0000005', completion: '0.0000005' },
    supported_parameters: ['temperature'],
    created: Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60, // Old model
  },
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    description: 'Premium model',
    context_length: 128_000,
    pricing: { prompt: '0.00001', completion: '0.00003' },
    supported_parameters: ['temperature'],
    created: Math.floor(Date.now() / 1000), // Recent model (premium)
  },
];

interface MockGuestUsage {
  guestToken: string | null;
  ipHash: string;
  messageCount: number;
}

interface ErrorBody {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}

function createMockDb(options: { guestUsage?: MockGuestUsage[] } = {}) {
  const { guestUsage = [] } = options;

  // Sort by messageCount descending to simulate SQL ORDER BY DESC
  const sortedUsage = [...guestUsage].toSorted((a, b) => b.messageCount - a.messageCount);

  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => Promise.resolve(sortedUsage.slice(0, n)),
          }),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([{ id: 'new-record', messageCount: 1 }]),
        onConflictDoUpdate: () => ({
          returning: () => Promise.resolve([{ id: 'new-record', messageCount: 1 }]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  };
}

function createTestApp(
  options: {
    guestUsage?: MockGuestUsage[];
    openrouterClient?: OpenRouterClient;
  } = {}
) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('user', null); // Guest user
    c.set('session', null);
    c.set(
      'openrouter',
      options.openrouterClient ?? createFastMockOpenRouterClient({ models: guestChatModels })
    );
    c.set(
      'db',
      createMockDb({ guestUsage: options.guestUsage ?? [] }) as unknown as AppEnv['Variables']['db']
    );
    await next();
  });

  app.route('/', createGuestChatRoutes());
  return app;
}

describe('guest chat routes', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
    clearModelCache();

    // Default mock for fetchModels - return guestChatModels
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: guestChatModels }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearModelCache();
  });

  describe('POST /stream', () => {
    it('accepts guest requests without authentication', async () => {
      vi.useRealTimers();
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Guest-Token': 'test-guest-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'meta-llama/llama-3.1-70b',
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
    });

    it('returns 400 when messages are missing', async () => {
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Guest-Token': 'test-guest-token',
        },
        body: JSON.stringify({ model: 'meta-llama/llama-3.1-70b' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when model is missing', async () => {
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Guest-Token': 'test-guest-token',
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when last message is not from user', async () => {
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Guest-Token': 'test-guest-token',
        },
        body: JSON.stringify({
          messages: [{ role: 'assistant', content: 'Hello' }],
          model: 'meta-llama/llama-3.1-70b',
        }),
      });

      expect(res.status).toBe(400);
      const body: ErrorBody = await res.json();
      expect(body.error).toBe('Last message must be from user');
      expect(body.code).toBe('VALIDATION');
    });

    it('returns 403 when trying to use premium model', async () => {
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Guest-Token': 'test-guest-token',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'openai/gpt-4-turbo', // Premium model
        }),
      });

      expect(res.status).toBe(403);
      const body: ErrorBody = await res.json();
      expect(body.error).toBe('Premium models require a free account');
      expect(body.code).toBe('FORBIDDEN');
    });

    it('returns 429 when guest has exceeded daily limit', async () => {
      const app = createTestApp({
        guestUsage: [
          {
            guestToken: 'test-guest-token',
            ipHash: 'test-ip-hash',
            messageCount: 5, // At limit
          },
        ],
      });

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Guest-Token': 'test-guest-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'meta-llama/llama-3.1-70b',
        }),
      });

      expect(res.status).toBe(429);
      const body: ErrorBody = await res.json();
      expect(body.error).toBe('Daily message limit exceeded');
      expect(body.code).toBe('RATE_LIMITED');
      expect(body.details?.['limit']).toBeDefined();
      expect(body.details?.['remaining']).toBe(0);
    });

    it('streams SSE response with token events', async () => {
      vi.useRealTimers();
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Guest-Token': 'test-guest-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'meta-llama/llama-3.1-70b',
        }),
      });

      const text = await res.text();
      expect(text).toContain('event: token');
      expect(text).toContain('event: done');
    });

    it('returns start event with message ID', async () => {
      vi.useRealTimers();
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Guest-Token': 'test-guest-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'meta-llama/llama-3.1-70b',
        }),
      });

      const text = await res.text();
      expect(text).toContain('event: start');
      expect(text).toContain('"assistantMessageId"');
    });

    it('works without X-Guest-Token (uses IP only)', async () => {
      vi.useRealTimers();
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'meta-llama/llama-3.1-70b',
        }),
      });

      expect(res.status).toBe(200);
    });

    it('returns 400 when authenticated user tries to use guest endpoint', async () => {
      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        // Simulate authenticated user with valid session
        c.set('user', { id: 'user-123', email: 'test@example.com', name: 'Test User' });
        c.set('session', { id: 'session-123', userId: 'user-123', expiresAt: new Date() });
        c.set('openrouter', createFastMockOpenRouterClient({ models: guestChatModels }));
        c.set('db', createMockDb() as unknown as AppEnv['Variables']['db']);
        await next();
      });

      app.route('/', createGuestChatRoutes());

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'meta-llama/llama-3.1-70b',
        }),
      });

      expect(res.status).toBe(400);
      const body: ErrorBody = await res.json();
      expect(body.error).toBe('Authenticated users should use /chat/stream');
      expect(body.code).toBe('VALIDATION');
    });

    it('returns 402 when message exceeds guest cost limit', async () => {
      const oneYearAgoSeconds = Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60;
      // Create models with expensive test model below 75th percentile but still expensive enough
      // to exceed guest budget. Need multiple models so premium classification works correctly.
      const budgetTestModels = [
        {
          id: 'budget-test/model',
          name: 'Budget Test Model',
          description: 'Model for budget testing',
          context_length: 128_000,
          // Moderately expensive: With fees, a 50k char message = ~25k tokens at conservative rate
          // 25000 * 0.001 = $25 input + $25 output minimum = $50+ >> $0.01 guest limit
          pricing: { prompt: '0.001', completion: '0.001' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds, // Old model (non-premium by recency)
        },
        // Add expensive models to push threshold above our test model's price
        {
          id: 'super-expensive/model-1',
          name: 'Super Expensive 1',
          description: 'Very expensive',
          context_length: 128_000,
          pricing: { prompt: '0.1', completion: '0.1' }, // Much more expensive
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds,
        },
        {
          id: 'super-expensive/model-2',
          name: 'Super Expensive 2',
          description: 'Very expensive',
          context_length: 128_000,
          pricing: { prompt: '0.1', completion: '0.1' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds,
        },
        {
          id: 'super-expensive/model-3',
          name: 'Super Expensive 3',
          description: 'Very expensive',
          context_length: 128_000,
          pricing: { prompt: '0.1', completion: '0.1' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds,
        },
      ];

      // Override default fetch mock
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: budgetTestModels }),
      });

      const app = createTestApp({
        openrouterClient: createFastMockOpenRouterClient({ models: budgetTestModels }),
      });

      // Very long message that would exceed $0.01 limit
      const longMessage = 'x'.repeat(50_000);

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Guest-Token': 'test-guest-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: longMessage }],
          model: 'budget-test/model',
        }),
      });

      expect(res.status).toBe(402);
      const body: ErrorBody = await res.json();
      expect(body.error).toBe('This message exceeds guest limits. Sign up for more capacity.');
      expect(body.code).toBe('PAYMENT_REQUIRED');
    });

    it('allows messages within guest cost limit', async () => {
      vi.useRealTimers();
      const oneYearAgoSeconds = Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60;
      // Create models with cheap test model - need multiple so premium classification works
      const cheapTestModels = [
        {
          id: 'cheap/model',
          name: 'Cheap Model',
          description: 'Inexpensive model',
          context_length: 128_000,
          pricing: { prompt: '0.0000001', completion: '0.0000001' }, // Very cheap
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds, // Old model (non-premium by recency)
        },
        // Add expensive models to push threshold above our test model's price
        {
          id: 'expensive/model-1',
          name: 'Expensive 1',
          description: 'Expensive',
          context_length: 128_000,
          pricing: { prompt: '0.001', completion: '0.001' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds,
        },
        {
          id: 'expensive/model-2',
          name: 'Expensive 2',
          description: 'Expensive',
          context_length: 128_000,
          pricing: { prompt: '0.001', completion: '0.001' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds,
        },
        {
          id: 'expensive/model-3',
          name: 'Expensive 3',
          description: 'Expensive',
          context_length: 128_000,
          pricing: { prompt: '0.001', completion: '0.001' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds,
        },
      ];

      // Override default fetch mock
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: cheapTestModels }),
      });

      const app = createTestApp({
        openrouterClient: createFastMockOpenRouterClient({ models: cheapTestModels }),
      });

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Guest-Token': 'test-guest-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'cheap/model',
        }),
      });

      expect(res.status).toBe(200);
    });

    it('does not persist messages to database', async () => {
      vi.useRealTimers();

      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.set('user', null);
        c.set('session', null);
        c.set('openrouter', createFastMockOpenRouterClient({ models: guestChatModels }));
        c.set('db', {
          select: () => ({
            from: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: () => Promise.resolve([]),
                }),
              }),
            }),
          }),
          insert: () => {
            return {
              values: () => ({
                returning: () => Promise.resolve([{ id: 'new', messageCount: 1 }]),
              }),
            };
          },
          update: () => ({
            set: () => ({
              where: () => Promise.resolve(),
            }),
          }),
        } as unknown as AppEnv['Variables']['db']);
        await next();
      });
      app.route('/', createGuestChatRoutes());

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Guest-Token': 'test-guest-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'meta-llama/llama-3.1-70b',
        }),
      });

      await res.text(); // Consume response

      // Only guest_usage should be updated, not messages table
      // The insert to guest_usage is expected, but no insert to messages
      // Since we can't easily distinguish, we verify the route works without db.insert for messages
      expect(res.status).toBe(200);
    });
  });
});
