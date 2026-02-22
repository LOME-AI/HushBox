import { useState, useCallback } from 'react';
import { getApiUrl } from '../lib/api';
import { getTrialToken } from '../lib/trial-token';
import { createSSEParser, type DoneEventData } from '../lib/sse-client';

// ============================================================================
// Types
// ============================================================================

export type StreamMode = 'authenticated' | 'trial';

interface AuthenticatedStreamRequest {
  conversationId: string;
  model: string;
  userMessage: {
    id: string;
    content: string;
  };
  messagesForInference: { role: 'user' | 'assistant' | 'system'; content: string }[];
  fundingSource: string;
}

interface TrialStreamMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface TrialStreamRequest {
  messages: TrialStreamMessage[];
  model: string;
}

export type StreamRequest = AuthenticatedStreamRequest | TrialStreamRequest;

interface StreamResult {
  userMessageId: string;
  assistantMessageId: string;
  content: string;
  cost: string;
}

interface StreamOptions {
  onToken?: (token: string) => void;
  onStart?: (ids: { userMessageId: string; assistantMessageId: string }) => void;
  signal?: AbortSignal;
}

export class TrialRateLimitError extends Error {
  public readonly limit: number;
  public readonly remaining: number;
  public readonly isRateLimited = true;

  constructor(
    public readonly code: string,
    limit: number,
    remaining: number
  ) {
    super(code);
    this.name = 'TrialRateLimitError';
    this.limit = limit;
    this.remaining = remaining;
  }
}

export class BalanceReservedError extends Error {
  public readonly isBalanceReserved = true;

  constructor(public readonly code: string) {
    super(code);
    this.name = 'BalanceReservedError';
  }
}

export class BillingMismatchError extends Error {
  public readonly isBillingMismatch = true;

  constructor(public readonly code: string) {
    super(code);
    this.name = 'BillingMismatchError';
  }
}

export class ContextCapacityError extends Error {
  public readonly isContextCapacity = true;

  constructor(public readonly code: string) {
    super(code);
    this.name = 'ContextCapacityError';
  }
}

interface ChatStreamHook {
  isStreaming: boolean;
  startStream: (request: StreamRequest, options?: StreamOptions) => Promise<StreamResult>;
}

interface StreamRequestConfig {
  url: string;
  options: RequestInit;
}

function buildStreamRequest(
  mode: StreamMode,
  request: StreamRequest,
  signal?: AbortSignal
): StreamRequestConfig {
  const endpoint = mode === 'trial' ? '/api/trial/stream' : '/api/chat/stream';
  const headers: HeadersInit = { 'Content-Type': 'application/json' };

  if (mode === 'trial') {
    headers['X-Trial-Token'] = getTrialToken();
  }

  const fetchOptions: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
    signal: signal ?? null,
  };

  if (mode === 'authenticated') {
    fetchOptions.credentials = 'include';
  }

  return { url: `${getApiUrl()}${endpoint}`, options: fetchOptions };
}

function extractErrorCode(data: unknown): string | undefined {
  if (typeof data === 'object' && data !== null && 'code' in data) {
    const code = (data as Record<string, unknown>)['code'];
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function createTrialRateLimitError(code: string, data: unknown): TrialRateLimitError {
  const errorData = data as { details?: { limit?: number; remaining?: number } };
  return new TrialRateLimitError(
    code,
    errorData.details?.limit ?? 5,
    errorData.details?.remaining ?? 0
  );
}

function handleStreamError(mode: StreamMode, status: number, data: unknown): never {
  const code = extractErrorCode(data) ?? 'INTERNAL';
  if (mode === 'trial' && status === 429) {
    throw createTrialRateLimitError(code, data);
  }
  if (mode === 'authenticated' && status === 409) {
    throw new BillingMismatchError(code);
  }
  if (mode === 'authenticated' && status === 402 && code === 'BALANCE_RESERVED') {
    throw new BalanceReservedError(code);
  }
  throw new Error(code);
}

async function validateSSEResponse(
  response: Response
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const contentType = response.headers.get('Content-Type');
  if (!contentType?.includes('text/event-stream')) {
    const errorData: unknown = await response.json().catch(() => ({}));
    throw new Error(extractErrorCode(errorData) ?? 'INTERNAL');
  }

  if (!response.body) {
    throw new Error('Response body is null');
  }

  return response.body.getReader();
}

interface StreamState {
  error: Error | null;
  done: boolean;
  doneData: DoneEventData | null;
}

type SSEParser = ReturnType<typeof createSSEParser>;

async function consumeSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  parser: SSEParser,
  state: StreamState
): Promise<StreamResult> {
  const decoder = new TextDecoder();

  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- standard pattern for async iterator
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      parser.processChunk(decoder.decode(value, { stream: true }));

      if (state.error) {
        throw state.error;
      }
      if (state.done) {
        break;
      }
    }

    return {
      userMessageId: parser.getUserMessageId(),
      assistantMessageId: parser.getAssistantMessageId(),
      content: parser.getContent(),
      cost: state.doneData?.cost ?? '0',
    };
  } finally {
    void (async () => {
      try {
        await reader.cancel();
      } catch {
        // Reader cleanup errors can be ignored
      }
    })();
  }
}

export function useChatStream(mode: StreamMode): ChatStreamHook {
  const [isStreaming, setIsStreaming] = useState(false);

  const startStream = useCallback(
    async (request: StreamRequest, options?: StreamOptions): Promise<StreamResult> => {
      setIsStreaming(true);

      try {
        const { url, options: fetchOptions } = buildStreamRequest(mode, request, options?.signal);
        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
          const data: unknown = await response.json();
          handleStreamError(mode, response.status, data);
        }

        const reader = await validateSSEResponse(response);
        const streamState: StreamState = { error: null, done: false, doneData: null };

        const parser = createSSEParser({
          onStart: (data) => options?.onStart?.(data),
          onToken: (tokenContent) => options?.onToken?.(tokenContent),
          onError: (errorData) => {
            streamState.error =
              errorData.code === 'context_length_exceeded'
                ? new ContextCapacityError(errorData.code)
                : new Error(errorData.message);
          },
          onDone: (doneData) => {
            streamState.done = true;
            streamState.doneData = doneData;
          },
        });

        return await consumeSSEStream(reader, parser, streamState);
      } finally {
        setIsStreaming(false);
      }
    },
    [mode]
  );

  return { isStreaming, startStream };
}
