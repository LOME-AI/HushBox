import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createMockOpenRouterClient } from './mock.js';
import type { ChatCompletionRequest, MockOpenRouterClient, StreamToken } from './types.js';

describe('createMockOpenRouterClient', () => {
  let client: MockOpenRouterClient;

  beforeEach(() => {
    client = createMockOpenRouterClient();
  });

  describe('factory function', () => {
    it('returns a MockOpenRouterClient', () => {
      expect(client).toBeDefined();
      expect(typeof client.chatCompletion).toBe('function');
      expect(typeof client.chatCompletionStream).toBe('function');
      expect(typeof client.listModels).toBe('function');
      expect(typeof client.getModel).toBe('function');
      expect(typeof client.getCompletionHistory).toBe('function');
      expect(typeof client.clearHistory).toBe('function');
    });
  });

  describe('chatCompletion', () => {
    it('echoes the last user message', async () => {
      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello, world!' },
        ],
      };

      const response = await client.chatCompletion(request);
      const firstChoice = response.choices[0];

      expect(firstChoice).toBeDefined();
      if (firstChoice) {
        expect(firstChoice.message.content).toBe('Echo:\n\nHello, world!');
        expect(firstChoice.message.role).toBe('assistant');
      }
    });

    it('handles no user message gracefully', async () => {
      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'system', content: 'You are helpful.' }],
      };

      const response = await client.chatCompletion(request);
      const firstChoice = response.choices[0];

      expect(firstChoice).toBeDefined();
      if (firstChoice) {
        expect(firstChoice.message.content).toBe('Echo:\n\nNo message');
      }
    });

    it('returns the requested model in response', async () => {
      const request: ChatCompletionRequest = {
        model: 'anthropic/claude-3.5-sonnet',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const response = await client.chatCompletion(request);

      expect(response.model).toBe('anthropic/claude-3.5-sonnet');
    });

    it('returns valid response structure', async () => {
      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Test' }],
      };

      const response = await client.chatCompletion(request);
      const firstChoice = response.choices[0];

      expect(response.id).toMatch(/^mock-\d+$/);
      expect(response.choices).toHaveLength(1);
      expect(firstChoice).toBeDefined();
      if (firstChoice) {
        expect(firstChoice.index).toBe(0);
        expect(firstChoice.finish_reason).toBe('stop');
      }
      expect(response.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
    });

    it('stores requests in history', async () => {
      const request1: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'First' }],
      };
      const request2: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Second' }],
      };

      await client.chatCompletion(request1);
      await client.chatCompletion(request2);

      const history = client.getCompletionHistory();
      expect(history).toHaveLength(2);
      const firstRequest = history[0];
      const secondRequest = history[1];
      expect(firstRequest).toBeDefined();
      expect(secondRequest).toBeDefined();
      if (firstRequest && secondRequest) {
        const firstMessage = firstRequest.messages[0];
        const secondMessage = secondRequest.messages[0];
        expect(firstMessage).toBeDefined();
        expect(secondMessage).toBeDefined();
        if (firstMessage && secondMessage) {
          expect(firstMessage.content).toBe('First');
          expect(secondMessage.content).toBe('Second');
        }
      }
    });
  });

  describe('getCompletionHistory', () => {
    it('returns empty array initially', () => {
      expect(client.getCompletionHistory()).toEqual([]);
    });

    it('returns defensive copies', async () => {
      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Test' }],
      };

      await client.chatCompletion(request);

      const history1 = client.getCompletionHistory();
      const history2 = client.getCompletionHistory();

      expect(history1).not.toBe(history2);
      expect(history1).toEqual(history2);
    });
  });

  describe('clearHistory', () => {
    it('clears all stored requests', async () => {
      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Test' }],
      };

      await client.chatCompletion(request);
      expect(client.getCompletionHistory()).toHaveLength(1);

      client.clearHistory();
      expect(client.getCompletionHistory()).toEqual([]);
    });
  });

  describe('chatCompletionStream', () => {
    it('streams echo of the last user message character by character', async () => {
      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const tokens: string[] = [];
      for await (const token of client.chatCompletionStream(request)) {
        tokens.push(token);
      }

      expect(tokens.join('')).toBe('Echo:\n\nHi');
      expect(tokens.length).toBe('Echo:\n\nHi'.length);
    });

    it('handles no user message gracefully', async () => {
      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'system', content: 'You are helpful.' }],
      };

      const tokens: string[] = [];
      for await (const token of client.chatCompletionStream(request)) {
        tokens.push(token);
      }

      expect(tokens.join('')).toBe('Echo:\n\nNo message');
    });

    it('stores requests in history', async () => {
      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Stream test' }],
      };

      const tokens: string[] = [];
      for await (const token of client.chatCompletionStream(request)) {
        tokens.push(token);
      }
      expect(tokens.length).toBeGreaterThan(0);

      const history = client.getCompletionHistory();
      expect(history).toHaveLength(1);
      const firstRequest = history[0];
      expect(firstRequest).toBeDefined();
      if (firstRequest) {
        const firstMessage = firstRequest.messages[0];
        expect(firstMessage).toBeDefined();
        if (firstMessage) {
          expect(firstMessage.content).toBe('Stream test');
        }
      }
    });

    it('yields individual characters', async () => {
      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'A' }],
      };

      const tokens: string[] = [];
      for await (const token of client.chatCompletionStream(request)) {
        tokens.push(token);
        expect(token.length).toBe(1);
      }

      expect(tokens).toEqual(['E', 'c', 'h', 'o', ':', '\n', '\n', 'A']);
    });
  });

  describe('chatCompletionStreamWithMetadata', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('delays before yielding the first token to simulate thinking', async () => {
      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const iterator = client.chatCompletionStreamWithMetadata(request)[Symbol.asyncIterator]();

      // The first token should NOT be available immediately
      let resolved = false;
      // eslint-disable-next-line promise/prefer-await-to-then -- intentionally captures promise without awaiting to test timing
      const firstTokenPromise = iterator.next().then((result) => {
        resolved = true;
        return result;
      });

      // Advance past per-token delay but NOT past initial thinking delay (100ms)
      await vi.advanceTimersByTimeAsync(50);
      expect(resolved).toBe(false);

      // Advance past the 100ms thinking delay
      await vi.advanceTimersByTimeAsync(60);
      expect(resolved).toBe(true);

      const first = await firstTokenPromise;
      expect(first.done).toBe(false);
      if (!first.done) {
        expect(first.value.content).toBe('E'); // First char of "Echo:\n\nHi"
      }
    });
  });

  describe('web search plugin', () => {
    it('returns search-style response with citations when plugins include web', async () => {
      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'What is quantum computing?' }],
        plugins: [{ id: 'web' }],
      };

      const response = await client.chatCompletion(request);
      const content = response.choices[0]?.message.content ?? '';

      expect(content).not.toContain('Echo:');
      expect(content).toContain('quantum computing');
      expect(content).toMatch(/\[.*\]\(https?:\/\/.*\)/);
    });

    it('returns echo response when no plugins are provided', async () => {
      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const response = await client.chatCompletion(request);
      const content = response.choices[0]?.message.content ?? '';

      expect(content).toBe('Echo:\n\nHello');
    });

    it('returns echo response when plugins do not include web', async () => {
      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Hello' }],
        plugins: [{ id: 'other' }],
      };

      const response = await client.chatCompletion(request);
      const content = response.choices[0]?.message.content ?? '';

      expect(content).toBe('Echo:\n\nHello');
    });

    it('streams search-style response with citations when plugins include web', async () => {
      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Latest news' }],
        plugins: [{ id: 'web' }],
      };

      const tokens: string[] = [];
      for await (const token of client.chatCompletionStream(request)) {
        tokens.push(token);
      }
      const content = tokens.join('');

      expect(content).not.toContain('Echo:');
      expect(content).toContain('Latest news');
      expect(content).toMatch(/\[.*\]\(https?:\/\/.*\)/);
    });

    it('includes search-style response in streamWithMetadata when plugins include web', async () => {
      vi.useFakeTimers();

      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Climate change' }],
        plugins: [{ id: 'web' }],
      };

      const tokens: string[] = [];
      const iterator = client.chatCompletionStreamWithMetadata(request)[Symbol.asyncIterator]();

      // Advance past thinking delay
      let result = iterator.next();
      await vi.advanceTimersByTimeAsync(1100);
      let token = await result;

      while (!token.done) {
        tokens.push(token.value.content);
        result = iterator.next();
        await vi.advanceTimersByTimeAsync(10);
        token = await result;
      }

      const content = tokens.join('');
      expect(content).not.toContain('Echo:');
      expect(content).toContain('Climate change');
      expect(content).toMatch(/\[.*\]\(https?:\/\/.*\)/);

      vi.useRealTimers();
    });

    it('stores plugins in request history', async () => {
      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Test' }],
        plugins: [{ id: 'web' }],
      };

      await client.chatCompletion(request);

      const history = client.getCompletionHistory();
      expect(history[0]?.plugins).toEqual([{ id: 'web' }]);
    });
  });

  describe('auto-router support', () => {
    it('yields a final token with inlineCost > 0 and empty content for auto-router', async () => {
      vi.useFakeTimers();

      const request: ChatCompletionRequest = {
        model: 'openrouter/auto',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const tokens: StreamToken[] = [];
      const iterator = client.chatCompletionStreamWithMetadata(request)[Symbol.asyncIterator]();
      let result = iterator.next();
      await vi.advanceTimersByTimeAsync(1100);
      let token = await result;
      while (!token.done) {
        tokens.push(token.value);
        result = iterator.next();
        await vi.advanceTimersByTimeAsync(10);
        token = await result;
      }

      vi.useRealTimers();

      expect(tokens.length).toBeGreaterThanOrEqual(2);
      const lastToken = tokens.at(-1);
      expect(lastToken).toBeDefined();
      expect(lastToken!.content).toBe('');
      expect(lastToken!.inlineCost).toBeGreaterThan(0);
    });

    it('preserves auto-router plugin with allowed_models in history', async () => {
      const request: ChatCompletionRequest = {
        model: 'openrouter/auto',
        messages: [{ role: 'user', content: 'Test' }],
        plugins: [{ id: 'auto-router', allowed_models: ['openai/gpt-4-turbo'] }, { id: 'web' }],
      };

      await client.chatCompletion(request);

      const history = client.getCompletionHistory();
      expect(history[0]?.plugins).toEqual([
        { id: 'auto-router', allowed_models: ['openai/gpt-4-turbo'] },
        { id: 'web' },
      ]);
    });
  });

  describe('listModels and getModel', () => {
    it('throws not implemented error for listModels', () => {
      expect(() => client.listModels()).toThrow('Not implemented');
    });

    it('throws not implemented error for getModel', () => {
      expect(() => client.getModel('any-model')).toThrow('Not implemented');
    });
  });
});
