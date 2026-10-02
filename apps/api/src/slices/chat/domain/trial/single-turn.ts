import { snapshotResolver } from '../../../models/index.js';
import { TRIAL_TURN_HOOKS } from '../constants.js';
import { compileFittedSingleTurn } from '../turn/definition.js';
import type {
  ModelDescriptor,
  ReasoningEffortSelection,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Result } from '../../../../lib/result/index.js';
import type { TurnBudget } from '../turn/definition.js';

export type TrialSingleTurnBuild =
  | { readonly kind: 'built'; readonly definition: WorkflowDefinition }
  | { readonly kind: 'over-ceiling' };

/**
 * The trial single-model turn, compiled over the catalog snapshot the trial gate
 * already read, or `over-ceiling` when its answer fit cannot land within the
 * budget's per-message ceiling. The fit's verdict is the trial's per-message
 * money gate: trial admission reads only the daily spend counter, so a turn
 * built here over the ceiling would run and the house would absorb the excess.
 */
export function compileTrialSingleTurn(
  catalog: readonly ModelDescriptor[],
  model: string,
  turn: { readonly budget: TurnBudget; readonly reasoningEffort?: ReasoningEffortSelection }
): Result<TrialSingleTurnBuild, DomainError> {
  return compileFittedSingleTurn(snapshotResolver(catalog), model, {
    ...turn,
    hooks: TRIAL_TURN_HOOKS,
  }).map(
    (fitted): TrialSingleTurnBuild =>
      fitted.withinFunds
        ? { kind: 'built', definition: fitted.definition }
        : { kind: 'over-ceiling' }
  );
}
