import { recordServiceEvidence, SERVICE_NAMES, type Database } from '@lome-chat/db';
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

export interface EvidenceConfig {
  db: Database;
  isCI: boolean;
}

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

// Model cache (shared across all clients since models are the same regardless of API key)
let modelCache: { models: ModelInfo[]; fetchedAt: number } | null = null;
const MODEL_CACHE_TTL = 3_600_000; // 1 hour in milliseconds

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

type SSEDataLineResult = { done: true } | { done: false; content: string | null };

function processSSEDataLine(line: string): SSEDataLineResult {
  if (!line.startsWith('data: ')) {
    return { done: false, content: null };
  }

  const data = line.slice(6).trim();
  if (data === '[DONE]') {
    return { done: true };
  }

  try {
    const chunk = JSON.parse(data) as ChatCompletionChunk;
    const content = chunk.choices[0]?.delta.content ?? null;
    return { done: false, content };
  } catch (error) {
    console.warn('Failed to parse SSE chunk:', { data, error });
    return { done: false, content: null };
  }
}

interface SSELinesResult {
  contents: string[];
  streamDone: boolean;
}

function processSSELines(lines: string[]): SSELinesResult {
  const contents: string[] = [];
  for (const line of lines) {
    const result = processSSEDataLine(line);
    if (result.done) {
      return { contents, streamDone: true };
    }
    if (result.content) {
      contents.push(result.content);
    }
  }
  return { contents, streamDone: false };
}

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

    const { contents, streamDone } = processSSELines(lines);
    for (const content of contents) {
      yield content;
    }
    if (streamDone) return;
  }
}

interface SSELineState {
  generationId: string | undefined;
  isFirstTokenWithId: boolean;
}

interface SSELineResult {
  done: boolean;
  token?: StreamToken;
  state: SSELineState;
}

function processSSELine(line: string, state: SSELineState): SSELineResult {
  if (!line.startsWith('data: ')) {
    return { done: false, state };
  }

  const data = line.slice(6).trim();
  if (data === '[DONE]') {
    return { done: true, state };
  }

  try {
    const chunk = JSON.parse(data) as ChatCompletionChunk;
    const newGenerationId = state.generationId ?? chunk.id;
    const content = chunk.choices[0]?.delta.content;

    if (!content) {
      return { done: false, state: { ...state, generationId: newGenerationId } };
    }

    const token: StreamToken = { content };
    let newIsFirstTokenWithId = state.isFirstTokenWithId;

    if (state.isFirstTokenWithId && newGenerationId) {
      token.generationId = newGenerationId;
      newIsFirstTokenWithId = false;
    }

    return {
      done: false,
      token,
      state: { generationId: newGenerationId, isFirstTokenWithId: newIsFirstTokenWithId },
    };
  } catch (error) {
    console.warn('Failed to parse SSE chunk:', { data, error });
    return { done: false, state };
  }
}

interface SSELinesWithStateResult {
  tokens: StreamToken[];
  streamDone: boolean;
  state: SSELineState;
}

function processSSELinesWithState(lines: string[], state: SSELineState): SSELinesWithStateResult {
  const tokens: StreamToken[] = [];
  let currentState = state;

  for (const line of lines) {
    const result = processSSELine(line, currentState);
    currentState = result.state;

    if (result.done) {
      return { tokens, streamDone: true, state: currentState };
    }
    if (result.token) {
      tokens.push(result.token);
    }
  }

  return { tokens, streamDone: false, state: currentState };
}

async function* parseSSEStreamWithMetadata(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncIterable<StreamToken> {
  const decoder = new TextDecoder();
  let buffer = '';
  let state: SSELineState = { generationId: undefined, isFirstTokenWithId: true };

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- standard SSE parsing loop
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    const result = processSSELinesWithState(lines, state);
    state = result.state;
    for (const token of result.tokens) yield token;
    if (result.streamDone) return;
  }
}

type RequestWithRetryResult =
  | { success: true; reader: ReadableStreamDefaultReader<Uint8Array> }
  | { success: false; error: Error };

async function makeRequestWithContextRetry(
  makeRequest: (req: ChatCompletionRequest) => Promise<ReadableStreamDefaultReader<Uint8Array>>,
  request: ChatCompletionRequest
): Promise<RequestWithRetryResult> {
  try {
    const reader = await makeRequest(request);
    return { success: true, reader };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('OpenRouter error:')) {
      return { success: false, error: error instanceof Error ? error : new Error('Unknown error') };
    }

    const contextError = parseContextLengthError(error.message);
    if (!contextError) {
      return { success: false, error };
    }

    const correctedMaxTokens = contextError.maxContext - contextError.textInput;
    const reader = await makeRequest({ ...request, max_tokens: correctedMaxTokens });
    return { success: true, reader };
  }
}

export function createOpenRouterClient(
  apiKey: string,
  evidenceConfig?: EvidenceConfig
): OpenRouterClient {
  if (apiKey.trim() === '') {
    throw new Error('OPENROUTER_API_KEY is required and cannot be empty');
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://lome-chat.com',
    'X-Title': 'LOME-CHAT',
  };

  const recordEvidence = async (): Promise<void> => {
    if (evidenceConfig) {
      await recordServiceEvidence(evidenceConfig.db, evidenceConfig.isCI, SERVICE_NAMES.OPENROUTER);
    }
  };

  return {
    isMock: false,

    async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      });
      await recordEvidence();

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
      await recordEvidence();

      if (!response.ok) {
        const error: OpenRouterErrorResponse = await response.json();
        throw new Error(`OpenRouter error: ${error.error?.message ?? response.statusText}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
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
        await recordEvidence();

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

      const result = await makeRequestWithContextRetry(makeRequest, request);
      if (!result.success) {
        throw result.error;
      }

      yield* parseSSEStreamWithMetadata(result.reader);
    },

    async listModels(): Promise<ModelInfo[]> {
      if (modelCache && Date.now() - modelCache.fetchedAt < MODEL_CACHE_TTL) {
        return modelCache.models;
      }

      const response = await fetch(`${OPENROUTER_API_URL}/models`, { headers });
      await recordEvidence();

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
      await recordEvidence();

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
