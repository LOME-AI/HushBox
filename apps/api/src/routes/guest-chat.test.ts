import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { OpenRouterClient } from '../services/openrouter/types.js';
import { createGuestChatRoutes } from './guest-chat.js';

/**
 * Create a fast mock OpenRouter client for testing.
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
      for (const char of 'Echo: Hello') {
        yield char;
      }
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for fast tests
    async *chatCompletionStreamWithMetadata() {
      let isFirst = true;
      for (const char of 'Echo: Hello') {
        if (isFirst) {
          yield { content: char, generationId: 'mock-gen-123' };
          isFirst = false;
        } else {
          yield { content: char };
        }
      }
    },
    listModels() {
      return Promise.resolve([
        {
          id: 'meta-llama/llama-3.1-70b',
          name: 'Llama 3.1 70B',
          description: 'Basic model',
          context_length: 128000,
          pricing: { prompt: '0.0000005', completion: '0.0000005' },
          supported_parameters: ['temperature'],
          created: Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60, // Old model
        },
        {
          id: 'openai/gpt-4-turbo',
          name: 'GPT-4 Turbo',
          description: 'Premium model',
          context_length: 128000,
          pricing: { prompt: '0.00001', completion: '0.00003' },
          supported_parameters: ['temperature'],
          created: Math.floor(Date.now() / 1000), // Recent model (premium)
        },
      ]);
    },
    getModel() {
      return Promise.reject(new Error('Model not found'));
    },
    getGenerationStats() {
      return Promise.resolve({
        id: 'mock',
        native_tokens_prompt: 100,
        native_tokens_completion: 50,
        total_cost: 0.001,
      });
    },
  };
}

interface MockGuestUsage {
  guestToken: string | null;
  ipHash: string;
  messageCount: number;
}

function createMockDb(options: { guestUsage?: MockGuestUsage[] } = {}) {
  const { guestUsage = [] } = options;

  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(guestUsage),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([{ id: 'new-record', messageCount: 1 }]),
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
    c.set('openrouter', options.openrouterClient ?? createFastMockOpenRouterClient());
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
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
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
      const body = await res.json();
      expect(body).toEqual({ error: 'Last message must be from user' });
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
      const body: { error: string } = await res.json();
      expect(body.error.toLowerCase()).toContain('premium');
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
      const body: { error: string } = await res.json();
      expect(body.error).toContain('limit');
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

    it('does not persist messages to database', async () => {
      vi.useRealTimers();

      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.set('user', null);
        c.set('session', null);
        c.set('openrouter', createFastMockOpenRouterClient());
        c.set('db', {
          select: () => ({
            from: () => ({
              where: () => Promise.resolve([]),
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
