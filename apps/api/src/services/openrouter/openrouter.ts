import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ModelInfo,
  OpenRouterClient,
  GenerationStats,
  StreamToken,
} from './types.js';
import { parseContextLengthError } from './context-error.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

// Model cache (shared across all clients since models are the same regardless of API key)
let modelCache: { models: ModelInfo[]; fetchedAt: number } | null = null;
const MODEL_CACHE_TTL = 3600000; // 1 hour in milliseconds

/**
 * Clear the model cache. Exposed for testing purposes.
 */
export function clearModelCache(): void {
  modelCache = null;
}

/**
 * Fetch models from OpenRouter API without authentication.
 * The /models endpoint is public and does not require an API key.
 * Uses shared cache with 1 hour TTL.
 */
export async function fetchModels(): Promise<ModelInfo[]> {
  if (modelCache && Date.now() - modelCache.fetchedAt < MODEL_CACHE_TTL) {
    return modelCache.models;
  }

  const response = await fetch(`${OPENROUTER_API_URL}/models`);

  if (!response.ok) {
    throw new Error('Failed to fetch models');
  }

  const data: { data: ModelInfo[] } = await response.json();
  modelCache = { models: data.data, fetchedAt: Date.now() };
  return data.data;
}

/**
 * Get a specific model by ID from OpenRouter API without authentication.
 * Uses the shared model cache.
 */
export async function getModel(modelId: string): Promise<ModelInfo> {
  const models = await fetchModels();
  const model = models.find((m) => m.id === modelId);

  if (!model) {
    throw new Error(`Model not found: ${modelId}`);
  }

  return model;
}

interface OpenRouterErrorResponse {
  error?: {
    message?: string;
  };
}

/**
 * Parse SSE stream from OpenRouter API.
 * Yields content delta strings from each chunk.
 */
async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- standard SSE parsing loop
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;

      const data = line.slice(6).trim();
      if (data === '[DONE]') return;

      try {
        const chunk = JSON.parse(data) as ChatCompletionChunk;
        const firstChoice = chunk.choices[0];
        const content = firstChoice?.delta.content;
        if (content) {
          yield content;
        }
      } catch (error) {
        console.warn('Failed to parse SSE chunk:', { data, error });
        // Continue streaming - don't fail completely
      }
    }
  }
}

/**
 * Parse SSE stream from OpenRouter API with metadata extraction.
 * Yields StreamToken objects containing content and generation ID.
 * The generation ID is extracted from the first chunk and included with the first token.
 */
async function* parseSSEStreamWithMetadata(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncIterable<StreamToken> {
  const decoder = new TextDecoder();
  let buffer = '';
  let generationId: string | undefined;
  let isFirstTokenWithId = true;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- standard SSE parsing loop
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;

      const data = line.slice(6).trim();
      if (data === '[DONE]') return;

      try {
        const chunk = JSON.parse(data) as ChatCompletionChunk;

        // Capture generation ID from first chunk (it's in the 'id' field)
        generationId ??= chunk.id;

        const firstChoice = chunk.choices[0];
        const content = firstChoice?.delta.content;
        if (content) {
          // Include generation ID only with the first token that has content
          const token: StreamToken = { content };
          if (isFirstTokenWithId && generationId) {
            token.generationId = generationId;
            isFirstTokenWithId = false;
          }
          yield token;
        }
      } catch (error) {
        console.warn('Failed to parse SSE chunk:', { data, error });
        // Continue streaming - don't fail completely
      }
    }
  }
}

export function createOpenRouterClient(apiKey: string): OpenRouterClient {
  if (apiKey.trim() === '') {
    throw new Error('OPENROUTER_API_KEY is required and cannot be empty');
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://lome-chat.com',
    'X-Title': 'LOME-CHAT',
  };

  return {
    isMock: false,

    async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const error: OpenRouterErrorResponse = await response.json();
        throw new Error(`OpenRouter error: ${error.error?.message ?? response.statusText}`);
      }

      return response.json();
    },

    async *chatCompletionStream(request: ChatCompletionRequest): AsyncIterable<string> {
      const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...request, stream: true }),
      });

      if (!response.ok) {
        const error: OpenRouterErrorResponse = await response.json();
        throw new Error(`OpenRouter error: ${error.error?.message ?? response.statusText}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader();
      yield* parseSSEStream(reader);
    },

    async *chatCompletionStreamWithMetadata(
      request: ChatCompletionRequest
    ): AsyncIterable<StreamToken> {
      const makeRequest = async (
        req: ChatCompletionRequest
      ): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
        const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...req, stream: true }),
        });

        if (!response.ok) {
          const error: OpenRouterErrorResponse = await response.json();
          const message = error.error?.message ?? response.statusText;
          throw new Error(`OpenRouter error: ${message}`);
        }

        if (!response.body) {
          throw new Error('Response body is null');
        }

        return response.body.getReader();
      };

      let reader: ReadableStreamDefaultReader<Uint8Array>;
      try {
        reader = await makeRequest(request);
      } catch (error) {
        if (error instanceof Error && error.message.includes('OpenRouter error:')) {
          const contextError = parseContextLengthError(error.message);
          if (contextError) {
            const correctedMaxTokens = contextError.maxContext - contextError.textInput;
            reader = await makeRequest({ ...request, max_tokens: correctedMaxTokens });
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }

      yield* parseSSEStreamWithMetadata(reader);
    },

    async listModels(): Promise<ModelInfo[]> {
      if (modelCache && Date.now() - modelCache.fetchedAt < MODEL_CACHE_TTL) {
        return modelCache.models;
      }

      const response = await fetch(`${OPENROUTER_API_URL}/models`, { headers });

      if (!response.ok) {
        throw new Error('Failed to fetch models');
      }

      const data: { data: ModelInfo[] } = await response.json();
      modelCache = { models: data.data, fetchedAt: Date.now() };
      return data.data;
    },

    async getModel(modelId: string): Promise<ModelInfo> {
      const models = await this.listModels();
      const model = models.find((m) => m.id === modelId);

      if (!model) {
        throw new Error(`Model not found: ${modelId}`);
      }

      return model;
    },

    async getGenerationStats(generationId: string): Promise<GenerationStats> {
      const response = await fetch(`${OPENROUTER_API_URL}/generation?id=${generationId}`, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        const error: OpenRouterErrorResponse = await response.json();
        throw new Error(
          `Failed to get generation stats: ${error.error?.message ?? response.statusText}`
        );
      }

      const responseData: { data: GenerationStats } = await response.json();
      return responseData.data;
    },
  };
}
