import { ERROR_CODES, pinnedSourceIds, smartSlotSelected } from '@hushbox/shared';
import { respondDomainError } from '../../../middleware/pipeline-manifest.js';
import {
  TRIAL_MESSAGE_COST_CAP_NANO_USD,
  TRIAL_TURN_HOOKS,
  buildTrialSmartModelTurnDefinition,
  compileAutoEffortTurn,
  compileTrialSingleTurn,
  createErrorResponse,
  listDescriptors,
  trialReasoningSelection,
} from '../domain/index.js';
import { turnPromptCharacterCount } from './request-shapes.js';
import { trialGateRejection } from './refusals.js';
import { pinnedEffortOption, reasoningEffortOption } from './turn-definition.js';
import type { Context } from 'hono';
import type {
  ChatHistoryMessage,
  ModelDescriptor,
  ReasoningEffortSelection,
  TurnSourceList,
} from '@hushbox/shared';
import type { MultiModelTurnBuild } from '../domain/index.js';
import type { AppEnv, RefusalResponse } from '../../../middleware/pipeline-manifest.js';
import type { TurnBudget } from '../domain/index.js';

/**
 * Trial reasoning acceptance: only levels whose shared-plan token cost
 * fits the 1¢ ceiling run. Computed through the same plan + headroom math the
 * build prices with — never a hardcoded level list. An unknown model falls
 * through untouched (the compile refuses it as unknown).
 *
 * `auto` never reaches here — {@link trialAutoDefinitionOrRefusal} answers it
 * first, and the parameter type says so — because auto on a trial send is the
 * classifier's question exactly as it is on a paid one.
 */
function trialReasoningOrRefusal(
  c: Context<AppEnv>,
  target: ModelDescriptor | undefined,
  budget: TurnBudget,
  requested: Exclude<ReasoningEffortSelection, 'auto'> | undefined
):
  | { readonly response: RefusalResponse }
  | { readonly selection: ReasoningEffortSelection | undefined } {
  if (requested === undefined || target === undefined) return { selection: requested };
  const decision = trialReasoningSelection(target, budget, requested);
  if (decision.isErr()) return { response: respondDomainError(c, decision.error) };
  if (!decision.value.accepted) {
    return {
      response: c.json(createErrorResponse(ERROR_CODES.TRIAL_MESSAGE_TOO_EXPENSIVE), 402),
    };
  }
  return { selection: decision.value.selection };
}

/**
 * The trial Smart Model build. `auto` engages the classifier's effort dimension
 * on the composite turn; an explicit level pins it instead, exactly as on the
 * paid path — the sentinel has one rule, not one per surface.
 */
async function trialSmartModelDefinitionOrRefusal(
  c: Context<AppEnv>,
  body: { readonly reasoningEffort?: ReasoningEffortSelection | undefined },
  budget: TurnBudget
): Promise<MultiModelTurnBuild | RefusalResponse> {
  const build = await buildTrialSmartModelTurnDefinition(
    { db: c.var.db, telemetry: c.var.logger },
    {
      now: new Date(),
      budget,
      classifyEffort: body.reasoningEffort === 'auto',
      reasoningOff: body.reasoningEffort === 'off',
      ...pinnedEffortOption(body.reasoningEffort),
    }
  );
  if (build.isErr()) return respondDomainError(c, build.error);
  const built = build.value;
  if (!built.buildable) {
    return c.json(createErrorResponse(ERROR_CODES.TRIAL_MESSAGE_TOO_EXPENSIVE), 402);
  }
  return built;
}

/**
 * The trial send's turn definition, or the refusal response. The Smart slot
 * selects the composite smartModel turn under the
 * trial hooks — candidates derived server-side from the trial-eligible
 * catalog subset and the fixed 1¢ per-message ceiling (trial has no wallet,
 * so the ceiling plays the balance's role); an empty eligible set refuses
 * with 402 TRIAL_MESSAGE_TOO_EXPENSIVE, the same refusal class as a concrete
 * over-cap model. Every other model runs the MODEL/AFFORDABILITY gate first,
 * then the compile its effort selection calls for: the pinned+auto classifier
 * stage on `auto`, the single-model compile otherwise. Every path runs BEFORE
 * the quota INCR — a refusal burns no slot.
 */
export async function trialTurnDefinitionOrRefusal(
  c: Context<AppEnv>,
  body: {
    readonly turnSources: TurnSourceList;
    readonly prompt: string;
    readonly reasoningEffort?: ReasoningEffortSelection | undefined;
  },
  history: ChatHistoryMessage[]
): Promise<MultiModelTurnBuild | RefusalResponse> {
  // Trial has no wallet, so the fixed 1¢ per-message cap plays the payer
  // balance's role for the output-token ceiling — the funding mirrors the trial
  // per-message cap (TRIAL_MESSAGE_COST_CAP_NANO_USD). The 'free' kind gives
  // no cushion.
  const budget: TurnBudget = {
    // Custom instructions are an account feature the trial body cannot carry,
    // so the priced prompt is the base system prompt — exactly what it sends.
    promptCharacterCount: turnPromptCharacterCount({}, body.prompt, history),
    inputCharacterCount: body.prompt.length,
    funding: { kind: 'free', spendableNanoUsd: TRIAL_MESSAGE_COST_CAP_NANO_USD },
  };
  if (smartSlotSelected(body.turnSources)) {
    return trialSmartModelDefinitionOrRefusal(c, body, budget);
  }
  const [model] = pinnedSourceIds(body.turnSources);
  /* v8 ignore next -- the trial schema bounds the list to exactly one source,
     which the branch above consumes when it is the slot; this narrows for the
     compiler only */
  if (model === undefined) return c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
  // The MODEL/AFFORDABILITY gate runs BEFORE the compile, and on a non-text
  // model it is the refusal that fires, whatever the effort selection: the
  // compile's accept/refuse answer does not move with a model's one output
  // modality, so it never refuses one for being media. It is also the ONLY
  // refusal such a send meets here — the gate returns, so neither the
  // acceptance step below nor the compile it feeds ever runs. An unknown model
  // is the opposite case — absent from the exposed catalog, it gives the gate
  // no target, so the gate waves it through and the compile below refuses it.
  const catalog = await listDescriptors({ db: c.var.db, telemetry: c.var.logger });
  if (catalog.isErr()) return respondDomainError(c, catalog.error);
  const target = catalog.value.find((descriptor) => descriptor.id === model);
  // The gate prices the identical character count the budget above carries, so
  // the gate and the compiled definition measure one prompt.
  const gateRejection = trialGateRejection(c, target, catalog.value, budget.promptCharacterCount);
  if (gateRejection !== null) return gateRejection;
  // `auto` is the classifier's question on every tier, so it is answered before
  // the per-level acceptance gate — which never sees it.
  const requested = body.reasoningEffort;
  if (requested === 'auto') {
    return trialAutoDefinitionOrRefusal(c, catalog.value, model, budget);
  }
  const trialReasoning = trialReasoningOrRefusal(c, target, budget, requested);
  if ('response' in trialReasoning) return trialReasoning.response;
  return trialSingleTurnDefinition(c, catalog.value, model, {
    budget,
    ...reasoningEffortOption(trialReasoning.selection),
  });
}

/**
 * The trial single-model compile, reached from the non-`auto` branch whenever
 * {@link trialReasoningOrRefusal} answers with a selection rather than a
 * refusal, and from `auto` only on {@link trialAutoDefinitionOrRefusal}'s
 * fallback outcome, where no classifier call is bought. A turn whose answer fit
 * cannot land within the per-message ceiling is refused with 402
 * TRIAL_MESSAGE_TOO_EXPENSIVE, as the classified arm refuses one: nothing after
 * the route compares a trial turn's estimate to that ceiling.
 *
 * It resolves the model through the catalog snapshot the gate above looked its
 * target up in, so every id it cannot resolve is one that gate found no target
 * for and therefore waved through, and it answers each of those with a typed
 * 400. The converse does not hold — that 400 has a second producer here:
 * a mandatory-reasoning model asked for `off` resolves perfectly well, is
 * passed through untouched by {@link trialReasoningOrRefusal} (`off`
 * short-circuits its acceptance check), and is refused by this compile for
 * disabling reasoning it cannot disable. An id the catalog does carry always
 * resolves, because `isExposedModel` admits only runnable shapes, and whether
 * the compile then accepts or refuses does not move with which one output
 * modality that shape has. A model kept off the trial for its modality (image
 * and video today) is therefore refused above as MEDIA_TRIAL_BLOCKED and never
 * reaches this compile.
 */
function trialSingleTurnDefinition(
  c: Context<AppEnv>,
  catalog: readonly ModelDescriptor[],
  model: string,
  turn: { readonly budget: TurnBudget; readonly reasoningEffort?: ReasoningEffortSelection }
): MultiModelTurnBuild | RefusalResponse {
  const compiled = compileTrialSingleTurn(catalog, model, turn);
  if (compiled.isErr()) return respondDomainError(c, compiled.error);
  if (compiled.value.kind === 'over-ceiling') {
    return c.json(createErrorResponse(ERROR_CODES.TRIAL_MESSAGE_TOO_EXPENSIVE), 402);
  }
  return { definition: compiled.value.definition };
}

/**
 * A trial send on `auto`, through the SAME pinned+auto compiler a paid send
 * takes — under the trial policy and against the per-message ceiling standing in
 * for a wallet. There is no trial-specific pricing here and none is needed: the
 * canonical estimator already prices the classifier's reserve, so the fitted cap
 * covers reserve plus answer by construction.
 *
 * The four outcomes are four different facts, told apart here exactly as
 * `pinnedAutoDefinitionOrNull` (`turn-definition.ts`) tells them apart on the paid arm:
 *
 * - no priceable classifier engine ⇒ the compile REFUSES and the typed
 *   classifier code ships as a 503, never a static level (§Reasoning Effort 5).
 *   Two projections over one field disagree: `trialGateVerdict` (the domain barrel) prices the
 *   pinned model through the plain money projection, which FLOORS a fractional
 *   context window, while the engine is drawn from the shared pool projection,
 *   which excludes one outright — so a catalog whose text rows all declare a
 *   fractional window admits the send and can classify nothing. Upstream data no
 *   longer produces that state: catalog normalization
 *   (`apps/api/src/slices/models/domain/catalog/normalize.ts`) drops a fractional
 *   window rather than storing it, and a windowless row is refused as ineligible
 *   (403) before this compile runs. So this arm answers a row persisted BEFORE
 *   that guard, and such a row heals on the first refresh that re-normalizes it —
 *   skip-unchanged compares exactly the content the guard changes;
 * - built ⇒ the classifier decides among the rungs the trial menu marks
 *   available, as it does on a paid turn, or the one available rung runs with no
 *   call;
 * - unaffordable ⇒ the trial menu marks no rung available, or the answer fit
 *   misses its floor, so this refuses.
 *   Nothing behind the compile would catch the substitution on either
 *   arm: the unclassified turn prices BELOW the classified one, so it is
 *   admitted and billed. Running it reasoning-free instead is the silent static
 *   fallback §Reasoning Effort 5 forbids by name;
 * - fallback ⇒ no classifier call, no charge, no reserve.
 *
 * The catalog is the snapshot the eligibility gate already read, so the engine
 * pick, the premium percentile and the compile cannot straddle a refresh.
 */
function trialAutoDefinitionOrRefusal(
  c: Context<AppEnv>,
  catalog: readonly ModelDescriptor[],
  model: string,
  budget: TurnBudget
): MultiModelTurnBuild | RefusalResponse {
  const auto = compileAutoEffortTurn(catalog, model, {
    budget,
    hooks: TRIAL_TURN_HOOKS,
    now: new Date(),
  });
  if (auto.isErr()) return respondDomainError(c, auto.error);
  if (auto.value.kind === 'built') return auto.value;
  if (auto.value.kind === 'unaffordable') {
    return c.json(createErrorResponse(ERROR_CODES.TRIAL_MESSAGE_TOO_EXPENSIVE), 402);
  }
  return trialSingleTurnDefinition(c, catalog, model, { budget, reasoningEffort: 'auto' });
}
