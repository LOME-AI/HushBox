/**
 * The per-rung sizing every chat build shares: how a built turn's answers are
 * fitted against the one estimator, and which rung a menu that marks exactly one
 * available settles. The fit itself is handed in, so this module reads no
 * definition-building code and every build can import it.
 */
import { CanonicalReasoningEffort, REASONING_OFF } from '@hushbox/shared';
import { toolCallCapFor, toolLoopStepsFor } from '@hushbox/shared/affordability';
import type { DimensionOption, ResolvedReasoningEffort, WorkflowDefinition } from '@hushbox/shared';

/** The rungs a turn's searching answers carry their own ceiling for, and the loop it declares. */
export interface RungPlan {
  /** The rung whose loop, cap and steps the definition itself declares. */
  readonly loop: ResolvedReasoningEffort;
  readonly rungs: readonly ResolvedReasoningEffort[];
}

/** A turn's definition as one rung runs it. */
export type RungShape = (
  definition: WorkflowDefinition,
  rung: ResolvedReasoningEffort
) => WorkflowDefinition;

/**
 * A built turn with its answers fitted, and whether every fit landed within the
 * funding it searched against rather than at the answer floor above it.
 */
export interface FittedTurn {
  readonly definition: WorkflowDefinition;
  readonly withinFunds: boolean;
}

/** The one answer-cap fit of a built turn, and the payer's funding it fits against. */
export interface AnswerFit {
  readonly fit: (shaped: WorkflowDefinition, spendableNanoUsd: bigint) => FittedTurn;
  readonly spendableNanoUsd: bigint;
}

/**
 * A built turn's answers, sized by the rule all three chat builds follow: a turn
 * whose searching answers carry a ceiling per rung is fitted once per rung at its
 * whole funding, and is within funds only if every one of those fits is; any
 * other turn is fitted once, at its funding less the reserve its menu set aside
 * when one available rung settled the effort axis. A turn with no budget or no
 * bound to fit against is left as it was built.
 */
export function sizedTurnAnswers(
  stamped: WorkflowDefinition,
  answerFit: AnswerFit | undefined,
  sizing: {
    readonly shapeAt: RungShape;
    readonly perRung?: RungPlan | undefined;
    readonly setAsideNanoUsd?: bigint | undefined;
  }
): FittedTurn {
  if (answerFit === undefined) return { definition: stamped, withinFunds: true };
  const { fit, spendableNanoUsd } = answerFit;
  if (sizing.perRung !== undefined) {
    let withinFunds = true;
    const definition = withRungCeilings(stamped, sizing.shapeAt, sizing.perRung, (shaped) => {
      const fitted = fit(shaped, spendableNanoUsd);
      withinFunds &&= fitted.withinFunds;
      return fitted.definition;
    });
    return { definition, withinFunds };
  }
  return fit(stamped, spendableNanoUsd - (sizing.setAsideNanoUsd ?? 0n));
}

/**
 * The rung a menu settles when it marks exactly one available, and nothing when
 * it marks none or two or more: the single choice `docs/BILLING.md` §Reasoning
 * Effort 5 settles without a call. It reads the menu through
 * {@link effortRungsOf}, so it refuses what that refuses.
 */
export function settledRungOf(
  options: readonly DimensionOption[]
): ResolvedReasoningEffort | undefined {
  const [only, ...more] = effortRungsOf(options);
  return more.length > 0 ? undefined : only;
}

/**
 * Menu options as rungs of the effort domain, in the menu's own order: the one
 * parse every build reads its rungs through. The off rung is matched by its id. A
 * menu lists effort-domain ids only, so any other id is a defect and throws
 * rather than being read as some rung or dropped.
 */
export function effortRungsOf(
  options: readonly DimensionOption[]
): readonly ResolvedReasoningEffort[] {
  return options.map((option) => {
    if (option.optionId === REASONING_OFF) return REASONING_OFF;
    const parsed = CanonicalReasoningEffort.safeParse(option.optionId);
    if (!parsed.success) {
      throw new RangeError(`the effort menu names '${option.optionId}', outside the effort domain`);
    }
    return parsed.data;
  });
}

/**
 * Stamps each searching answer of an `auto` turn with the ceiling its own budget
 * solve buys at every rung the classifier may decide. `fit` is the one answer-cap
 * fit, run once per rung on the definition `shapeAt` shapes for that rung; the
 * definition returned is the fit at the loop the plan declares, so its cap and
 * steps are that rung's, and the per-rung field is what the estimator prices one
 * decision against.
 */
export function withRungCeilings(
  stamped: WorkflowDefinition,
  shapeAt: RungShape,
  plan: RungPlan,
  fit: (shaped: WorkflowDefinition) => WorkflowDefinition
): WorkflowDefinition {
  const fitAt = (rung: ResolvedReasoningEffort): WorkflowDefinition => fit(shapeAt(stamped, rung));
  const byRung = plan.rungs.map((rung) => [rung, fitAt(rung)] as const);
  const declared = fitAt(plan.loop);
  return {
    ...declared,
    nodes: declared.nodes.map((node) => {
      if (node.type !== 'modelCall' || node.tools.length === 0) return node;
      const rungCeilings = Object.fromEntries(
        byRung.flatMap(([rung, definition]) => {
          const cap = answerCapOf(definition, node.id);
          return cap === undefined ? [] : [[rung, cap]];
        })
      );
      return { ...node, rungCeilings };
    }),
  };
}

/** A definition whose searching answers declare the loop of one rung. */
export function atLoop(
  definition: WorkflowDefinition,
  rung: ResolvedReasoningEffort
): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) =>
      node.type === 'modelCall' && node.tools.length > 0
        ? { ...node, maxSteps: toolLoopStepsFor(toolCallCapFor(rung)) }
        : node
    ),
  };
}

/** The answer cap a node of a definition carries, if it carries one. */
function answerCapOf(definition: WorkflowDefinition, nodeId: string): number | undefined {
  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  const cap = node?.type === 'modelCall' ? node.params['maxOutputTokens'] : undefined;
  return typeof cap === 'number' ? cap : undefined;
}
