import type { InferenceTransformation, PreInferenceBilling } from '@hushbox/shared';

import type { AIClient } from '../../services/ai/index.js';
import type { SSEEventWriter } from '../stream-handler.js';

import type { PreInferenceStage } from './types.js';

export interface ExecuteChainArgs {
  stages: readonly PreInferenceStage[];
  aiClient: AIClient;
  writer: SSEEventWriter;
  assistantMessageId: string;
}

export type ExecuteChainResult =
  | {
      ok: true;
      /** Cumulative transformation merged across every stage in the chain. */
      transformation: InferenceTransformation;
      /** Billing breadcrumbs from stages that made billable LLM calls. */
      billings: PreInferenceBilling[];
    }
  | { ok: false; errorCode: string };

/**
 * Run a chain of pre-inference stages sequentially.
 *
 * Each stage receives the cumulative transformation from earlier stages.
 * The executor merges each stage's returned transformation into the rolling
 * state and forwards it to the next stage as `upstream`.
 *
 * On the first stage that returns `ok: false`, the executor stops and
 * returns the failure. The caller (pipeline) is responsible for emitting
 * any slot-level error SSE event and releasing the slot's reservation.
 * Sibling slots in the parallel multi-model set are unaffected.
 */
export async function executePreInferenceChain(
  args: ExecuteChainArgs
): Promise<ExecuteChainResult> {
  const { stages, aiClient, writer, assistantMessageId } = args;
  let merged: InferenceTransformation = {};
  const billings: PreInferenceBilling[] = [];

  for (const stage of stages) {
    const outcome = await stage.run({
      aiClient,
      writer,
      assistantMessageId,
      upstream: merged,
    });
    if (!outcome.ok) {
      return { ok: false, errorCode: outcome.errorCode };
    }
    merged = { ...merged, ...outcome.transformation };
    if (outcome.billing !== null) {
      billings.push(outcome.billing);
    }
  }

  return { ok: true, transformation: merged, billings };
}
