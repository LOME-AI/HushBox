import {
  buildClassifierMessages,
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  ERROR_CODE_CLASSIFIER_FAILED,
  resolveClassifierOutput,
  truncateForClassifier,
  type TruncationInput,
} from '@hushbox/shared';

import type { TextRequest } from '../../services/ai/index.js';

import type { PreInferenceRunArgs, PreInferenceStage } from './types.js';
import type { PreInferenceOutcome } from '@hushbox/shared';

export interface SmartModelStageConfig {
  /** Cheapest eligible text model — used to make the classifier call. */
  classifierModelId: string;
  /** Models the classifier may resolve to — already filtered by tier and budget. */
  eligibleInferenceIds: readonly string[];
  /** Worst-case classifier cost in cents (with fees) for budget reservation. */
  classifierWorstCaseCents: number;
  /** Lookup for the model name + description used in the classifier prompt and SSE done payload. */
  modelMetadataById: ReadonlyMap<string, { name: string; description: string }>;
  /** Most recent user + assistant message used as the classifier's context. */
  conversationContext: TruncationInput;
}

/**
 * Concrete pre-inference stage that picks one model from a pre-filtered
 * eligible list by asking the cheapest-eligible model to act as a router.
 *
 * Failure modes — all surface as `CLASSIFIER_FAILED`:
 * - Classifier stream throws (network, gateway, or `setClassifierFailure` in tests)
 * - Classifier finishes without a generationId (cannot bill)
 * - Classifier output can't be fuzzy-resolved to an eligible id
 *
 * On failure, emits `stage:error` and returns `ok: false` so the executor
 * aborts the chain. Sibling slots (explicit selections) keep streaming.
 */
export function createSmartModelStage(config: SmartModelStageConfig): PreInferenceStage {
  return {
    id: 'smart-model',
    reserveCents: () => config.classifierWorstCaseCents,
    run: (args) => runSmartModelStage(config, args),
  };
}

function buildClassifierRequest(config: SmartModelStageConfig): {
  request: TextRequest;
  messages: ReturnType<typeof buildClassifierMessages>;
} {
  const eligibleWithDescriptions = config.eligibleInferenceIds.map((id) => ({
    id,
    description: config.modelMetadataById.get(id)?.description ?? '',
  }));
  const messages = buildClassifierMessages({
    truncatedContext: truncateForClassifier(config.conversationContext),
    eligibleModels: eligibleWithDescriptions,
  });
  const request: TextRequest = {
    modality: 'text',
    model: config.classifierModelId,
    messages,
    maxOutputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP,
  };
  return { request, messages };
}

interface ClassifierStreamResult {
  outputText: string;
  generationId: string | null;
}

async function consumeClassifierStream(
  aiClient: PreInferenceRunArgs['aiClient'],
  request: TextRequest
): Promise<ClassifierStreamResult> {
  let outputText = '';
  let generationId: string | null = null;
  for await (const event of aiClient.stream(request)) {
    if (event.kind === 'text-delta') {
      outputText += event.content;
    } else if (event.kind === 'finish') {
      generationId = event.providerMetadata?.generationId ?? null;
    }
  }
  return { outputText, generationId };
}

async function runSmartModelStage(
  config: SmartModelStageConfig,
  args: PreInferenceRunArgs
): Promise<PreInferenceOutcome> {
  const { aiClient, writer, assistantMessageId } = args;

  await writer.writeStageStart({ stageId: 'smart-model', assistantMessageId });

  const { request, messages } = buildClassifierRequest(config);

  let result: ClassifierStreamResult;
  try {
    result = await consumeClassifierStream(aiClient, request);
  } catch {
    return failure(writer, assistantMessageId);
  }

  const resolvedId = resolveClassifierOutput(result.outputText, config.eligibleInferenceIds);
  if (result.generationId === null || resolvedId === null) {
    return failure(writer, assistantMessageId);
  }

  const resolvedName = config.modelMetadataById.get(resolvedId)?.name ?? resolvedId;
  await writer.writeStageDone({
    assistantMessageId,
    payload: {
      stageId: 'smart-model',
      resolvedModelId: resolvedId,
      resolvedModelName: resolvedName,
    },
  });

  return {
    ok: true,
    transformation: { resolvedModelId: resolvedId },
    billing: {
      stageId: 'smart-model',
      modelId: config.classifierModelId,
      generationId: result.generationId,
      inputContent: messages.map((m) => m.content).join('\n\n'),
      outputContent: result.outputText,
    },
  };
}

async function failure(
  writer: PreInferenceRunArgs['writer'],
  assistantMessageId: string
): Promise<PreInferenceOutcome> {
  await writer.writeStageError({
    stageId: 'smart-model',
    assistantMessageId,
    errorCode: ERROR_CODE_CLASSIFIER_FAILED,
  });
  return { ok: false, errorCode: ERROR_CODE_CLASSIFIER_FAILED };
}
