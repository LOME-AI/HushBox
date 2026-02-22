import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { OpenRouterClient } from '../services/openrouter/types.js';
import { trialChatRoute } from './trial-chat.js';
import { createFastMockOpenRouterClient } from '../test-helpers/index.js';

interface MockFetchResponse {
  ok: boolean;
  statusText?: string;
  json: () => Promise<unknown>;
}

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<MockFetchResponse>>;

/** Build a URL-aware fetch mock that handles both /models and /endpoints/zdr. */
function buildFetchMock(fetchMock: FetchMock, models: typeof trialChatModels): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/endpoints/zdr')) {
      const zdrEndpoints = models.map((m) => ({
        model_id: m.id,
        model_name: m.name,
        provider_name: 'Provider',
        context_length: m.context_length,
        pricing: m.pricing,
      }));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: zdrEndpoints }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data: models }),
    });
  });
}

// Trial chat specific models for testing
const trialChatModels = [
  {
    id: 'meta-llama/llama-3.1-70b',
    name: 'Llama 3.1 70B',
    description: 'Basic model',
    context_length: 128_000,
    pricing: { prompt: '0.0000005', completion: '0.0000005' },
    supported_parameters: ['temperature'],
    created: Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60, // Old model
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    description: 'Premium model',
    context_length: 128_000,
    pricing: { prompt: '0.00001', completion: '0.00003' },
    supported_parameters: ['temperature'],
    created: Math.floor(Date.now() / 1000), // Recent model (premium)
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
];

interface ErrorBody {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}

function createMockRedis(nextIncrValue = 1) {
  return {
    get: vi.fn().mockResolvedValue(null),
    mget: vi.fn().mockResolvedValue([null, null]),
    incr: vi.fn().mockResolvedValue(nextIncrValue),
    expire: vi.fn().mockResolvedValue(true),
  };
}

function createTestApp(
  options: {
    trialMessageCount?: number;
    openrouterClient?: OpenRouterClient;
  } = {}
) {
  const app = new Hono<AppEnv>();

  // For the atomic consumeTrialMessage, the INCR return value represents the count
  // AFTER incrementing. So trialMessageCount=5 means 5 prior messages -> INCR returns 6 (over limit).
  // trialMessageCount=0 (default) means no prior messages -> INCR returns 1 (within limit).
  const nextIncrValue = (options.trialMessageCount ?? 0) + 1;

  app.use('*', async (c, next) => {
    c.set('user', null); // Trial user
    c.set('session', null);
    c.set(
      'openrouter',
      options.openrouterClient ?? createFastMockOpenRouterClient({ models: trialChatModels })
    );
    c.set('redis', createMockRedis(nextIncrValue) as unknown as AppEnv['Variables']['redis']);
    c.set('db', {} as unknown as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', trialChatRoute);
  return app;
}

describe('trial chat routes', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));

    // Default mock for fetchModels + fetchZdrModelIds
    buildFetchMock(fetchMock, trialChatModels);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('POST /stream', () => {
    it('accepts trial requests without authentication', async () => {
      vi.useRealTimers();
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
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
          'X-Trial-Token': 'test-trial-token',
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
          'X-Trial-Token': 'test-trial-token',
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
          'X-Trial-Token': 'test-trial-token',
        },
        body: JSON.stringify({
          messages: [{ role: 'assistant', content: 'Hello' }],
          model: 'meta-llama/llama-3.1-70b',
        }),
      });

      expect(res.status).toBe(400);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('VALIDATION');
    });

    it('returns 403 when trying to use premium model', async () => {
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'openai/gpt-4-turbo', // Premium model
        }),
      });

      expect(res.status).toBe(403);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('PREMIUM_REQUIRES_ACCOUNT');
    });

    it('returns 429 when trial user has exceeded daily limit', async () => {
      const app = createTestApp({
        trialMessageCount: 5, // At limit (TRIAL_MESSAGE_LIMIT)
      });

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'meta-llama/llama-3.1-70b',
        }),
      });

      expect(res.status).toBe(429);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('DAILY_LIMIT_EXCEEDED');
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
          'X-Trial-Token': 'test-trial-token',
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
          'X-Trial-Token': 'test-trial-token',
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

    it('works without X-Trial-Token (uses IP only)', async () => {
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

    it('returns 400 when authenticated user tries to use trial endpoint', async () => {
      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        // Simulate authenticated user with valid session
        c.set('user', {
          id: 'user-123',
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          publicKey: new Uint8Array(32),
        });
        c.set('session', {
          sessionId: 'session-123',
          userId: 'user-123',
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          pending2FA: false,
          pending2FAExpiresAt: 0,
          createdAt: Date.now(),
        });
        c.set('openrouter', createFastMockOpenRouterClient({ models: trialChatModels }));
        c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
        c.set('db', {} as unknown as AppEnv['Variables']['db']);
        await next();
      });

      app.route('/', trialChatRoute);

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
      expect(body.code).toBe('AUTHENTICATED_ON_TRIAL');
    });

    it('returns 402 when message exceeds trial cost limit', async () => {
      const oneYearAgoSeconds = Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60;
      // Create models with expensive test model below 75th percentile but still expensive enough
      // to exceed trial budget. Need multiple models so premium classification works correctly.
      const budgetTestModels = [
        {
          id: 'budget-test/model',
          name: 'Budget Test Model',
          description: 'Model for budget testing',
          context_length: 128_000,
          // Moderately expensive: With fees, a 50k char message = ~25k tokens at conservative rate
          // 25000 * 0.001 = $25 input + $25 output minimum = $50+ >> $0.01 trial limit
          pricing: { prompt: '0.001', completion: '0.001' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds, // Old model (non-premium by recency)
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
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
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'super-expensive/model-2',
          name: 'Super Expensive 2',
          description: 'Very expensive',
          context_length: 128_000,
          pricing: { prompt: '0.1', completion: '0.1' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'super-expensive/model-3',
          name: 'Super Expensive 3',
          description: 'Very expensive',
          context_length: 128_000,
          pricing: { prompt: '0.1', completion: '0.1' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
      ];

      // Override default fetch mock
      buildFetchMock(fetchMock, budgetTestModels);

      const app = createTestApp({
        openrouterClient: createFastMockOpenRouterClient({ models: budgetTestModels }),
      });

      // Very long message that would exceed $0.01 limit
      const longMessage = 'x'.repeat(50_000);

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: longMessage }],
          model: 'budget-test/model',
        }),
      });

      expect(res.status).toBe(402);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('TRIAL_MESSAGE_TOO_EXPENSIVE');
    });

    it('allows messages within trial cost limit', async () => {
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
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
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
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'expensive/model-2',
          name: 'Expensive 2',
          description: 'Expensive',
          context_length: 128_000,
          pricing: { prompt: '0.001', completion: '0.001' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'expensive/model-3',
          name: 'Expensive 3',
          description: 'Expensive',
          context_length: 128_000,
          pricing: { prompt: '0.001', completion: '0.001' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
      ];

      // Override default fetch mock
      buildFetchMock(fetchMock, cheapTestModels);

      const app = createTestApp({
        openrouterClient: createFastMockOpenRouterClient({ models: cheapTestModels }),
      });

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
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
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'meta-llama/llama-3.1-70b',
        }),
      });

      await res.text(); // Consume response

      // Trial chat uses Redis for usage tracking, not the database
      // No database operations should occur for trial messages
      expect(res.status).toBe(200);
    });
  });
});
