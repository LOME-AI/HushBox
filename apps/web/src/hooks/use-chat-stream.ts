import { useState, useCallback } from 'react';
import { getApiUrl } from '../lib/api';
import { getGuestToken } from '../lib/guest-token';
import { createSSEParser } from '../lib/sse-client';

// ============================================================================
// Types
// ============================================================================

export type StreamMode = 'authenticated' | 'guest';

interface AuthenticatedStreamRequest {
  conversationId: string;
  model: string;
}

interface GuestStreamMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface GuestStreamRequest {
  messages: GuestStreamMessage[];
  model: string;
}

export type StreamRequest = AuthenticatedStreamRequest | GuestStreamRequest;

interface StreamResult {
  userMessageId: string;
  assistantMessageId: string;
  content: string;
}

interface StreamOptions {
  onToken?: (token: string) => void;
  onStart?: (ids: { userMessageId: string; assistantMessageId: string }) => void;
  signal?: AbortSignal;
}

export class GuestRateLimitError extends Error {
  public readonly limit: number;
  public readonly remaining: number;
  public readonly isRateLimited = true;

  constructor(message: string, limit: number, remaining: number) {
    super(message);
    this.name = 'GuestRateLimitError';
    this.limit = limit;
    this.remaining = remaining;
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
  const endpoint = mode === 'guest' ? '/api/guest/stream' : '/api/chat/stream';
  const headers: HeadersInit = { 'Content-Type': 'application/json' };

  if (mode === 'guest') {
    headers['X-Guest-Token'] = getGuestToken();
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

function extractErrorMessage(data: unknown): string {
  if (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof data.error === 'string'
  ) {
    return data.error;
  }
  return 'Stream request failed';
}

function handleStreamError(mode: StreamMode, status: number, data: unknown): never {
  if (mode === 'guest' && status === 429) {
    const errorData = data as { error?: string; limit?: number; remaining?: number };
    throw new GuestRateLimitError(
      errorData.error ?? 'Daily limit exceeded',
      errorData.limit ?? 5,
      errorData.remaining ?? 0
    );
  }
  throw new Error(extractErrorMessage(data));
}

async function validateSSEResponse(
  response: Response
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const contentType = response.headers.get('Content-Type');
  if (!contentType?.includes('text/event-stream')) {
    const errorData: unknown = await response.json().catch(() => ({}));
    throw new Error(
      extractErrorMessage(errorData) || 'Expected SSE stream but received different content type'
    );
  }

  if (!response.body) {
    throw new Error('Response body is null');
  }

  return response.body.getReader();
}

interface StreamState {
  error: Error | null;
  done: boolean;
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
        const streamState: StreamState = { error: null, done: false };

        const parser = createSSEParser({
          onStart: (data) => options?.onStart?.(data),
          onToken: (tokenContent) => options?.onToken?.(tokenContent),
          onError: (errorData) => {
            streamState.error = new Error(errorData.message);
          },
          onDone: () => {
            streamState.done = true;
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
