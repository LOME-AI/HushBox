/**
 * Stable identifiers for pre-inference stages. Each stage type adds one
 * discriminant here and a corresponding entry in {@link StageDonePayload}.
 *
 * Stage ids surface in:
 * - SSE events (`stage:start`, `stage:done`, `stage:error`)
 * - {@link STAGE_LABELS} for "what to display while running"
 * - billing breadcrumbs that flow into `usage_records.source_id`
 */
export type StageId = 'smart-model';

/**
 * Payload of the `stage:done` SSE event, discriminated by `stageId`.
 *
 * Each stage variant carries its own success-shape — Smart Model returns the
 * resolved model id and name. Future stages add variants here:
 *
 * ```ts
 * | { stageId: 'prompt-enhancer'; originalLength: number; enhancedLength: number }
 * | { stageId: 'history-compressor'; originalCount: number; compressedCount: number }
 * ```
 *
 * The frontend `switch (payload.stageId)` exhaustively dispatches.
 */
export interface StageDonePayload {
  stageId: 'smart-model';
  resolvedModelId: string;
  resolvedModelName: string;
}

/** Payload of the `stage:start` SSE event — generic across all stages. */
export interface StageStartPayload {
  stageId: StageId;
  assistantMessageId: string;
}

/** Payload of the `stage:error` SSE event — generic across all stages. */
export interface StageErrorPayload {
  stageId: StageId;
  assistantMessageId: string;
  errorCode: string;
}

/** Wrapper that carries the assistantMessageId alongside a discriminated done payload. */
export interface StageDoneEnvelope {
  assistantMessageId: string;
  payload: StageDonePayload;
}
