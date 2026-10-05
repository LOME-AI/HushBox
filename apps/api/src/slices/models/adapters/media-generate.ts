import { z } from 'zod';
import { invalidRequestError } from './inference-error.js';
import { AdapterDefect } from './language-adapter.js';
import type { FilePartMapper, InferenceEvent, InferenceRequest, Usage } from '@hushbox/shared';

/**
 * Shared mapping for the media generate call-shapes (image/video): one
 * non-streaming SDK call whose result becomes media-start/media-done pairs
 * plus the terminal finish. The FilePartMapper decides where bytes rest.
 *
 * OpenRouter's video model surfaces `providerMetadata.openrouter.generationId`
 * and the authoritative inline `providerMetadata.openrouter.cost`. Its image
 * model (a dedicated images API) surfaces neither, so image finishes carry no
 * generation id, and the image adapter reads the cost off the response itself.
 * A missing id is not a failure; a missing cost leaves settlement on the
 * deterministic estimate.
 */

/** The result surface shared by the SDK's generated image/video files. */
export interface GeneratedMediaFile {
  readonly mediaType: string;
  readonly uint8Array: Uint8Array;
}

const openrouterMediaMetadataSchema = z.looseObject({
  openrouter: z
    .looseObject({
      generationId: z.string().nullish(),
      cost: z.number().nullish(),
    })
    .nullish(),
});

/** Pull `openrouter.generationId` from a media result's provider metadata (best-effort). */
export function extractMediaGenerationId(metadata?: unknown): string | undefined {
  if (metadata === undefined || metadata === null) return undefined;
  const parsed = openrouterMediaMetadataSchema.safeParse(metadata);
  if (!parsed.success) return undefined;
  const id = parsed.data.openrouter?.generationId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Pull the authoritative inline `openrouter.cost` (USD) from a media result's
 * provider metadata, where the video path carries it; the image path reads its
 * cost off the response instead. Absent on the pathological missing-cost path,
 * where settlement estimates.
 */
export function extractMediaCostUsd(metadata?: unknown): number | undefined {
  if (metadata === undefined || metadata === null) return undefined;
  const parsed = openrouterMediaMetadataSchema.safeParse(metadata);
  if (!parsed.success) return undefined;
  const cost = parsed.data.openrouter?.cost;
  return typeof cost === 'number' ? cost : undefined;
}

export function mediaPromptFromInputs(inputs: InferenceRequest['inputs']): string {
  const texts = inputs.map((part) => {
    if (part.modality !== 'text') {
      // Media inputs ride by reference (ciphertext in R2); resolving them is
      // the engine's ValueStore seam — the adapter never holds storage access.
      throw invalidRequestError(
        `Unsupported input modality for media generate call: ${part.modality}`
      );
    }
    return part.text;
  });
  if (texts.length === 0) {
    throw invalidRequestError('Media generation requires a text prompt');
  }
  return texts.join('\n');
}

export function mediaOutputEvents(
  files: readonly GeneratedMediaFile[],
  mapFilePart?: FilePartMapper
): InferenceEvent[] {
  if (mapFilePart === undefined) {
    // Defect, not an expected failure: the caller invoked a media family
    // without supplying the FilePartMapper contract.
    throw new AdapterDefect(
      'media generate adapter: generated file received without a mapFilePart contract'
    );
  }
  return files.flatMap((file, index) => {
    // The SDK types GeneratedFile bytes as Uint8Array<ArrayBufferLike> but
    // constructs them from plain buffers (base64 payloads), never
    // SharedArrayBuffer-backed views — the narrowing is safe and zero-copy.
    const [start, done] = mapFilePart(
      { mediaType: file.mediaType, data: file.uint8Array as Uint8Array<ArrayBuffer> },
      index
    );
    return [start, done];
  });
}

/**
 * Build the terminal finish for a media generation. The generation id (video
 * only) and the provider cost (the inline cost either family returns) are both
 * optional — a media call with neither still finishes successfully, and
 * settlement estimates when no cost is present.
 */
export function mediaFinishEvent(
  providerMetadata: unknown,
  usage: Usage,
  providerCostUsd?: number
): InferenceEvent {
  const generationId = extractMediaGenerationId(providerMetadata);
  return {
    kind: 'finish',
    metadata: {
      ...(generationId === undefined ? {} : { generationId }),
      ...(providerCostUsd === undefined ? {} : { providerCostUsd }),
      usage,
      finishReason: 'stop',
    },
  };
}
