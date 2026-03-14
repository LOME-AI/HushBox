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

export interface ModelTokenData {
  modelId: string;
  content: string;
}

export interface ModelDoneData {
  modelId: string;
  assistantMessageId: string;
  cost: string;
}

export interface ModelErrorData {
  modelId: string;
  message: string;
}

export interface StartModelEntry {
  modelId: string;
  assistantMessageId: string;
}

export interface StartEventData {
  userMessageId: string;
  models: StartModelEntry[];
}

export interface SSEHandlers {
  onStart?: (data: StartEventData) => void;
  onToken?: (data: ModelTokenData) => void;
  onError?: (error: { message: string; code?: string }) => void;
  onDone?: (data: DoneEventData) => void;
  onModelDone?: (data: ModelDoneData) => void;
  onModelError?: (data: ModelErrorData) => void;
}

export interface SSEParser {
  processChunk: (chunk: string) => void;
  getUserMessageId: () => string;
  getModelContent: (modelId: string) => string;
}

interface ParserState {
  userMessageId: string;
  modelContent: Map<string, string>;
}

type EventHandler = (data: unknown, state: ParserState) => void;

function createEventHandlers(handlers: SSEHandlers): Record<string, EventHandler> {
  return {
    start: (data, state) => {
      const startData = data as StartEventData;
      state.userMessageId = startData.userMessageId;
      handlers.onStart?.(startData);
    },
    token: (data, state) => {
      const tokenData = data as ModelTokenData;
      const existing = state.modelContent.get(tokenData.modelId) ?? '';
      state.modelContent.set(tokenData.modelId, existing + tokenData.content);
      handlers.onToken?.(tokenData);
    },
    error: (data) => {
      const errorData = data as { message: string; code?: string };
      handlers.onError?.(errorData);
    },
    'model:done': (data) => {
      const modelDoneData = data as ModelDoneData;
      handlers.onModelDone?.(modelDoneData);
    },
    'model:error': (data) => {
      const modelErrorData = data as ModelErrorData;
      handlers.onModelError?.(modelErrorData);
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
  const state: ParserState = {
    userMessageId: '',
    modelContent: new Map(),
  };
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
    getModelContent: (modelId: string) => state.modelContent.get(modelId) ?? '',
  };
}
