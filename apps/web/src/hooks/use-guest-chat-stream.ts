import { useState, useCallback } from 'react';
import { getApiUrl } from '../lib/api';
import { getGuestToken } from '../lib/guest-token';
import { createSSEParser } from '../lib/sse-client';

interface GuestMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface GuestStreamRequest {
  messages: GuestMessage[];
  model: string;
}

interface GuestStreamResult {
  assistantMessageId: string;
  content: string;
}

interface GuestStreamOptions {
  onToken?: (token: string) => void;
  onStart?: (data: { assistantMessageId: string }) => void;
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

interface GuestChatStreamHook {
  isStreaming: boolean;
  startStream: (
    request: GuestStreamRequest,
    options?: GuestStreamOptions
  ) => Promise<GuestStreamResult>;
}

export function useGuestChatStream(): GuestChatStreamHook {
  const [isStreaming, setIsStreaming] = useState(false);

  const startStream = useCallback(
    async (
      request: GuestStreamRequest,
      options?: GuestStreamOptions
    ): Promise<GuestStreamResult> => {
      setIsStreaming(true);

      try {
        const guestToken = getGuestToken();

        const response = await fetch(`${getApiUrl()}/guest/stream`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Guest-Token': guestToken,
          },
          body: JSON.stringify(request),
          signal: options?.signal ?? null,
        });

        if (!response.ok) {
          const data: unknown = await response.json();

          // Handle rate limit error specially
          if (response.status === 429) {
            const errorData = data as { error?: string; limit?: number; remaining?: number };
            const error = new GuestRateLimitError(
              errorData.error ?? 'Daily limit exceeded',
              errorData.limit ?? 5,
              errorData.remaining ?? 0
            );
            throw error;
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

        if (!response.body) {
          throw new Error('Response body is null');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let streamError: Error | null = null;
        let streamDone = false;

        const parser = createSSEParser({
          onStart: (data) => {
            options?.onStart?.({ assistantMessageId: data.assistantMessageId });
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

            // These are mutated by parser callbacks, eslint doesn't understand this
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (streamError !== null) {
              // eslint-disable-next-line @typescript-eslint/only-throw-error
              throw streamError;
            }
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (streamDone) {
              break;
            }
          }

          return {
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
    []
  );

  return { isStreaming, startStream };
}
