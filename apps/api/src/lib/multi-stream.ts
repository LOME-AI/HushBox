import type { InferenceStream } from '../services/ai/index.js';
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

async function collectSingleModel(
  entry: ModelStreamEntry,
  writer: SSEEventWriter
): Promise<MultiStreamResult> {
  let fullContent = '';
  let generationId: string | undefined;
  let error: Error | null = null;

  try {
    for await (const event of entry.stream) {
      switch (event.kind) {
        case 'text-delta': {
          if (event.content.length > 0) {
            fullContent += event.content;
            await writer.writeModelToken({ modelId: entry.modelId, content: event.content });
          }
          break;
        }
        case 'finish': {
          generationId = event.providerMetadata?.generationId;
          break;
        }
        // media-start and media-done are handled by future modality strategies
        default: {
          break;
        }
      }
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

  return { fullContent, generationId, error };
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
