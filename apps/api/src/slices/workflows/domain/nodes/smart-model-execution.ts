import {
  REASONING_OFF,
  ReasoningWire,
  candidateAnsweringAt,
  planReasoningOff,
  reasoningPlanModelFrom,
  smartModelClassifierDimensions,
  textTag,
  utcDayKeyAt,
} from '@hushbox/shared';
import { pickClassifiedEffortPlan } from '@hushbox/shared/affordability';
import { err } from '../../../../lib/result/index.js';
import { streamModelCall } from './model-call-execution.js';
import { validateNodeInput } from './node-input.js';
import { callInputOf, decisionOf } from './turn-decision.js';
import { portsAccepting } from '../engine/model-ports.js';
import type {
  ClassifierEffortLevel,
  InferenceRequest,
  ModelDescriptor,
  Node,
  NodePortDeclaration,
  ResolvedReasoningEffort,
  SchemaNameRegistry,
} from '@hushbox/shared';
import type { Result } from '../../../../lib/result/index.js';
import type {
  NodeExecution,
  NodeRunContext,
  NodeRunError,
  NodeRunSuccess,
} from '../engine/execution-registry.js';
import type { TurnDecision } from './turn-decision.js';
import type { ModelBinding, ModelCallStreamDeps } from './model-call-execution.js';

/**
 * The `smartModel` capability execution: the slot that carries the MODEL
 * dimension. It holds the candidate set — the only place a `MAX` over
 * alternatives is expressible — binds the turn's decision to one of them, and
 * streams the answer.
 *
 * It performs NO classification of its own. The decision arrives as a typed
 * envelope on the node's ordinary single input port, produced by a registered
 * reducer from an ordinary classifier `modelCall` (`docs/BILLING.md` §How the
 * decision reaches the answer), which is what makes the definition that is
 * priced the definition that executes.
 *
 * Semantics, stated exactly:
 * - a decision binds the candidate it carries, which the reducer resolved and
 *   clamped against this node's own list, and the answer runs at that
 *   candidate's cap for the decided rung. A decision carrying no candidate, one
 *   this node does not hold, or a rung the candidate has no cap for is a defect
 *   and throws before any provider call: this node never picks a fallback of
 *   its own, so it can never bind a pair the hold did not price;
 * - no decision on the port binds the node's one candidate, since only a slot
 *   with nothing to classify is handed raw text; a slot with a choice of
 *   candidates and no decision is the same defect;
 * - the effort axis takes the decision's own level with the axis open, the
 *   sender's pin with it closed, and nothing when neither exists: the axis's
 *   ONE declared fallback lives in the reducer, which is the only place that
 *   knows the axis's cheapest option.
 */

type SmartModelNode = Extract<Node, { type: 'smartModel' }>;

const SMART_MODEL_PORTS: NodePortDeclaration = { in: [textTag()], out: textTag() };

export interface SmartModelExecutionDeps extends Omit<ModelCallStreamDeps, 'binding'> {
  /** Every candidate's binding, keyed by model id — resolved with the node. */
  readonly candidates: ReadonlyMap<string, ModelBinding>;
  readonly schemas: SchemaNameRegistry;
}

export function createSmartModelExecution(deps: SmartModelExecutionDeps): NodeExecution {
  return {
    streaming: true,
    run: (node, input, ctx) => runSmartModel(deps, node as SmartModelNode, input, ctx),
  };
}

async function runSmartModel(
  deps: SmartModelExecutionDeps,
  node: SmartModelNode,
  input: readonly unknown[],
  ctx: NodeRunContext
): Promise<Result<NodeRunSuccess, NodeRunError>> {
  const validated = validateNodeInput(
    portsAccepting(SMART_MODEL_PORTS, node.inputSchema),
    deps.schemas,
    input
  );
  if (validated.isErr()) return err(validated.error);
  // The slot reads the turn's prompt off the decision envelope when its port
  // declares one, and off the raw text otherwise — one input port either way.
  const decision = decisionOf(input[0]);
  const prompt = callInputOf(input[0]);
  // A registered input schema the slot cannot read a prompt off is the same
  // class of failure as a port mismatch — an ordinary node failure, no spend.
  if (typeof prompt !== 'string') return err({});

  // Which axes are open, derived through the ONE shared authority admission's
  // classifier-reserve condition also reads.
  const dimensions = smartModelClassifierDimensions(node);
  // Only a MODEL-routing turn is badged Smart Model; a pinned-model
  // auto-effort turn (`classify.model === false`) keeps the user's own pick
  // unbadged.
  const badged = node.classify?.model ?? true;
  const effort = decidedEffort(node, dimensions, decision);
  return answerCall(deps, {
    node,
    candidate: boundCandidate(node, decision, effort),
    prompt,
    ctx,
    smartModelRan: badged,
    ...(effort === undefined ? {} : { effort }),
  });
}

/** A candidate of this node as it answers at one rung, its per-rung record read. */
type SlotCandidate = Omit<SmartModelNode['candidates'][number], 'rungCeilings'>;

/**
 * The candidate this answer runs, as it answers at the decided rung: the one the
 * decision carries, or, with no decision, the node's only candidate. Every other
 * case is a defect the build or the reducer made, so it throws here, before any
 * provider call, rather than binding something the hold did not price.
 */
function boundCandidate(
  node: SmartModelNode,
  decision: TurnDecision | undefined,
  effort: ClassifierEffortLevel | undefined
): SlotCandidate {
  const candidate = decidedCandidate(node, decision);
  if (effort === undefined) return candidate;
  const answering = candidateAnsweringAt(candidate, effort);
  if (answering === undefined) {
    throw new Error(`smartModel: candidate '${candidate.id}' has no cap for rung '${effort}'`);
  }
  return answering;
}

function decidedCandidate(
  node: SmartModelNode,
  decision: TurnDecision | undefined
): SmartModelNode['candidates'][number] {
  if (decision === undefined) {
    const [only, ...others] = node.candidates;
    if (only === undefined || others.length > 0) {
      throw new Error('smartModel: a slot with a choice of candidates was handed no decision');
    }
    return only;
  }
  if (decision.modelId === undefined) {
    throw new Error('smartModel: the decision binds no candidate');
  }
  const held = node.candidates.find((candidate) => candidate.id === decision.modelId);
  if (held === undefined) {
    throw new Error(
      `smartModel: the decision binds '${decision.modelId}', which the slot does not hold`
    );
  }
  return held;
}

/**
 * The effort the answer runs at. With the axis OPEN it is the decision's own
 * already-resolved level; with the axis CLOSED it is the sender's pin, which is
 * the same question answered before the turn started rather than by the
 * classifier. The two never both apply: a node carrying a pin declares the axis
 * closed, so a decision's effort is not this turn's answer and is ignored.
 *
 * `undefined` when neither exists — an unpinned closed axis, or an open axis no
 * decision reached. The axis's ONE declared fallback lives in the reducer (the
 * one place that knows the axis's cheapest option), so a slot that was handed
 * nothing rides its built params rather than inventing a second answer to the
 * same question.
 */
function decidedEffort(
  node: SmartModelNode,
  dimensions: { readonly effort: boolean },
  decision: TurnDecision | undefined
): ClassifierEffortLevel | undefined {
  if (!dimensions.effort) return node.pinnedEffort;
  return decision?.effort;
}

/**
 * The answer generation: the bound candidate, the node's params, the FULL run
 * history, streaming through the node's emit seam.
 */
interface AnswerCallArgs {
  readonly node: SmartModelNode;
  /** The bound candidate, carrying its cap for the decided rung. */
  readonly candidate: SlotCandidate;
  readonly prompt: string;
  readonly ctx: NodeRunContext;
  /** The routing pipeline ran — badge the answer. */
  readonly smartModelRan?: boolean;
  /** The canonical effort to apply to the answer call (auto turns). */
  readonly effort?: ClassifierEffortLevel;
}

/**
 * The node params for a hard-off (`none`) turn, applied per resolved
 * candidate: the build stamps ONE `{ enabled: false }` wire shared by every
 * candidate, but the hard-off ruling binds only reasoning-capable
 * NON-MANDATORY models. The shared off plan is the feasibility authority —
 * a mandatory candidate cannot disable (it keeps reasoning rather than
 * failing the whole server-picked composite) and a non-reasoning candidate
 * has nothing to turn off, so both drop the wire from the answer call.
 * Non-off wires never appear in smartModel params (classified effort is
 * carved in at runtime, never built in), so they pass through untouched.
 */
function paramsRespectingHardOff(
  base: Readonly<Record<string, unknown>>,
  descriptor: ModelDescriptor
): Readonly<Record<string, unknown>> {
  if (!carriesOffWire(base)) return base;
  if (planReasoningOff(reasoningPlanModelFrom(descriptor), 1).feasible) return base;
  return Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'reasoning'));
}

/** Whether these call parameters carry the hard-off wire — the one built shape. */
function carriesOffWire(parameters: Readonly<Record<string, unknown>>): boolean {
  const wire = ReasoningWire.safeParse(parameters['reasoning']);
  return wire.success && 'enabled' in wire.data;
}

/** What the answer call sends, and the rung its wire was minted at. */
interface DecidedCall {
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly level?: ResolvedReasoningEffort;
}

/**
 * The answer call's parameters for the BOUND candidate: its OWN affordable
 * cap (`cap(m)`, stamped per candidate at admission) becomes the completion
 * `maxOutputTokens`, and the decided effort is carved INTO that cap — the
 * shared positional pick maps the canonical level onto the model's offered
 * ladder and returns a plan whose `maxTokens` equals `cap(m)`, so the decided
 * choice can never spend past what admission reserved for THIS model. With no
 * decided effort, delegates to `paramsRespectingHardOff` (forwards or strips a
 * built hard-off wire); the cap stays untouched when the model offers no level
 * or carries no integer cap (a reasoning budget never rides a call without an
 * explicit `max_tokens`).
 */
function answerParamsWithEffort(
  node: SmartModelNode,
  descriptor: ModelDescriptor,
  effort: ClassifierEffortLevel | undefined,
  candidateMaxOutputTokens: number | undefined
): DecidedCall {
  const base =
    candidateMaxOutputTokens === undefined
      ? node.params
      : { ...node.params, maxOutputTokens: candidateMaxOutputTokens };
  if (effort === undefined) return builtLevel(paramsRespectingHardOff(base, descriptor));
  const cap = base['maxOutputTokens'];
  if (typeof cap !== 'number') return builtLevel(base);
  const plan = pickClassifiedEffortPlan(reasoningPlanModelFrom(descriptor), effort, cap);
  if (plan === undefined) return builtLevel(base);
  return {
    parameters: { ...base, reasoning: plan.wire, maxOutputTokens: plan.maxTokens },
    level: plan.level,
  };
}

/**
 * The level a BUILT (rather than classified) slot wire runs at. The build stamps
 * exactly one wire shape here — the shared hard-off wire — and `off` is the rung
 * it names, so a surviving off wire records `off` and a stripped one records
 * nothing, per candidate. Any other pinned wire records no level: which rung a
 * budget wire named is not recoverable from the wire, and an under-recorded
 * level costs a badge where a guessed one would name the wrong rung.
 */
function builtLevel(parameters: Readonly<Record<string, unknown>>): DecidedCall {
  return { parameters, ...(carriesOffWire(parameters) ? { level: REASONING_OFF } : {}) };
}

async function answerCall(
  deps: SmartModelExecutionDeps,
  args: AnswerCallArgs
): Promise<Result<NodeRunSuccess, NodeRunError>> {
  const { node, candidate, prompt, ctx, smartModelRan } = args;
  const modelId = candidate.id;
  const binding = deps.candidates.get(modelId);
  if (binding === undefined) {
    // The registry resolved every candidate binding when it resolved the node,
    // and resolution only ever picks from the node's own candidate list.
    throw new Error(`smartModel: no binding for resolved candidate '${modelId}'`);
  }
  const history = ctx.history;
  // Custom instructions shape the ANSWER only — they ride the run-scoped ctx
  // (never the definition), so the answer node picks them up with no
  // per-builder wiring.
  const customInstructions = ctx.customInstructions;
  // The bound candidate's OWN affordable cap at the decided rung (stamped per
  // candidate at admission): the reservation held exactly this at this model's
  // rate.
  const call = answerParamsWithEffort(
    node,
    binding.descriptor,
    args.effort,
    candidate.maxOutputTokens
  );
  const request: InferenceRequest = {
    model: modelId,
    inputs: [{ modality: 'text', text: prompt }],
    parameters: call.parameters,
    outputs: binding.descriptor.outputs,
    ...(history === undefined || history.length === 0 ? {} : { history: [...history] }),
    ...(customInstructions === undefined ? {} : { customInstructions }),
    utcDay: utcDayKeyAt(ctx.clock.now()),
  };
  const result = await streamModelCall({ ...deps, binding }, request, {
    ...ctx,
    ...(call.level === undefined ? {} : { resolvedEffort: call.level }),
  });
  if (smartModelRan !== true) return result;
  return result.map((success) => ({ ...success, smartModelRan: true }));
}
