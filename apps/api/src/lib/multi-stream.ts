import type { InferenceEvent, InferenceStream } from '../services/ai/index.js';
import type { SSEEventWriter } from './stream-handler.js';

export interface ModelStreamEntry {
  modelId: string;
  assistantMessageId: string;
  stream: InferenceStream;
}

export interface MultiStreamResult {
  fullContent: string;
  /** Generation ID from the gateway's finish event — used post-hoc to fetch exact cost. */
  generationId: string | undefined;
  error: Error | null;
}

export interface MediaModelStreamEntry {
  modelId: string;
  assistantMessageId: string;
  stream: InferenceStream;
}

export interface MediaStreamResult {
  mediaBytes: Uint8Array | undefined;
  mimeType: string | undefined;
  width: number | undefined;
  height: number | undefined;
  durationMs: number | undefined;
  generationId: string | undefined;
  error: Error | null;
}

/**
 * Consumes an InferenceStream for a single model, invoking `handler` for each
 * event to fold state. Writes model:done on success or model:error on failure.
 * Catches all errors so parallel model streams continue independently.
 */
async function collectSingleModelEvents<TState>(
  entry: { modelId: string; assistantMessageId: string; stream: InferenceStream },
  writer: SSEEventWriter,
  handler: (event: InferenceEvent, state: TState) => Promise<TState> | TState,
  initialState: TState
): Promise<{ state: TState; error: Error | null }> {
  let state = initialState;
  let error: Error | null = null;

  try {
    for await (const event of entry.stream) {
      state = await handler(event, state);
    }

    await writer.writeModelDone({
      modelId: entry.modelId,
      assistantMessageId: entry.assistantMessageId,
      cost: '0',
    });
  } catch (error_) {
    error = error_ instanceof Error ? error_ : new Error('Unknown error');
    await writer.writeModelError({
      modelId: entry.modelId,
      message: error.message,
      code: 'STREAM_ERROR',
    });
  }

  return { state, error };
}

async function collectSingleModel(
  entry: ModelStreamEntry,
  writer: SSEEventWriter
): Promise<MultiStreamResult> {
  const initial: { fullContent: string; generationId: string | undefined } = {
    fullContent: '',
    generationId: undefined,
  };

  const { state, error } = await collectSingleModelEvents(
    entry,
    writer,
    async (event, s) => {
      switch (event.kind) {
        case 'text-delta': {
          if (event.content.length > 0) {
            await writer.writeModelToken({ modelId: entry.modelId, content: event.content });
            return { ...s, fullContent: s.fullContent + event.content };
          }
          return s;
        }
        case 'finish': {
          return { ...s, generationId: event.providerMetadata?.generationId };
        }
        default: {
          return s;
        }
      }
    },
    initial
  );

  return { fullContent: state.fullContent, generationId: state.generationId, error };
}

/**
 * Collects inference events from N model streams in parallel, writing
 * model-tagged SSE events as tokens arrive.
 *
 * Each model stream runs independently. If one fails, others continue.
 * Returns a Map of modelId → result (content, generationId, error).
 */
export async function collectMultiModelStreams(
  entries: ModelStreamEntry[],
  writer: SSEEventWriter
): Promise<Map<string, MultiStreamResult>> {
  const results = new Map<string, MultiStreamResult>();

  const promises = entries.map(async (entry) => {
    const result = await collectSingleModel(entry, writer);
    results.set(entry.modelId, result);
  });

  await Promise.all(promises);

  return results;
}

// ============================================================================
// Media stream collection
// ============================================================================

interface MediaCollectorState {
  mediaBytes: Uint8Array | undefined;
  mimeType: string | undefined;
  width: number | undefined;
  height: number | undefined;
  durationMs: number | undefined;
  generationId: string | undefined;
}

async function collectSingleMediaModel(
  entry: MediaModelStreamEntry,
  writer: SSEEventWriter
): Promise<MediaStreamResult> {
  const initial: MediaCollectorState = {
    mediaBytes: undefined,
    mimeType: undefined,
    width: undefined,
    height: undefined,
    durationMs: undefined,
    generationId: undefined,
  };

  const { state, error } = await collectSingleModelEvents(
    entry,
    writer,
    (event, s) => {
      switch (event.kind) {
        case 'media-done': {
          return {
            ...s,
            mediaBytes: event.bytes,
            mimeType: event.mimeType,
            width: event.width,
            height: event.height,
            durationMs: event.durationMs,
          };
        }
        case 'finish': {
          return { ...s, generationId: event.providerMetadata?.generationId };
        }
        default: {
          return s;
        }
      }
    },
    initial
  );

  return { ...state, error };
}

/**
 * Collects media inference events from N model streams in parallel.
 * Each model stream is expected to yield media-start → media-done → finish.
 * Returns a Map of modelId → MediaStreamResult.
 */
export async function collectMultiMediaModelStreams(
  entries: MediaModelStreamEntry[],
  writer: SSEEventWriter
): Promise<Map<string, MediaStreamResult>> {
  const results = new Map<string, MediaStreamResult>();

  const promises = entries.map(async (entry) => {
    const result = await collectSingleMediaModel(entry, writer);
    results.set(entry.modelId, result);
  });

  await Promise.all(promises);

  return results;
}
