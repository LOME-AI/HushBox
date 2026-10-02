import {
  CanonicalReasoningEffort,
  ERROR_CODES,
  pinnedSourceIds,
  smartSlotSelected,
} from '@hushbox/shared';
import { respondDomainError } from '../../../middleware/pipeline-manifest.js';
import {
  CHAT_TURN_HOOKS,
  assertModelsProduceModality,
  buildMediaTurnDefinition,
  buildAutoEffortTurnDefinition,
  buildMultiModelTurnDefinition,
  buildSmartModelTurnDefinition,
  buildTurnDefinition,
  createErrorResponse,
  listDescriptors,
  mediaTurnParams,
} from '../domain/index.js';
import type { Context } from 'hono';
import type { ReasoningEffortSelection, TurnSourceList, WorkflowDefinition } from '@hushbox/shared';
import type { MediaTurnBody, MultiModelTurnBuild, TurnModality } from '../domain/index.js';
import type { AppEnv, RefusalResponse } from '../../../middleware/pipeline-manifest.js';
import type { ChatRouteDeps, TurnBudget } from '../domain/index.js';

/**
 * A level or `auto` engages reasoning; absent leaves the turn reasoning-free.
 * `none` is not "engaged" (it never reserves thinking tokens) but is NOT a
 * no-op on text turns: the build wires the explicit hard-off
 * `{ enabled: false }` per reasoning-capable model.
 */
function reasoningEngaged(selection: ReasoningEffortSelection | undefined): boolean {
  return selection !== undefined && selection !== 'off';
}

/**
 * The level a send PINS, or `undefined` when it pins none: `auto` asks the
 * classifier and `off` rides its own hard-off carrier, so neither is a pin.
 * Read through the canonical enum rather than by excluding those two words, so
 * a rung added to the ladder is a pin here without a second edit.
 */
export function pinnedEffortOption(selection: ReasoningEffortSelection | undefined): {
  pinnedEffort?: CanonicalReasoningEffort;
} {
  const canonical = CanonicalReasoningEffort.safeParse(selection);
  return canonical.success ? { pinnedEffort: canonical.data } : {};
}

/** The `reasoningEffort` build option, spread only when the client sent one. */
export function reasoningEffortOption(selection: ReasoningEffortSelection | undefined): {
  reasoningEffort?: ReasoningEffortSelection;
} {
  return selection === undefined ? {} : { reasoningEffort: selection };
}

/**
 * An engaged reasoning selection (a level or `auto`) is a TEXT-turn option:
 * media models carry no reasoning object — refused here rather than silently
 * dropped. The Smart Model sentinel takes both: `auto` hands the level to the
 * classifier stage alongside the model, and an explicit level PINS it — the
 * candidate menu is then derived at that rung, so the concrete level is
 * validated against every model the turn could bind rather than against one
 * that does not exist yet. `none` stays legal on both: a media model has no
 * reasoning to turn off (a no-op), and the composite Smart turn stamps the
 * explicit `{ enabled: false }` hard-off wire onto its node params — applied
 * at runtime to whichever reasoning-capable non-mandatory candidate resolves;
 * a mandatory candidate keeps reasoning (it cannot disable, and one candidate
 * cannot refuse the whole server-picked composite).
 */
function engagedReasoningRefusal(
  c: Context<AppEnv>,
  body: {
    readonly modality?: TurnModality | undefined;
    readonly reasoningEffort?: ReasoningEffortSelection | undefined;
  }
): RefusalResponse | null {
  if (!reasoningEngaged(body.reasoningEffort)) return null;
  if (body.modality === 'image' || body.modality === 'video') {
    return c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
  }
  return null;
}

/**
 * A text turn's own modality gate, run BEFORE the compile — the same place on
 * the paid route that `trialGateRejection` (`refusals.ts`) occupies on the trial one, and
 * the same predicate the media path applies in the opposite direction. Without
 * it a body pinning a media model and asking for no `modality` is a TEXT turn
 * over a descriptor that produces no text, which the single-turn text compile
 * accepts: it is modality-blind by construction, so no gate behind this one
 * re-makes the refusal.
 *
 * The list walk is {@link assertModelsProduceModality}'s, not this function's:
 * "one bad model refuses the whole list" is one rule, and the media direction
 * already owns it inside its build. A second walk here would be a copy that has
 * to agree to be correct — the two directions could then drift on what a mixed
 * list does — so this resolves descriptors and delegates.
 *
 * Only PINNED sources are judged. The Smart slot names no model — its candidates
 * are derived server-side from the exposed catalog — so a slot-only turn skips
 * the catalog read entirely. An id the exposed catalog does not carry yields no
 * descriptor and passes here untouched; the compile behind this refuses it as an
 * unknown model, exactly as it does on the trial route.
 * Returns the refusal response, or null to proceed.
 */
async function textTurnModalityRefusal(
  c: Context<AppEnv>,
  turnSources: TurnSourceList
): Promise<RefusalResponse | null> {
  const pinned = pinnedSourceIds(turnSources);
  if (pinned.length === 0) return null;
  const catalog = await listDescriptors({ db: c.var.db, telemetry: c.var.logger });
  if (catalog.isErr()) return respondDomainError(c, catalog.error);
  const produces = assertModelsProduceModality(
    pinned,
    (id) => catalog.value.find((descriptor) => descriptor.id === id),
    'text'
  );
  return produces.isErr() ? respondDomainError(c, produces.error) : null;
}

/**
 * A media turn resolves its model list exactly like the text path — the pinned
 * sources in selected order (1–5, one sibling generation each) — every model
 * producing the modality and carrying the config as node params (video config
 * is guaranteed present by the schema refinement; image config defaults its
 * aspect ratio, so an absent one is {}).
 */
async function mediaDefinitionOrRefusal(
  c: Context<AppEnv>,
  body: MediaTurnBody,
  modality: 'image' | 'video',
  budget: TurnBudget
): Promise<WorkflowDefinition | RefusalResponse> {
  // Non-empty by the body shape: the source list requires an entry and the slot
  // cannot answer a media turn, so a parsed media body always pins a model.
  const models = pinnedSourceIds(body.turnSources);
  const media = await buildMediaTurnDefinition(
    { db: c.var.db, telemetry: c.var.logger },
    models,
    modality,
    { params: mediaTurnParams(body, modality), budget }
  );
  return media.match(
    (value) => value,
    (error) => respondDomainError(c, error)
  );
}

/**
 * Pinned model + auto: the generalized classifier stage owns the effort
 * choice via a single-candidate smartModel node offered the rungs the turn's
 * menu marks available, or runs the one available rung with no call. `null` =
 * build the regular
 * turn instead — a web-search turn never enters here, because the composite
 * node carries no tool loop; {@link singleModelDefinitionOrRefusal} sends that
 * turn to the fan-out compile instead. A non-eligible model falls back, where
 * `auto` resolves deterministically (the sole real choice) or reasoning-free,
 * with no classifier call, charge, or reserve.
 *
 * A payer whose menu marks no rung available is REFUSED here rather than fallen
 * back. Falling back substitutes a turn that resolves `auto` reasoning-free, and
 * that turn is CHEAPER than the classified one the payer could not afford — so
 * no downstream gate refuses it and settlement bills a turn nobody asked for.
 * That is the silent static fallback BILLING §Reasoning Effort 5 forbids, and
 * the pair of route pins named for this fixture is what holds the two prices on
 * their respective sides.
 *
 * `fallback` is a different fact and still builds the regular turn: it says the
 * effort question is already settled — at most one distinct resolved choice — not
 * that the money is absent. Only the unaffordable arm refuses.
 *
 * The refusal is emitted here rather than as a `DomainError` because
 * `STATUS_BY_DOMAIN_CODE` (`apps/api/src/lib/context/domain-error-status.ts`) carries no 402: a payable refusal routed through
 * that channel would ship as 400.
 */
async function pinnedAutoDefinitionOrNull(
  c: Context<AppEnv>,
  model: string,
  budget: TurnBudget
): Promise<MultiModelTurnBuild | RefusalResponse | null> {
  const auto = await buildAutoEffortTurnDefinition(
    { db: c.var.db, telemetry: c.var.logger },
    model,
    { budget, hooks: CHAT_TURN_HOOKS, now: new Date() }
  );
  if (auto.isErr()) return respondDomainError(c, auto.error);
  const built = auto.value;
  if (built.kind === 'unaffordable') {
    return c.json(createErrorResponse(ERROR_CODES.INSUFFICIENT_ADMISSION), 402);
  }
  return built.kind === 'built' ? built : null;
}

/**
 * The paid Smart Model build: `auto` engages the classifier's effort dimension,
 * an explicit level pins it instead — the candidates are then derived at that
 * rung, so the axis is answered before the classifier is asked anything.
 *
 * The WHOLE source list is handed over, not just the fact that a slot is in it:
 * the models pinned beside the slot are its answering siblings and the set its
 * candidate menu excludes, and where the slot sits decides the answer order.
 */
async function smartModelDefinitionOrRefusal(
  c: Context<AppEnv>,
  deps: ChatRouteDeps,
  body: {
    readonly turnSources: TurnSourceList;
    readonly reasoningEffort?: ReasoningEffortSelection | undefined;
    readonly webSearchEnabled?: boolean | undefined;
  },
  turn: { readonly userId: string; readonly budget: TurnBudget }
): Promise<MultiModelTurnBuild | RefusalResponse> {
  const build = await buildSmartModelTurnDefinition(
    { db: c.var.db, telemetry: c.var.logger, billing: deps.billing },
    {
      pinnedModels: pinnedSourceIds(body.turnSources),
      slotPosition: body.turnSources.findIndex((source) => source.kind === 'smart'),
      webSearchEnabled: body.webSearchEnabled === true,
      userId: turn.userId,
      now: new Date(),
      budget: turn.budget,
      classifyEffort: body.reasoningEffort === 'auto',
      reasoningOff: body.reasoningEffort === 'off',
      ...pinnedEffortOption(body.reasoningEffort),
    }
  );
  if (build.isErr()) return respondDomainError(c, build.error);
  const built = build.value;
  if (!built.buildable) {
    return c.json(createErrorResponse(ERROR_CODES.INSUFFICIENT_ADMISSION), 402);
  }
  return built;
}

/**
 * The turn definition, or the refusal response — the ONE model-resolution path
 * for every paid entrypoint (send, guest send, regenerate). A non-text
 * `modality` selects the media (image/video) turn over the pinned sources; the
 * Smart slot selects the composite smartModel turn (candidates derived
 * server-side from the exposed catalog + the paying wallet's balance — an empty
 * affordable set refuses with 402 INSUFFICIENT_ADMISSION, the same
 * affordability class admission enforces); two or more pinned sources are the
 * multi-model fan-out; one pinned source is the single-model text turn, for a
 * send and a regenerate alike. Every path validates its model(s) against the
 * exposed catalog inside the build — an unknown, unexposed, non-ZDR, or
 * wrong-modality model fails closed before the run starts.
 */
export async function turnDefinitionOrRefusal(
  c: Context<AppEnv>,
  deps: ChatRouteDeps,
  body: {
    readonly turnSources: TurnSourceList;
    readonly modality?: TurnModality | undefined;
    readonly webSearchEnabled?: boolean | undefined;
    readonly reasoningEffort?: ReasoningEffortSelection | undefined;
    readonly imageConfig?: Readonly<Record<string, unknown>> | undefined;
    readonly videoConfig?: Readonly<Record<string, unknown>> | undefined;
  },
  // The caller plus their payer budget — the output-token ceiling input for
  // every text path (single, multi, smart model). Media turns price
  // deterministically per generation and take no token ceiling.
  turn: { readonly userId: string; readonly budget: TurnBudget }
): Promise<MultiModelTurnBuild | RefusalResponse> {
  const reasoningRefusal = engagedReasoningRefusal(c, body);
  if (reasoningRefusal !== null) return reasoningRefusal;
  if (body.modality === 'image' || body.modality === 'video') {
    return asTurnBuild(await mediaDefinitionOrRefusal(c, body, body.modality, turn.budget));
  }
  const modalityRefusal = await textTurnModalityRefusal(c, body.turnSources);
  if (modalityRefusal !== null) return modalityRefusal;
  if (smartSlotSelected(body.turnSources)) {
    return smartModelDefinitionOrRefusal(c, deps, body, turn);
  }
  const pinned = pinnedSourceIds(body.turnSources);
  const webSearchEnabled = body.webSearchEnabled === true;
  const [single] = pinned;
  if (single !== undefined && pinned.length === 1) {
    return singleModelDefinitionOrRefusal(c, single, {
      budget: turn.budget,
      webSearchEnabled,
      ...reasoningEffortOption(body.reasoningEffort),
    });
  }
  return multiModelDefinitionOrRefusal(c, pinned, {
    budget: turn.budget,
    webSearchEnabled,
    ...reasoningEffortOption(body.reasoningEffort),
  });
}

/**
 * The fan-out compile: one answer node per model, and for ONE model the
 * collapsed single answer node — the only compile a PINNED turn can take that
 * emits a classifier beside a tool-carrying answer, which is why a searching
 * `auto` turn takes it.
 *
 * An `auto` turn whose funding holds no effort rung is refused here with 402,
 * before a run is claimed, as the browser's send gate refuses it. Built without
 * a classifier it would price below the turn the payer could not afford, so no
 * downstream gate would refuse it.
 */
async function multiModelDefinitionOrRefusal(
  c: Context<AppEnv>,
  models: readonly string[],
  options: {
    readonly budget: TurnBudget;
    readonly webSearchEnabled: boolean;
    readonly reasoningEffort?: ReasoningEffortSelection | undefined;
  }
): Promise<MultiModelTurnBuild | RefusalResponse> {
  const multi = await buildMultiModelTurnDefinition(
    { db: c.var.db, telemetry: c.var.logger },
    [...models],
    {
      webSearchEnabled: options.webSearchEnabled,
      budget: options.budget,
      now: new Date(),
      ...reasoningEffortOption(options.reasoningEffort),
    }
  );
  return multi.match(
    (outcome): MultiModelTurnBuild | RefusalResponse =>
      outcome.kind === 'built'
        ? builtTurn(outcome)
        : c.json(createErrorResponse(ERROR_CODES.INSUFFICIENT_ADMISSION), 402),
    (error) => respondDomainError(c, error)
  );
}

/** A built turn's definition and classifier prompt, as the send path carries them on. */
function builtTurn(build: MultiModelTurnBuild): MultiModelTurnBuild {
  return {
    definition: build.definition,
    ...(build.classifier === undefined ? {} : { classifier: build.classifier }),
  };
}

/**
 * The one-pinned-model text turn: the classifier-owned effort stage when the
 * send asks for `auto` and is eligible for it, otherwise the plain single
 * compile. A regenerate naming one model arrives here too, so a re-run resolves
 * exactly as the send that produced it did.
 */
async function singleModelDefinitionOrRefusal(
  c: Context<AppEnv>,
  model: string,
  options: {
    readonly budget: TurnBudget;
    readonly webSearchEnabled: boolean;
    readonly reasoningEffort?: ReasoningEffortSelection;
  }
): Promise<MultiModelTurnBuild | RefusalResponse> {
  if (options.reasoningEffort === 'auto') {
    // A classified effort and a web search are both wanted, and no single
    // compile carries both: the classifier's answer is a `smartModel` node,
    // whose schema has no tools at all. The fan-out compile does carry both,
    // and its one-model collapse keeps the turn a single answer node under the
    // id settlement expects. Money is untouched by the routing: the one
    // estimator prices the tool loop off that node's own tools, so no second
    // cost formula appears here.
    if (options.webSearchEnabled) {
      return multiModelDefinitionOrRefusal(c, [model], options);
    }
    const auto = await pinnedAutoDefinitionOrNull(c, model, options.budget);
    if (auto !== null) return auto;
  }
  const single = await buildTurnDefinition({ db: c.var.db, telemetry: c.var.logger }, model, {
    webSearchEnabled: options.webSearchEnabled,
    budget: options.budget,
    ...reasoningEffortOption(options.reasoningEffort),
  });
  return single.match(
    (definition): MultiModelTurnBuild | RefusalResponse => ({ definition }),
    (error) => respondDomainError(c, error)
  );
}

/** A path that yields a bare definition (or a refusal) as the shared build shape. */
function asTurnBuild(
  value: WorkflowDefinition | RefusalResponse
): MultiModelTurnBuild | RefusalResponse {
  return value instanceof Response ? value : { definition: value };
}
