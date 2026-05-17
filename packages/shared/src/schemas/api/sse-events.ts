import { z } from 'zod';

/**
 * Wire-level Zod schemas for the SSE events emitted by the chat stream.
 *
 * The frontend SSE consumer parses each event payload through these to catch
 * malformed payloads at the boundary instead of letting `as` casts mask them.
 */

export const startModelEntrySchema = z.object({
  modelId: z.string(),
  assistantMessageId: z.string(),
});

export const startEventDataSchema = z.object({
  userMessageId: z.string(),
  models: z.array(startModelEntrySchema),
});

export const modelTokenDataSchema = z.object({
  modelId: z.string(),
  content: z.string(),
});

export const modelDoneDataSchema = z.object({
  modelId: z.string(),
  assistantMessageId: z.string(),
});

export const modelErrorDataSchema = z.object({
  modelId: z.string(),
  message: z.string(),
  code: z.string(),
});

/**
 * `model:media:start` — emitted server-side BEFORE the gateway call begins so
 * the UI can swap the generic "Loading…" placeholder for "Generating image…"
 * before the long wait. `assistantMessageId` lets the UI bind the event to a
 * specific slot when multiple models stream concurrently. `mimeType` may be
 * a placeholder (e.g. `application/octet-stream`) at this stage; the precise
 * mime is delivered later via `model:done`.
 */
export const modelMediaStartDataSchema = z.object({
  modelId: z.string(),
  assistantMessageId: z.string(),
  mediaType: z.enum(['image', 'audio', 'video']),
  mimeType: z.string(),
});

/**
 * `model:media:progress` — synthetic progress percent (0-100) for long-running
 * media generations (today: video). Server emits up to 95% pre-completion at
 * fixed intervals derived from an EXPECTED duration; clients should treat
 * `model:done` as the authoritative 100%.
 */
export const modelMediaProgressDataSchema = z.object({
  modelId: z.string(),
  assistantMessageId: z.string(),
  percent: z.number().min(0).max(100),
});

/**
 * Backend writer always emits a `message` (it's required by the writer's input
 * contract), so the parser can require it too. `code` stays optional since
 * not every error path classifies a code.
 */
export const sseErrorDataSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
});

/**
 * Done-event content item — standalone wire shape, NOT extended from
 * `contentItemResponseSchema`. The two schemas serve different surfaces:
 *
 * - `contentItemResponseSchema` (in `conversations.ts`) describes a fully
 *   hydrated row returned by the conversation read endpoint. Every field
 *   exists on that row (text-only fields are `null` on media rows and vice
 *   versa).
 * - This schema describes the *streaming* delivery shape produced by
 *   `serializeTextContentItem` / `serializeMediaContentItem` in
 *   `apps/api/src/lib/stream-pipeline.ts`. Those serializers omit fields that
 *   don't apply to the content type (text omits storageKey/mimeType/sizeBytes/
 *   width/height/durationMs; media omits encryptedBlob; both omit storageKey
 *   because the client uses `downloadUrl` instead). The wire payload is
 *   intentionally smaller than the read row.
 *
 * Reusing the read schema via `.extend()` previously made every media done
 * event fail validation (missing `storageKey`), silently dropping the `onDone`
 * callback and forcing image renders through the slower fallback URL path.
 */
export const doneContentItemSchema = z
  .object({
    id: z.string(),
    contentType: z.enum(['text', 'image', 'audio', 'video']),
    position: z.number().int().nonnegative(),
    encryptedBlob: z.string().nullable().optional(),
    downloadUrl: z.string().optional(),
    mimeType: z.string().nullable().optional(),
    sizeBytes: z.number().int().nullable().optional(),
    width: z.number().int().nullable().optional(),
    height: z.number().int().nullable().optional(),
    durationMs: z.number().int().nullable().optional(),
    modelName: z.string().nullable(),
    cost: z.string().nullable(),
    isSmartModel: z.boolean(),
  })
  .loose();

/** Wrap-once envelope: one wrapped content key + N symmetric ciphertext items. */
export const doneMessageEnvelopeSchema = z.object({
  wrappedContentKey: z.string(),
  contentItems: z.array(doneContentItemSchema),
});

/** Per-model envelope plus billing/sequence metadata, one entry per assistant slot. */
export const doneModelEntrySchema = doneMessageEnvelopeSchema.extend({
  modelId: z.string(),
  assistantMessageId: z.string(),
  aiSequence: z.number().int().nonnegative(),
  cost: z.string(),
});

/**
 * Final `done` event payload (wrap-once envelope). Trial chat emits `done`
 * with `{}` (no body), so every top-level field is optional; the chat path
 * carries the full envelope (userMessageId, sequences, cost, models[]).
 */
export const doneEventDataSchema = z.object({
  userMessageId: z.string().optional(),
  assistantMessageId: z.string().optional(),
  userSequence: z.number().int().nonnegative().optional(),
  aiSequence: z.number().int().nonnegative().optional(),
  epochNumber: z.number().int().min(1).optional(),
  cost: z.string().optional(),
  userEnvelope: doneMessageEnvelopeSchema.optional(),
  models: z.array(doneModelEntrySchema).optional(),
});

/** Stage ids supported by the pre-inference pipeline. Mirrors `StageId` in pre-inference/events.ts. */
const stageIdSchema = z.literal('smart-model');

/** `stage:start` — generic across all stage types; `modelId` only set when a stage runs per-slot. */
export const stageStartPayloadSchema = z.object({
  stageId: stageIdSchema,
  assistantMessageId: z.string(),
  modelId: z.string().optional(),
});

/**
 * Inner discriminated payload of the `stage:done` event. The smart-model
 * variant carries the resolved model id/name plus an optional
 * `fallbackOccurred` hint when the classifier failed and the slot defaulted
 * to the cheapest eligible model.
 */
export const stageDoneInnerPayloadSchema = z.object({
  stageId: stageIdSchema,
  resolvedModelId: z.string(),
  resolvedModelName: z.string(),
  fallbackOccurred: z.boolean().optional(),
});

/**
 * `stage:done` — wire envelope: `{ assistantMessageId, payload }`. The
 * `payload` carries the discriminated shape (one variant per stageId).
 */
export const stageDonePayloadSchema = z.object({
  assistantMessageId: z.string(),
  payload: stageDoneInnerPayloadSchema,
});

/**
 * `stage:error` — generic across all stage types. Mirrors the writer side,
 * which emits `{ stageId, assistantMessageId, errorCode }` and may also carry
 * `modelId`/`message` for stage failures bound to a specific slot.
 */
export const stageErrorPayloadSchema = z.object({
  stageId: stageIdSchema,
  assistantMessageId: z.string(),
  errorCode: z.string(),
  modelId: z.string().optional(),
  message: z.string().optional(),
});

export type StartEventDataParsed = z.infer<typeof startEventDataSchema>;
export type ModelTokenDataParsed = z.infer<typeof modelTokenDataSchema>;
export type ModelDoneDataParsed = z.infer<typeof modelDoneDataSchema>;
export type ModelErrorDataParsed = z.infer<typeof modelErrorDataSchema>;
export type ModelMediaStartDataParsed = z.infer<typeof modelMediaStartDataSchema>;
export type ModelMediaProgressDataParsed = z.infer<typeof modelMediaProgressDataSchema>;
export type SSEErrorDataParsed = z.infer<typeof sseErrorDataSchema>;
export type DoneEventDataParsed = z.infer<typeof doneEventDataSchema>;
export type DoneMessageEnvelopeParsed = z.infer<typeof doneMessageEnvelopeSchema>;
export type DoneModelEntryParsed = z.infer<typeof doneModelEntrySchema>;
export type StageStartPayloadParsed = z.infer<typeof stageStartPayloadSchema>;
export type StageDonePayloadParsed = z.infer<typeof stageDonePayloadSchema>;
export type StageDoneInnerPayloadParsed = z.infer<typeof stageDoneInnerPayloadSchema>;
export type StageErrorPayloadParsed = z.infer<typeof stageErrorPayloadSchema>;
