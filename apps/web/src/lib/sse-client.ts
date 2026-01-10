/**
 * SSE (Server-Sent Events) parsing utilities.
 *
 * Provides reusable functionality for parsing SSE streams from the API.
 */

export interface SSELineResult {
  type: 'event' | 'data';
  value: string;
}

/**
 * Parse a single SSE line.
 * Returns null for empty lines, comments, or unknown line types.
 */
export function parseSSELine(line: string): SSELineResult | null {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith(':')) {
    return null;
  }

  if (trimmed.startsWith('event: ')) {
    return { type: 'event', value: trimmed.slice(7).trim() };
  }

  if (trimmed.startsWith('data: ')) {
    return { type: 'data', value: trimmed.slice(6).trim() };
  }

  return null;
}

export interface SSEHandlers {
  onStart?: (data: { userMessageId: string; assistantMessageId: string }) => void;
  onToken?: (content: string) => void;
  onError?: (error: { message: string; code?: string }) => void;
  onDone?: () => void;
}

export interface SSEParser {
  processChunk: (chunk: string) => void;
  getUserMessageId: () => string;
  getAssistantMessageId: () => string;
  getContent: () => string;
}

/**
 * Create an SSE parser with event handlers.
 * Handles buffering and parsing of SSE data across multiple chunks.
 */
export function createSSEParser(handlers: SSEHandlers): SSEParser {
  let buffer = '';
  let currentEvent = '';
  let userMessageId = '';
  let assistantMessageId = '';
  let content = '';

  function processChunk(chunk: string): void {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const parsed = parseSSELine(line);

      if (!parsed) {
        continue;
      }

      if (parsed.type === 'event') {
        currentEvent = parsed.value;
      } else if (currentEvent) {
        try {
          const data: unknown = JSON.parse(parsed.value);

          if (currentEvent === 'start') {
            const startData = data as { userMessageId: string; assistantMessageId: string };
            userMessageId = startData.userMessageId;
            assistantMessageId = startData.assistantMessageId;
            handlers.onStart?.(startData);
          } else if (currentEvent === 'token') {
            const tokenData = data as { content: string };
            content += tokenData.content;
            handlers.onToken?.(tokenData.content);
          } else if (currentEvent === 'error') {
            const errorData = data as { message: string; code?: string };
            handlers.onError?.(errorData);
          } else if (currentEvent === 'done') {
            handlers.onDone?.();
          }
        } catch {
          // Invalid JSON, skip this data line
        }
      }
    }
  }

  return {
    processChunk,
    getUserMessageId: () => userMessageId,
    getAssistantMessageId: () => assistantMessageId,
    getContent: () => content,
  };
}
