import { describe, it, expect, beforeEach } from 'vitest';
import { createMockOpenRouterClient } from './mock.js';
import type { ChatCompletionRequest, MockOpenRouterClient } from './types.js';

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
        expect(firstChoice.message.content).toBe('Echo: Hello, world!');
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
        expect(firstChoice.message.content).toBe('Echo: No message');
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

      expect(tokens.join('')).toBe('Echo: Hi');
      expect(tokens.length).toBe('Echo: Hi'.length);
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

      expect(tokens.join('')).toBe('Echo: No message');
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

      expect(tokens).toEqual(['E', 'c', 'h', 'o', ':', ' ', 'A']);
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
