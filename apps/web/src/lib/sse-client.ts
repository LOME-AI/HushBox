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

export interface DoneEventData {
  userMessageId: string;
  assistantMessageId: string;
  userSequence: number;
  aiSequence: number;
  epochNumber: number;
  cost: string;
}

export interface SSEHandlers {
  onStart?: (data: { userMessageId: string; assistantMessageId: string }) => void;
  onToken?: (content: string) => void;
  onError?: (error: { message: string; code?: string }) => void;
  onDone?: (data: DoneEventData) => void;
}

export interface SSEParser {
  processChunk: (chunk: string) => void;
  getUserMessageId: () => string;
  getAssistantMessageId: () => string;
  getContent: () => string;
}

interface ParserState {
  userMessageId: string;
  assistantMessageId: string;
  content: string;
}

type EventHandler = (data: unknown, state: ParserState) => void;

function createEventHandlers(handlers: SSEHandlers): Record<string, EventHandler> {
  return {
    start: (data, state) => {
      const startData = data as { userMessageId: string; assistantMessageId: string };
      state.userMessageId = startData.userMessageId;
      state.assistantMessageId = startData.assistantMessageId;
      handlers.onStart?.(startData);
    },
    token: (data, state) => {
      const tokenData = data as { content: string };
      state.content += tokenData.content;
      handlers.onToken?.(tokenData.content);
    },
    error: (data) => {
      const errorData = data as { message: string; code?: string };
      handlers.onError?.(errorData);
    },
    done: (data) => {
      const doneData = data as DoneEventData;
      handlers.onDone?.(doneData);
    },
  };
}

function processDataLine(
  eventType: string,
  value: string,
  eventHandlers: Record<string, EventHandler>,
  state: ParserState
): void {
  const handler = eventHandlers[eventType];
  if (!handler) return;

  try {
    const data: unknown = JSON.parse(value);
    handler(data, state);
  } catch {
    // Invalid JSON, skip
  }
}

export function createSSEParser(handlers: SSEHandlers): SSEParser {
  let buffer = '';
  let currentEvent = '';
  const state: ParserState = { userMessageId: '', assistantMessageId: '', content: '' };
  const eventHandlers = createEventHandlers(handlers);

  function processChunk(chunk: string): void {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const parsed = parseSSELine(line);
      if (!parsed) continue;

      if (parsed.type === 'event') {
        currentEvent = parsed.value;
      } else if (currentEvent) {
        processDataLine(currentEvent, parsed.value, eventHandlers, state);
      }
    }
  }

  return {
    processChunk,
    getUserMessageId: () => state.userMessageId,
    getAssistantMessageId: () => state.assistantMessageId,
    getContent: () => state.content,
  };
}
