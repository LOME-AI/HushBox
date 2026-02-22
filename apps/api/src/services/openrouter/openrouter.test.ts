import { describe, it, expect, beforeEach, vi, afterEach, type Mock } from 'vitest';
import {
  createOpenRouterClient,
  fetchModels,
  fetchZdrModelIds,
  getModel,
  ContextCapacityError,
  MINIMUM_OUTPUT_TOKENS,
} from './openrouter.js';
import type {
  OpenRouterClient,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelInfo,
} from './types.js';

interface MockFetchResponse {
  ok: boolean;
  status?: number;
  statusText?: string;
  json: () => Promise<unknown>;
}

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<MockFetchResponse>>;

function createStreamResponse(tokens: string[]): MockFetchResponse & { body: ReadableStream } {
  const chunks = tokens.map(
    (t) => `data: ${JSON.stringify({ id: 'gen-123', choices: [{ delta: { content: t } }] })}\n\n`
  );
  chunks.push('data: [DONE]\n\n');

  const encoder = new TextEncoder();
  let index = 0;

  return {
    ok: true,
    body: new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index]));
          index++;
        } else {
          controller.close();
        }
      },
    }),
    json: () => Promise.resolve({}),
  };
}

describe('createOpenRouterClient', () => {
  let client: OpenRouterClient;
  const TEST_API_KEY = 'test-api-key-12345'; // gitleaks:allow
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal('fetch', fetchMock);
    client = createOpenRouterClient(TEST_API_KEY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://hushbox.ai',
            'X-Title': 'HushBox',
          }),
        })
      );
    });

    it('sends request body as JSON with ZDR provider config', async () => {
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
          const body = JSON.parse(options.body) as Record<string, unknown>;
          expect(body).toEqual({
            ...request,
            provider: { data_collection: 'deny', zdr: true },
          });
        }
      }
    });

    it('includes ZDR provider config to deny data collection', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockChatResponse),
      });

      await client.chatCompletion({
        model: 'openai/gpt-4-turbo',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      const calls = fetchMock.mock.calls;
      const firstCall = calls[0];
      expect(firstCall).toBeDefined();
      if (firstCall) {
        const options = firstCall[1] as { body?: string } | undefined;
        if (options?.body) {
          const body = JSON.parse(options.body) as Record<string, unknown>;
          expect(body['provider']).toEqual({ data_collection: 'deny', zdr: true });
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

    it('throws descriptive error when response is not JSON', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 502,
        json: () => {
          throw new SyntaxError('Unexpected token');
        },
      });

      await expect(
        client.chatCompletion({
          model: 'openai/gpt-4-turbo',
          messages: [{ role: 'user', content: 'Hi' }],
        })
      ).rejects.toThrow(
        'OpenRouter chat completion: expected JSON but received unparseable body (HTTP 502)'
      );
    });
  });

  describe('chatCompletionStream', () => {
    it('includes ZDR provider config in stream request', async () => {
      fetchMock.mockResolvedValueOnce(createStreamResponse(['Hi']));

      const tokens: string[] = [];
      for await (const token of client.chatCompletionStream({
        model: 'test/model',
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        tokens.push(token);
      }

      expect(tokens).toEqual(['Hi']);
      const firstCall = fetchMock.mock.calls[0];
      expect(firstCall).toBeDefined();
      if (firstCall) {
        const body = JSON.parse((firstCall[1] as { body: string }).body) as Record<string, unknown>;
        expect(body['provider']).toEqual({ data_collection: 'deny', zdr: true });
        expect(body['stream']).toBe(true);
      }
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

    it('includes authorization header', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      await client.listModels();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
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
          created: 1_704_067_200,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'anthropic/claude-3',
          name: 'Claude 3',
          description: 'Test',
          context_length: 200_000,
          pricing: { prompt: '0.00001', completion: '0.00003' },
          supported_parameters: [],
          created: 1_704_067_200,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
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
          created: 1_704_067_200,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'anthropic/claude-3',
          name: 'Claude 3',
          description: 'Test',
          context_length: 200_000,
          pricing: { prompt: '0.00001', completion: '0.00003' },
          supported_parameters: [],
          created: 1_704_067_200,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
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
          created: 1_704_067_200,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
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

describe('fetchModels (public, no auth required)', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls OpenRouter models endpoint without auth header', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });

    await fetchModels();

    expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models');

    // Verify no Authorization header was sent
    const calls = fetchMock.mock.calls;
    const firstCall = calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall) {
      const options = firstCall[1] as { headers?: Record<string, string> } | undefined;
      expect(options?.headers?.['Authorization']).toBeUndefined();
    }
  });

  it('returns models from OpenRouter', async () => {
    const mockModels: ModelInfo[] = [
      {
        id: 'openai/gpt-4',
        name: 'GPT-4',
        description: 'Test',
        context_length: 8192,
        pricing: { prompt: '0.00001', completion: '0.00003' },
        supported_parameters: [],
        created: 1_704_067_200,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      },
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: mockModels }),
    });

    const result = await fetchModels();

    expect(result).toEqual(mockModels);
  });

  it('throws on API error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      statusText: 'Internal Server Error',
      json: () => Promise.resolve({}),
    });

    await expect(fetchModels()).rejects.toThrow('Failed to fetch models');
  });

  it('throws descriptive error when response is not JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 503,
      json: () => {
        throw new SyntaxError('Unexpected token');
      },
    });

    await expect(fetchModels()).rejects.toThrow(
      'OpenRouter models: expected JSON but received unparseable body (HTTP 503)'
    );
  });
});

describe('fetchZdrModelIds (public, no auth required)', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches ZDR endpoints and returns model ID set', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            {
              model_id: 'openai/gpt-4',
              model_name: 'GPT-4',
              provider_name: 'OpenAI',
              context_length: 8192,
              pricing: { prompt: '0.00001', completion: '0.00003' },
            },
            {
              model_id: 'anthropic/claude-3',
              model_name: 'Claude 3',
              provider_name: 'Anthropic',
              context_length: 200_000,
              pricing: { prompt: '0.00001', completion: '0.00003' },
            },
            {
              model_id: 'openai/gpt-4',
              model_name: 'GPT-4',
              provider_name: 'Azure',
              context_length: 8192,
              pricing: { prompt: '0.00001', completion: '0.00003' },
            },
          ],
        }),
    });

    const result = await fetchZdrModelIds();

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(2); // Deduplicated
    expect(result.has('openai/gpt-4')).toBe(true);
    expect(result.has('anthropic/claude-3')).toBe(true);
  });

  it('calls ZDR endpoint without auth header', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });

    await fetchZdrModelIds();

    expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/endpoints/zdr');

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall) {
      const options = firstCall[1] as { headers?: Record<string, string> } | undefined;
      expect(options?.headers?.['Authorization']).toBeUndefined();
    }
  });

  it('throws on fetch failure', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      statusText: 'Internal Server Error',
      json: () => Promise.resolve({}),
    });

    await expect(fetchZdrModelIds()).rejects.toThrow('Failed to fetch ZDR endpoints');
  });

  it('returns empty set when no ZDR endpoints exist', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });

    const result = await fetchZdrModelIds();

    expect(result.size).toBe(0);
  });
});

describe('chatCompletionStreamWithMetadata retry logic', () => {
  let client: OpenRouterClient;
  const TEST_API_KEY = 'test-api-key-12345'; // gitleaks:allow
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal('fetch', fetchMock);
    client = createOpenRouterClient(TEST_API_KEY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes ZDR provider config in stream-with-metadata request', async () => {
    fetchMock.mockResolvedValueOnce(createStreamResponse(['Hello']));

    const tokens: string[] = [];
    for await (const token of client.chatCompletionStreamWithMetadata({
      model: 'test/model',
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      tokens.push(token.content);
    }

    expect(tokens).toEqual(['Hello']);
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall) {
      const body = JSON.parse((firstCall[1] as { body: string }).body) as Record<string, unknown>;
      expect(body['provider']).toEqual({ data_collection: 'deny', zdr: true });
      expect(body['stream']).toBe(true);
    }
  });

  it('includes ZDR provider config in retried context-length request', async () => {
    const contextLengthError = {
      error: {
        message:
          "This endpoint's maximum context length is 204800 tokens. However, you requested about 4262473 tokens (65 of text input, 4262408 in the output).",
      },
    };

    fetchMock.mockResolvedValueOnce({
      ok: false,
      statusText: 'Bad Request',
      json: () => Promise.resolve(contextLengthError),
    });
    fetchMock.mockResolvedValueOnce(createStreamResponse(['OK']));

    const tokens: string[] = [];
    for await (const token of client.chatCompletionStreamWithMetadata({
      model: 'test/model',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 4_262_408,
    })) {
      tokens.push(token.content);
    }

    expect(tokens).toEqual(['OK']);

    // Both original and retry should include ZDR provider config
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
      expect(body['provider']).toEqual({ data_collection: 'deny', zdr: true });
    }
  });

  it('retries with corrected max_tokens on context length error', async () => {
    const contextLengthError = {
      error: {
        message:
          "This endpoint's maximum context length is 204800 tokens. However, you requested about 4262473 tokens (65 of text input, 4262408 in the output).",
      },
    };

    // First call fails with context length error
    fetchMock.mockResolvedValueOnce({
      ok: false,
      statusText: 'Bad Request',
      json: () => Promise.resolve(contextLengthError),
    });

    // Retry succeeds
    fetchMock.mockResolvedValueOnce(createStreamResponse(['Hello', ' world']));

    const tokens: string[] = [];
    for await (const token of client.chatCompletionStreamWithMetadata({
      model: 'test/model',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 4_262_408, // Original request with too many tokens
    })) {
      tokens.push(token.content);
    }

    expect(tokens).toEqual(['Hello', ' world']);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Verify retry was called with corrected max_tokens
    const retryCall = fetchMock.mock.calls[1];
    if (retryCall === undefined) {
      throw new Error('Expected retry call to exist');
    }
    const retryBody = JSON.parse((retryCall[1] as { body: string }).body) as {
      max_tokens?: number;
    };
    // maxContext (204800) - textInput (65) = 204735
    expect(retryBody.max_tokens).toBe(204_735);
  });

  it('throws original error if retry also fails', async () => {
    const contextLengthError = {
      error: {
        message:
          "This endpoint's maximum context length is 204800 tokens. However, you requested about 4262473 tokens (65 of text input, 4262408 in the output).",
      },
    };

    // First call fails with context length error
    fetchMock.mockResolvedValueOnce({
      ok: false,
      statusText: 'Bad Request',
      json: () => Promise.resolve(contextLengthError),
    });

    // Retry also fails
    fetchMock.mockResolvedValueOnce({
      ok: false,
      statusText: 'Bad Request',
      json: () => Promise.resolve({ error: { message: 'Still too long' } }),
    });

    await expect(async () => {
      // eslint-disable-next-line sonarjs/no-unused-vars -- consuming stream to trigger error
      for await (const _ of client.chatCompletionStreamWithMetadata({
        model: 'test/model',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        // consume stream
      }
    }).rejects.toThrow('OpenRouter error: Still too long');
  });

  it('does not retry on non-context-length errors', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      statusText: 'Bad Request',
      json: () => Promise.resolve({ error: { message: 'Invalid API key' } }),
    });

    await expect(async () => {
      // eslint-disable-next-line sonarjs/no-unused-vars -- consuming stream to trigger error
      for await (const _ of client.chatCompletionStreamWithMetadata({
        model: 'test/model',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        // consume stream
      }
    }).rejects.toThrow('OpenRouter error: Invalid API key');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws ContextCapacityError when corrected tokens below MINIMUM_OUTPUT_TOKENS', async () => {
    // maxContext=10000, textInput=9500 → corrected = 500 < MINIMUM_OUTPUT_TOKENS (1000)
    const contextLengthError = {
      error: {
        message:
          "This endpoint's maximum context length is 10000 tokens. However, you requested about 13762 tokens (9500 of text input, 4262 in the output).",
      },
    };

    fetchMock.mockResolvedValueOnce({
      ok: false,
      statusText: 'Bad Request',
      json: () => Promise.resolve(contextLengthError),
    });

    await expect(async () => {
      // eslint-disable-next-line sonarjs/no-unused-vars -- consuming stream to trigger error
      for await (const _ of client.chatCompletionStreamWithMetadata({
        model: 'test/model',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        // consume stream
      }
    }).rejects.toThrow(ContextCapacityError);

    // Should NOT retry — only 1 fetch call
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ContextCapacityError has descriptive message', async () => {
    const contextLengthError = {
      error: {
        message:
          "This endpoint's maximum context length is 10000 tokens. However, you requested about 13762 tokens (9500 of text input, 4262 in the output).",
      },
    };

    fetchMock.mockResolvedValueOnce({
      ok: false,
      statusText: 'Bad Request',
      json: () => Promise.resolve(contextLengthError),
    });

    try {
      // eslint-disable-next-line sonarjs/no-unused-vars -- consuming stream to trigger error
      for await (const _ of client.chatCompletionStreamWithMetadata({
        model: 'test/model',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        // consume stream
      }
      throw new Error('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextCapacityError);
    }
  });

  it('retries normally when corrected tokens >= MINIMUM_OUTPUT_TOKENS', async () => {
    // maxContext=10000, textInput=8000 → corrected = 2000 >= MINIMUM_OUTPUT_TOKENS (1000)
    const contextLengthError = {
      error: {
        message:
          "This endpoint's maximum context length is 10000 tokens. However, you requested about 12000 tokens (8000 of text input, 4000 in the output).",
      },
    };

    fetchMock.mockResolvedValueOnce({
      ok: false,
      statusText: 'Bad Request',
      json: () => Promise.resolve(contextLengthError),
    });

    fetchMock.mockResolvedValueOnce(createStreamResponse(['OK']));

    const tokens: string[] = [];
    for await (const token of client.chatCompletionStreamWithMetadata({
      model: 'test/model',
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      tokens.push(token.content);
    }

    expect(tokens).toEqual(['OK']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('MINIMUM_OUTPUT_TOKENS is 1000', () => {
    expect(MINIMUM_OUTPUT_TOKENS).toBe(1000);
  });

  it('does not retry if error message cannot be parsed', async () => {
    const unparsableError = {
      error: {
        message: 'Context length exceeded but in a different format',
      },
    };

    fetchMock.mockResolvedValueOnce({
      ok: false,
      statusText: 'Bad Request',
      json: () => Promise.resolve(unparsableError),
    });

    await expect(async () => {
      // eslint-disable-next-line sonarjs/no-unused-vars -- consuming stream to trigger error
      for await (const _ of client.chatCompletionStreamWithMetadata({
        model: 'test/model',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        // consume stream
      }
    }).rejects.toThrow('OpenRouter error: Context length exceeded but in a different format');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('getModel (public, no auth required)', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns specific model by ID', async () => {
    const mockModels: ModelInfo[] = [
      {
        id: 'openai/gpt-4',
        name: 'GPT-4',
        description: 'Test',
        context_length: 8192,
        pricing: { prompt: '0.00001', completion: '0.00003' },
        supported_parameters: [],
        created: 1_704_067_200,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      },
      {
        id: 'anthropic/claude-3',
        name: 'Claude 3',
        description: 'Test',
        context_length: 200_000,
        pricing: { prompt: '0.00001', completion: '0.00003' },
        supported_parameters: [],
        created: 1_704_067_200,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      },
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: mockModels }),
    });

    const result = await getModel('anthropic/claude-3');

    expect(result.id).toBe('anthropic/claude-3');
    expect(result.name).toBe('Claude 3');
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
        created: 1_704_067_200,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      },
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: mockModels }),
    });

    await expect(getModel('unknown/model')).rejects.toThrow('Model not found: unknown/model');
  });
});
