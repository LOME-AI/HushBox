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

// ============================================================================
// Hook
// ============================================================================

/**
 * Unified chat stream hook that handles both authenticated and guest modes.
 *
 * @param mode - 'authenticated' for logged-in users, 'guest' for anonymous users
 *
 * Differences between modes:
 * - authenticated: Uses `/chat/stream`, credentials: 'include'
 * - guest: Uses `/guest/stream`, X-Guest-Token header, handles rate limiting
 */
export function useChatStream(mode: StreamMode): ChatStreamHook {
  const [isStreaming, setIsStreaming] = useState(false);

  const startStream = useCallback(
    async (request: StreamRequest, options?: StreamOptions): Promise<StreamResult> => {
      setIsStreaming(true);

      try {
        const endpoint = mode === 'guest' ? '/guest/stream' : '/chat/stream';
        const headers: HeadersInit = { 'Content-Type': 'application/json' };

        if (mode === 'guest') {
          headers['X-Guest-Token'] = getGuestToken();
        }

        const fetchOptions: RequestInit = {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
          signal: options?.signal ?? null,
        };

        if (mode === 'authenticated') {
          fetchOptions.credentials = 'include';
        }

        const response = await fetch(`${getApiUrl()}${endpoint}`, fetchOptions);

        if (!response.ok) {
          const data: unknown = await response.json();

          // Guest-specific: Handle rate limit error
          if (mode === 'guest' && response.status === 429) {
            const errorData = data as { error?: string; limit?: number; remaining?: number };
            throw new GuestRateLimitError(
              errorData.error ?? 'Daily limit exceeded',
              errorData.limit ?? 5,
              errorData.remaining ?? 0
            );
          }

          const errorMessage =
            typeof data === 'object' &&
            data !== null &&
            'error' in data &&
            typeof data.error === 'string'
              ? data.error
              : 'Stream request failed';
          throw new Error(errorMessage);
        }

        // Verify content-type before attempting to parse SSE
        const contentType = response.headers.get('Content-Type');
        if (!contentType?.includes('text/event-stream')) {
          const errorData: unknown = await response.json().catch(() => ({}));
          throw new Error(
            typeof errorData === 'object' &&
              errorData !== null &&
              'error' in errorData &&
              typeof errorData.error === 'string'
              ? errorData.error
              : 'Expected SSE stream but received different content type'
          );
        }

        if (!response.body) {
          throw new Error('Response body is null');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let streamError: Error | null = null;
        let streamDone = false;

        const parser = createSSEParser({
          onStart: (data) => {
            options?.onStart?.(data);
          },
          onToken: (tokenContent) => {
            options?.onToken?.(tokenContent);
          },
          onError: (errorData) => {
            streamError = new Error(errorData.message);
          },
          onDone: () => {
            streamDone = true;
          },
        });

        try {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- standard pattern for async iterator
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            parser.processChunk(decoder.decode(value, { stream: true }));

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- streamError mutated in onError callback
            if (streamError) {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- streamError is Error when truthy
              throw streamError;
            }
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- streamDone mutated in onDone callback
            if (streamDone) {
              break;
            }
          }

          return {
            userMessageId: parser.getUserMessageId(),
            assistantMessageId: parser.getAssistantMessageId(),
            content: parser.getContent(),
          };
        } finally {
          reader.cancel().catch(() => {
            // Reader cleanup errors can be ignored
          });
        }
      } finally {
        setIsStreaming(false);
      }
    },
    [mode]
  );

  return { isStreaming, startStream };
}
