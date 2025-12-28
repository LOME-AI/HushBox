import { describe, it, expect, beforeEach, vi, afterEach, type Mock } from 'vitest';
import { createOpenRouterClient, clearModelCache } from '../openrouter.js';
import type {
  OpenRouterClient,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelInfo,
} from '../types.js';

interface MockFetchResponse {
  ok: boolean;
  statusText?: string;
  json: () => Promise<unknown>;
}

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<MockFetchResponse>>;

describe('createOpenRouterClient', () => {
  let client: OpenRouterClient;
  const TEST_API_KEY = 'test-api-key-12345';
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal('fetch', fetchMock);
    client = createOpenRouterClient(TEST_API_KEY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearModelCache();
  });

  describe('factory function', () => {
    it('returns an OpenRouterClient', () => {
      expect(client).toBeDefined();
      expect(typeof client.chatCompletion).toBe('function');
      expect(typeof client.listModels).toBe('function');
      expect(typeof client.getModel).toBe('function');
    });

    it('throws error for empty API key', () => {
      expect(() => createOpenRouterClient('')).toThrow(
        'OPENROUTER_API_KEY is required and cannot be empty'
      );
    });

    it('throws error for whitespace-only API key', () => {
      expect(() => createOpenRouterClient('   ')).toThrow(
        'OPENROUTER_API_KEY is required and cannot be empty'
      );
    });
  });

  describe('chatCompletion', () => {
    const mockChatResponse: ChatCompletionResponse = {
      id: 'chatcmpl-123',
      model: 'openai/gpt-4-turbo',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello!' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    it('calls OpenRouter API with correct endpoint', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockChatResponse),
      });

      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      await client.chatCompletion(request);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('includes authorization header with API key', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockChatResponse),
      });

      await client.chatCompletion({
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher
          headers: expect.objectContaining({
            Authorization: `Bearer ${TEST_API_KEY}`,
          }),
        })
      );
    });

    it('includes required OpenRouter headers', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockChatResponse),
      });

      await client.chatCompletion({
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://lome-chat.com',
            'X-Title': 'LOME-CHAT',
          }),
        })
      );
    });

    it('sends request body as JSON', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockChatResponse),
      });

      const request: ChatCompletionRequest = {
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Test message' }],
        temperature: 0.7,
      };

      await client.chatCompletion(request);

      const calls = fetchMock.mock.calls;
      const firstCall = calls[0];
      expect(firstCall).toBeDefined();
      if (firstCall) {
        const options = firstCall[1] as { body?: string } | undefined;
        if (options?.body) {
          const body = JSON.parse(options.body) as ChatCompletionRequest;
          expect(body).toEqual(request);
        }
      }
    });

    it('returns parsed response', async () => {
      const mockResponse: ChatCompletionResponse = {
        id: 'chatcmpl-123',
        model: 'openai/gpt-4-turbo',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello, how can I help?' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await client.chatCompletion({
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result).toEqual(mockResponse);
    });

    it('throws on API error with error message', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        statusText: 'Bad Request',
        json: () => Promise.resolve({ error: { message: 'Invalid API key' } }),
      });

      await expect(
        client.chatCompletion({
          model: 'openai/gpt-4-turbo',
          messages: [{ role: 'user', content: 'Hi' }],
        })
      ).rejects.toThrow('OpenRouter error: Invalid API key');
    });

    it('throws on API error with status text when no message', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({}),
      });

      await expect(
        client.chatCompletion({
          model: 'openai/gpt-4-turbo',
          messages: [{ role: 'user', content: 'Hi' }],
        })
      ).rejects.toThrow('OpenRouter error: Internal Server Error');
    });

    it('propagates network errors', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network failure'));

      await expect(
        client.chatCompletion({
          model: 'openai/gpt-4-turbo',
          messages: [{ role: 'user', content: 'Hi' }],
        })
      ).rejects.toThrow('Network failure');
    });
  });

  describe('listModels', () => {
    it('calls OpenRouter models endpoint', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 'openai/gpt-4', name: 'GPT-4' }] }),
      });

      await client.listModels();

      expect(fetchMock).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models',
        expect.any(Object)
      );
    });

    it('caches models and does not refetch within TTL', async () => {
      const mockModels = [{ id: 'openai/gpt-4', name: 'GPT-4' }];
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: mockModels }),
      });

      // First call should fetch
      await client.listModels();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Second call should use cache
      await client.listModels();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Third call should still use cache
      await client.listModels();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('includes authorization header', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      await client.listModels();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher
          headers: expect.objectContaining({
            Authorization: `Bearer ${TEST_API_KEY}`,
          }),
        })
      );
    });

    it('returns models from data array', async () => {
      const mockModels: ModelInfo[] = [
        {
          id: 'openai/gpt-4',
          name: 'GPT-4',
          description: 'Test',
          context_length: 8192,
          pricing: { prompt: '0.00001', completion: '0.00003' },
          supported_parameters: [],
        },
        {
          id: 'anthropic/claude-3',
          name: 'Claude 3',
          description: 'Test',
          context_length: 200000,
          pricing: { prompt: '0.00001', completion: '0.00003' },
          supported_parameters: [],
        },
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: mockModels }),
      });

      const result = await client.listModels();

      expect(result).toEqual(mockModels);
    });

    it('throws on API error', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        statusText: 'Unauthorized',
        json: () => Promise.resolve({}),
      });

      await expect(client.listModels()).rejects.toThrow('Failed to fetch models');
    });
  });

  describe('getModel', () => {
    it('returns specific model by ID', async () => {
      const mockModels: ModelInfo[] = [
        {
          id: 'openai/gpt-4',
          name: 'GPT-4',
          description: 'Test',
          context_length: 8192,
          pricing: { prompt: '0.00001', completion: '0.00003' },
          supported_parameters: ['tools'],
        },
        {
          id: 'anthropic/claude-3',
          name: 'Claude 3',
          description: 'Test',
          context_length: 200000,
          pricing: { prompt: '0.00001', completion: '0.00003' },
          supported_parameters: [],
        },
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: mockModels }),
      });

      const result = await client.getModel('openai/gpt-4');

      expect(result.id).toBe('openai/gpt-4');
      expect(result.name).toBe('GPT-4');
    });

    it('throws for unknown model', async () => {
      const mockModels: ModelInfo[] = [
        {
          id: 'openai/gpt-4',
          name: 'GPT-4',
          description: 'Test',
          context_length: 8192,
          pricing: { prompt: '0.00001', completion: '0.00003' },
          supported_parameters: [],
        },
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: mockModels }),
      });

      await expect(client.getModel('unknown/model')).rejects.toThrow(
        'Model not found: unknown/model'
      );
    });
  });
});
