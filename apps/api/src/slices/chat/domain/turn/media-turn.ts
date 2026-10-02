import {
  ERROR_CODES,
  IMAGE_MIME_TYPES,
  compileParamSpec,
  mediaTag,
  textTag,
} from '@hushbox/shared';
import { MEDIA_PARAMETER_NAMES } from '@hushbox/shared/affordability';
import { buildWorkflow, modelCall, workflowInputs } from '../../../workflows/index.js';
import { createModelPricingResolver } from '../../../models/index.js';
import { validationError } from '../../../../lib/errors/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import { CHAT_TURN_HOOKS, CHAT_TURN_INPUT, CHAT_TURN_NODE_ID } from '../constants.js';
import { createTurnCompileRegistries, multiModelNodeId, withStorageStamp } from './definition.js';
import type { MediaParameterName } from '@hushbox/shared/affordability';
import type { TurnModality } from './pricing.js';
import type { NodeRegistryContext, createConstraintRegistry } from '../../../workflows/index.js';
import type { ModelPricingResolver } from '../../../models/index.js';
import type { Database } from '@hushbox/db';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Result, ResultAsync } from '../../../../lib/result/index.js';
import type { ModelDescriptor, ParamSpec, WorkflowDefinition } from '@hushbox/shared';
import type { TurnBudget } from './definition.js';

/** The non-text chat modalities reachable from a text prompt. */
export type MediaTurnModality = 'image' | 'video';

/**
 * The accepted mime set a media turn's sink output tag declares per modality —
 * the same default allowlist the engine derives a media model's output port
 * from, so the node's declared producer tag matches the model it runs. Only the
 * output port needs it (a media turn's input is the text prompt).
 *
 * Parity with the legacy pipeline's ALLOWED_MEDIA_MIME_TYPES: the image and
 * video subsets are identical, and every mime here passes that allowlist at
 * storage.put (the R2 adapter re-validates against it). Legacy's only extra
 * members are its audio mimes — audio is a deferred modality, deliberately
 * absent from MediaTurnModality, not a narrowing of image/video.
 */
export const MEDIA_TURN_MIME_TYPES: Record<MediaTurnModality, readonly [string, ...string[]]> = {
  image: IMAGE_MIME_TYPES,
  video: ['video/mp4', 'video/webm'],
};

/**
 * A turn must run on a model whose SOLE output is the turn's own modality. The
 * modelCall produce tag is a sink (not compile-checked against the model), so
 * this is the gate that refuses a mismatched model with a typed validation
 * error. An unknown model (absent descriptor) is ok here — the compile step
 * then refuses it as an unknown model.
 *
 * It answers both directions of one question: a media turn over a text model,
 * and a `text` turn over a media model. The second direction has no media
 * build to sit inside — a text turn is compiled by
 * `compileSingleTurn`/`compileMultiModelTurnOutcome` in `definition.ts`, which are modality-blind
 * by construction (graded by
 * `apps/api/src/slices/chat/domain/turn/definition-modality.integration.test.ts`)
 * — so the paid route gates its pinned list through
 * {@link assertModelsProduceModality} before the compile, where the trial route
 * already refuses a media descriptor.
 */
export function assertModelProducesModality(
  descriptor: ModelDescriptor | undefined,
  modality: TurnModality
): Result<void, DomainError> {
  if (descriptor === undefined) return ok();
  if (descriptor.outputs.length === 1 && descriptor.outputs[0] === modality) return ok();
  return err(
    validationError(
      `model does not produce '${modality}' output`,
      undefined,
      ERROR_CODES.UNSUPPORTED_MODALITY
    )
  );
}

/** The same modality gate across every model of a turn's list — one bad
 * model refuses the whole build (matching the text multi-model behavior:
 * `assertModelsWebSearchCapable` and the compile both fail the whole list).
 * The SINGLE authority on list semantics for both modality directions: the
 * media build calls it, and so does the paid route's text-turn gate, so the two
 * directions cannot drift on what a mixed list does. */
export function assertModelsProduceModality(
  models: readonly string[],
  resolve: ModelPricingResolver,
  modality: TurnModality
): Result<void, DomainError> {
  for (const model of models) {
    const produces = assertModelProducesModality(resolve(model), modality);
    if (produces.isErr()) return produces;
  }
  return ok();
}

/**
 * The generation parameters a media turn carries onto every modelCall, keyed by
 * the catalog's own media axis names — the same keys the descriptor's ParamSpecs
 * are minted under, so the request, the domain check and the wire fragment all
 * speak one vocabulary. Values stay `unknown`: the authority on what each axis
 * accepts is the selected model's ParamSpec, never a type here.
 */
type MediaTurnGenerationParams = Readonly<Partial<Record<MediaParameterName, unknown>>>;

/**
 * Refuse a media turn whose requested parameters fall outside the domains the
 * selected models declare. This is the ONE per-model domain authority: the
 * request schema validates shape only (a global option list would be a second
 * domain), and this gate compiles each descriptor's own ParamSpecs through the
 * shared compiler — the same one admission and the execution pre-flight use.
 *
 * Only axes the descriptor actually declares are checked, because an undeclared
 * axis is UNCONSTRAINED, not forbidden (the compiler's `strictObject` would
 * otherwise refuse a duration for a model that simply states no duration set).
 * One bad model refuses the whole list, matching the modality gate above; an
 * unknown model falls through to the compile step's unknown-model refusal.
 */
export function assertModelsAcceptMediaParams(
  models: readonly string[],
  resolve: ModelPricingResolver,
  params: MediaTurnGenerationParams
): Result<void, DomainError> {
  for (const model of models) {
    const descriptor = resolve(model);
    if (descriptor === undefined) continue;
    const declared: Record<string, ParamSpec> = {};
    const requested: Record<string, unknown> = {};
    for (const name of Object.values(MEDIA_PARAMETER_NAMES)) {
      const spec = descriptor.parameters[name];
      const value = params[name];
      if (spec === undefined || value === undefined) continue;
      declared[name] = spec;
      requested[name] = value;
    }
    if (!compileParamSpec(declared).safeParse(requested).success) {
      return err(validationError(`model '${model}' does not offer the requested media parameters`));
    }
  }
  return ok();
}

interface MediaTurnParams {
  readonly models: readonly string[];
  readonly modality: MediaTurnModality;
  /**
   * The generation parameters carried onto the modelCall (`aspectRatio`, and
   * for video `durationSeconds`/`resolution`), mapped 1:1 from the request's
   * `imageConfig`/`videoConfig` and refused at build when a selected model does
   * not offer the requested value.
   */
  readonly params: MediaTurnGenerationParams;
  readonly nodes: NodeRegistryContext;
  readonly constraints: ReturnType<typeof createConstraintRegistry>;
  /**
   * The payer's turn budget. Media is paid-only and always persists, so its
   * hold must reserve the storage settlement bills (media byte-storage + the
   * prompt char-storage); the budget carries the new message's char count the
   * stamp records. Omitted only by unit callers that price no storage.
   */
  readonly budget?: TurnBudget;
}

/**
 * The media turn: one media `modelCall` per selected model (1–5), every node
 * consuming the same text prompt and producing the requested modality (image
 * or video), all deadline-classed `media`. One model is the media analogue of
 * `buildSingleModelTurn` — the exact historical one-node shape under
 * `CHAT_TURN_NODE_ID`, which settlement keys the charge and assistant message
 * on. Two or more mirrors `buildMultiModelTurn`'s legacy fan-out (the engine's
 * `fanOut` is a single static-model body, so it is N static sibling nodes):
 * each sibling is `optional` + `onError: 'skip'` under its own
 * `multiModelNodeId`, so one model failing skips its branch (no output, no
 * charge, no message) while the successful subset persists and bills — and
 * all models failing terminal-fails the run with nothing persisted or billed.
 * The generation `params` ride every node to the media adapter. Media is
 * paid-only (trial is single-model text), so the paid chat hooks always apply.
 */
export function buildMediaTurn(params: MediaTurnParams): Result<WorkflowDefinition, DomainError> {
  const inputs = workflowInputs({ [CHAT_TURN_INPUT]: textTag() });
  const produces = mediaTag(params.modality, MEDIA_TURN_MIME_TYPES[params.modality]);
  const shared = {
    accepts: textTag(),
    in: inputs.ports[CHAT_TURN_INPUT],
    produces,
    params: params.params,
  } as const;
  const nodes =
    params.models.length === 1 && params.models[0] !== undefined
      ? [modelCall({ id: CHAT_TURN_NODE_ID, model: params.models[0], ...shared })]
      : params.models.map((model, index) =>
          modelCall({
            id: multiModelNodeId(index),
            model,
            optional: true,
            onError: 'skip',
            ...shared,
          })
        );
  return (
    buildWorkflow({
      deadlineClass: 'media',
      hooks: CHAT_TURN_HOOKS,
      inputs,
      nodes,
      registries: { nodes: params.nodes, constraints: params.constraints },
    })
      // Media is a paid-only, always-persisting turn, so the persisting chat hooks
      // always apply and the stamp is what makes admission reserve the media
      // byte-storage + prompt char-storage settlement will bill.
      .map((compiled) => withStorageStamp(compiled.definition, params.budget, CHAT_TURN_HOOKS))
      .mapErr((errors) =>
        validationError('chat media turn definition could not be compiled', errors)
      )
  );
}

/**
 * Builds the media turn end to end from the request's db, mirroring
 * `buildTurnDefinition` / `buildMultiModelTurnDefinition`: one catalog snapshot
 * read feeds the compile registries, and `buildMediaTurn` compiles one media
 * modelCall per selected model. Every model is validated against the exposed
 * catalog (unknown / unexposed / non-ZDR / wrong output modality all fail the
 * whole build closed — the text multi-model refusal behavior).
 */
interface MediaTurnDefinitionOptions {
  /** The generation parameters carried onto every media node (image/video config). */
  readonly params: MediaTurnGenerationParams;
  /**
   * The payer's turn budget. Media always persists, so the definition is stamped
   * and admission reserves the media byte-storage + prompt char-storage settlement
   * bills (the prompt char count rides the budget).
   */
  readonly budget: TurnBudget;
}

export function buildMediaTurnDefinition(
  deps: { readonly db: Database; readonly telemetry: Telemetry },
  models: readonly string[],
  modality: MediaTurnModality,
  options: MediaTurnDefinitionOptions
): ResultAsync<WorkflowDefinition, DomainError> {
  return createModelPricingResolver({ db: deps.db, telemetry: deps.telemetry }).andThen(
    (pricingResolver) => {
      // A modelCall's produce tag is a sink, so graph-compile never checks a
      // model's output modality against the requested one — a text model would
      // otherwise build an "image turn". Assert every model's sole output IS
      // the requested modality here; an unknown model (absent descriptor)
      // falls through to the compile step's unknown-model refusal.
      return assertModelsProduceModality(models, pricingResolver, modality)
        .andThen(() => assertModelsAcceptMediaParams(models, pricingResolver, options.params))
        .andThen(() => {
          const registries = createTurnCompileRegistries(pricingResolver);
          return buildMediaTurn({
            models,
            modality,
            params: options.params,
            nodes: registries.nodes,
            constraints: registries.constraints,
            budget: options.budget,
          });
        });
    }
  );
}
