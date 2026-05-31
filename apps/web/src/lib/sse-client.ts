/**
 * SSE (Server-Sent Events) parsing utilities.
 *
 * Provides reusable functionality for parsing SSE streams from the API.
 */

import {
  doneEventDataSchema,
  modelDoneDataSchema,
  modelErrorDataSchema,
  modelMediaProgressDataSchema,
  modelMediaStartDataSchema,
  modelTokenDataSchema,
  sseErrorDataSchema,
  stageDonePayloadSchema,
  stageErrorPayloadSchema,
  stageStartPayloadSchema,
  startEventDataSchema,
  STREAM_TIMEOUT_MS,
  ERROR_CODE_STREAM_TIMEOUT,
} from '@hushbox/shared';
import type { StageDonePayload, StageErrorPayload, StageStartPayload } from '@hushbox/shared';

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

/**
 * A single content item delivered in the SSE done event. Mirrors the
 * server-side shape in `apps/api/src/lib/stream-handler.ts`.
 */
export interface DoneContentItem {
  id: string;
  contentType: 'text' | 'image' | 'audio' | 'video';
  position: number;
  /** Base64-encoded symmetric ciphertext under the message content key. Text items only. */
  encryptedBlob?: string | null;
  storageKey?: string | null;
  /**
   * Presigned GET URL for media items, attached server-side after R2 upload
   * (mirrors `apps/api/src/lib/stream-handler.ts` `DoneContentItem.downloadUrl`).
   * When present, the client uses this URL directly instead of refetching one,
   * saving a round-trip immediately after generation.
   */
  downloadUrl?: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  modelName: string | null;
  cost: string | null;
  isSmartModel: boolean;
}

/**
 * Wrap-once envelope for a single persisted message delivered in the SSE done
 * event. Clients unwrap `wrappedContentKey` once with the epoch private key
 * and decrypt every content item with the resulting content key.
 */
export interface DoneMessageEnvelope {
  wrappedContentKey: string;
  contentItems: DoneContentItem[];
}

export interface DoneModelEntry extends DoneMessageEnvelope {
  modelId: string;
  assistantMessageId: string;
  aiSequence: number;
  cost: string;
}

export interface DoneEventData {
  userMessageId: string;
  assistantMessageId: string;
  userSequence: number;
  aiSequence: number;
  epochNumber: number;
  cost: string;
  /** Envelope for the user message itself (sender_type='user'). */
  userEnvelope?: DoneMessageEnvelope;
  /** Per-model envelopes + metadata, one entry per selected assistant message. */
  models?: DoneModelEntry[];
}

export interface ModelTokenData {
  modelId: string;
  content: string;
}

export interface ModelDoneData {
  modelId: string;
  assistantMessageId: string;
}

export interface ModelErrorData {
  modelId: string;
  message: string;
  code: string;
}

/**
 * Surfaced from the AI client's media-start event for live "Generating image…" UI.
 *
 * Emitted twice per media model: once pre-gateway with a placeholder mimeType
 * (e.g. `application/octet-stream`) so the UI can swap the placeholder
 * immediately, and once post-gateway with the real mime so the UI can prepare
 * the right `<img>`/`<video>`/`<audio>` element type.
 */
export interface ModelMediaStartData {
  modelId: string;
  assistantMessageId: string;
  mediaType: 'image' | 'audio' | 'video';
  mimeType: string;
}

/**
 * Synthetic progress percent (0-100) for long-running media generations
 * (today: video). Server emits up to 95% pre-completion at fixed intervals;
 * `model:done` is the authoritative 100%.
 */
export interface ModelMediaProgressData {
  modelId: string;
  assistantMessageId: string;
  percent: number;
}

export interface StartModelEntry {
  modelId: string;
  assistantMessageId: string;
}

export interface StartEventData {
  userMessageId: string;
  models: StartModelEntry[];
}

export interface StageDoneEventData {
  assistantMessageId: string;
  payload: StageDonePayload;
}

export interface SSEHandlers {
  onStart?: (data: StartEventData) => void;
  onToken?: (data: ModelTokenData) => void;
  onError?: (error: { message: string; code?: string }) => void;
  onDone?: (data: DoneEventData) => void;
  onModelDone?: (data: ModelDoneData) => void;
  onModelError?: (data: ModelErrorData) => void;
  onModelMediaStart?: (data: ModelMediaStartData) => void;
  /** Emitted only for video; payload `{ modelId, assistantMessageId, percent }`. */
  onModelMediaProgress?: (data: ModelMediaProgressData) => void;
  /** Emitted when a pre-inference stage starts; UI typically shows a label. */
  onStageStart?: (data: StageStartPayload) => void;
  /** Emitted when a pre-inference stage finishes successfully; payload is discriminated by stageId. */
  onStageDone?: (data: StageDoneEventData) => void;
  /** Emitted when a pre-inference stage fails; the slot is excluded from inference. */
  onStageError?: (data: StageErrorPayload) => void;
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

function logParseFailure(eventType: string, payload: unknown, error: unknown): void {
  if (import.meta.env.DEV) {
    console.warn(`SSE parse failure for event "${eventType}":`, error, payload);
  }
}

function createEventHandlers(handlers: SSEHandlers): Record<string, EventHandler> {
  return {
    start: (data, state) => {
      const parsed = startEventDataSchema.safeParse(data);
      if (!parsed.success) {
        logParseFailure('start', data, parsed.error);
        return;
      }
      state.userMessageId = parsed.data.userMessageId;
      handlers.onStart?.(parsed.data);
    },
    token: (data, state) => {
      const parsed = modelTokenDataSchema.safeParse(data);
      if (!parsed.success) {
        logParseFailure('token', data, parsed.error);
        return;
      }
      const existing = state.modelContent.get(parsed.data.modelId) ?? '';
      state.modelContent.set(parsed.data.modelId, existing + parsed.data.content);
      handlers.onToken?.(parsed.data);
    },
    error: (data) => {
      const parsed = sseErrorDataSchema.safeParse(data);
      if (!parsed.success) {
        logParseFailure('error', data, parsed.error);
        return;
      }
      const errorPayload: { message: string; code?: string } = {
        message: parsed.data.message,
        ...(parsed.data.code !== undefined && { code: parsed.data.code }),
      };
      handlers.onError?.(errorPayload);
    },
    'model:done': (data) => {
      const parsed = modelDoneDataSchema.safeParse(data);
      if (!parsed.success) {
        logParseFailure('model:done', data, parsed.error);
        return;
      }
      handlers.onModelDone?.(parsed.data);
    },
    'model:error': (data) => {
      const parsed = modelErrorDataSchema.safeParse(data);
      if (!parsed.success) {
        logParseFailure('model:error', data, parsed.error);
        return;
      }
      handlers.onModelError?.(parsed.data);
    },
    'model:media:start': (data) => {
      const parsed = modelMediaStartDataSchema.safeParse(data);
      if (!parsed.success) {
        logParseFailure('model:media:start', data, parsed.error);
        return;
      }
      handlers.onModelMediaStart?.(parsed.data);
    },
    'model:media:progress': (data) => {
      const parsed = modelMediaProgressDataSchema.safeParse(data);
      if (!parsed.success) {
        logParseFailure('model:media:progress', data, parsed.error);
        return;
      }
      handlers.onModelMediaProgress?.(parsed.data);
    },
    'stage:start': (data) => {
      const parsed = stageStartPayloadSchema.safeParse(data);
      if (!parsed.success) {
        logParseFailure('stage:start', data, parsed.error);
        return;
      }
      handlers.onStageStart?.(parsed.data as StageStartPayload);
    },
    'stage:done': (data) => {
      const parsed = stageDonePayloadSchema.safeParse(data);
      if (!parsed.success) {
        logParseFailure('stage:done', data, parsed.error);
        return;
      }
      handlers.onStageDone?.(parsed.data as StageDoneEventData);
    },
    'stage:error': (data) => {
      const parsed = stageErrorPayloadSchema.safeParse(data);
      if (!parsed.success) {
        logParseFailure('stage:error', data, parsed.error);
        return;
      }
      handlers.onStageError?.(parsed.data as StageErrorPayload);
    },
    done: (data) => {
      const parsed = doneEventDataSchema.safeParse(data);
      if (!parsed.success) {
        logParseFailure('done', data, parsed.error);
        return;
      }
      handlers.onDone?.(parsed.data as DoneEventData);
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
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn(`SSE JSON parse failure for event "${eventType}":`, error, value);
    }
  }
}

interface SSEChunkContext {
  buffer: string;
  currentEvent: string;
  dataBuffer: string;
  eventHandlers: Record<string, EventHandler>;
  state: ParserState;
}

function dispatchAccumulatedFrame(context: SSEChunkContext): void {
  if (context.dataBuffer.length === 0) {
    context.currentEvent = '';
    return;
  }
  const data = context.dataBuffer.endsWith('\n')
    ? context.dataBuffer.slice(0, -1)
    : context.dataBuffer;
  const eventType = context.currentEvent === '' ? 'message' : context.currentEvent;
  processDataLine(eventType, data, context.eventHandlers, context.state);
  context.currentEvent = '';
  context.dataBuffer = '';
}

function processOneLine(context: SSEChunkContext, rawLine: string): void {
  // Treat both LF-only and CRLF terminators as blank lines.
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

  if (line === '') {
    dispatchAccumulatedFrame(context);
    context.dataBuffer = '';
    return;
  }

  const parsed = parseSSELine(line);
  if (!parsed) return;

  if (parsed.type === 'event') {
    context.currentEvent = parsed.value;
    return;
  }
  context.dataBuffer += parsed.value + '\n';
}

export function createSSEParser(handlers: SSEHandlers): SSEParser {
  // Per the SSE spec
  // (https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation):
  // `data:` lines are accumulated (joined with `\n`) until a blank line, at
  // which point the event is dispatched and the event-type / data buffers
  // reset to defaults. Dispatching per-`data:`-line would mis-parse any frame
  // whose `data` value contained a literal newline (e.g. pretty-printed JSON
  // produced by `JSON.stringify(obj, null, 2)`, which Hono's `streamSSE`
  // splits into multiple `data:` lines).
  const context: SSEChunkContext = {
    buffer: '',
    currentEvent: '',
    dataBuffer: '',
    eventHandlers: createEventHandlers(handlers),
    state: { userMessageId: '', modelContent: new Map() },
  };

  function processChunk(chunk: string): void {
    context.buffer += chunk;
    const lines = context.buffer.split('\n');
    context.buffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      processOneLine(context, rawLine);
    }
  }

  return {
    processChunk,
    getUserMessageId: () => context.state.userMessageId,
    getModelContent: (modelId: string) => context.state.modelContent.get(modelId) ?? '',
  };
}

/**
 * Wraps a `reader.read()` so the consumer surfaces a synthetic timeout error
 * if no bytes have arrived within {@link STREAM_TIMEOUT_MS}. Lets the UI clear
 * the optimistic "streaming" state instead of hanging forever when the server
 * crashes mid-stream (after `start`, before `done`).
 *
 * Out of scope: reconnection. The consumer should treat the timeout as a hard
 * failure and let the user retry.
 */
export class StreamTimeoutError extends Error {
  public readonly code = ERROR_CODE_STREAM_TIMEOUT;

  constructor(message = 'Stream timed out', options?: ErrorOptions) {
    super(message, options);
    this.name = 'StreamTimeoutError';
  }
}

export async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = STREAM_TIMEOUT_MS
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new StreamTimeoutError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
