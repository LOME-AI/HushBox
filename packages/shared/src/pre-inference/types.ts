import type { StageId } from './events.js';

/**
 * The transformations a stage can apply to the downstream inference request.
 *
 * Stages merge their transformation into the cumulative result. Subsequent
 * stages see the merged state. The pipeline reads the final merged
 * transformation when constructing the actual inference call.
 *
 * Add new transformation fields as new stages need them — extending this
 * interface is additive and never breaks existing stages.
 */
export interface InferenceTransformation {
  /** Replace the model id used for the main inference call. */
  resolvedModelId?: string;
  /** Replace the prompt fed to the inference call (used by media prompt enhancers). */
  resolvedPrompt?: string;
  /** Override individual fields of the modality-specific config. */
  resolvedConfig?: Record<string, unknown>;
}

/**
 * Billing breadcrumb a stage emits when it makes its own LLM call.
 *
 * Persisted as one `usage_records` row with `source_id` set to the
 * assistantMessageId of the slot that owned this stage chain. This way each
 * stage's call is independently auditable while sharing the same source row
 * as the main inference.
 */
export interface PreInferenceBilling {
  stageId: StageId;
  modelId: string;
  generationId: string;
  inputContent: string;
  outputContent: string;
}

/**
 * The result of running a single stage. `ok: true` means the transformation
 * is applicable; `ok: false` means the slot fails entirely (the executor
 * stops the chain and returns the error code; sibling slots keep streaming).
 */
export type PreInferenceOutcome =
  | {
      ok: true;
      transformation: InferenceTransformation;
      billing: PreInferenceBilling | null;
    }
  | { ok: false; errorCode: string };
