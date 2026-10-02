import {
  askQuestion,
  denyFinding,
  patchWrite,
  reopenFinding,
  ruleFinding,
  unblockFinding,
  updateProgress,
  withdrawQuestion,
} from '@hushbox/docket';
import type { FINDING_ACTIONS, FindingAction } from '../finding-actions.ts';
import type { Transition } from '@hushbox/docket';
import type { z } from 'zod';

/** What each action takes, read from the schema the declaration already holds. */
type ActionInputs = {
  [TAction in FindingAction]: z.infer<(typeof FINDING_ACTIONS)[TAction]['schema']>;
};

type ActionTransitions = {
  readonly [TAction in FindingAction]: (input: ActionInputs[TAction], at: string) => Transition;
};

/** Drops absent keys so an optional field never lands as an explicit undefined. */
function present<TInput extends Record<string, unknown>>(
  input: TInput
): { [TKey in keyof TInput]?: Exclude<TInput[TKey], undefined> } {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as {
    [TKey in keyof TInput]?: Exclude<TInput[TKey], undefined>;
  };
}

/**
 * Carries a dedication decision on the transition that took it, so the mark and
 * the decision it came from land in one patch: two writes would leave the
 * finding decided and unmarked in between, and would fence separately.
 *
 * A write that names no mark is handed back untouched rather than patched with
 * what the finding already carries, because the fence covers exactly the fields
 * the patch names — widening it would refuse ordinary decisions over a mark
 * nobody was arguing about.
 */
function alsoMarking(transition: Transition, dedicated: boolean | undefined): Transition {
  if (dedicated === undefined) return transition;
  return (finding) => {
    const outcome = transition(finding);
    if (!outcome.ok) return outcome;
    const { writer, patch } = outcome.value;
    return { ok: true, value: { writer, patch: { ...patch, dedicated } } };
  };
}

/**
 * One entry per declared action, so an action added to the declaration gains a
 * transition or nothing compiles. The entries carry no transport: each surface
 * parses its own input against the one schema the declaration holds and hands
 * the value in, so a console click and a command apply the same write rather
 * than two readings of it.
 */
export const ACTION_TRANSITIONS = {
  rule: (input, at) =>
    alsoMarking(
      ruleFinding({ option: input.option, text: input.text ?? null, note: input.note ?? null }, at),
      input.dedicated
    ),
  // The mark is the human writer's here in either direction, so the entry names
  // the writer rather than taking one: an agent marking its own work writes as
  // the agent through the CLI's `--set dedicated=`, which is a different write.
  dedicate: (input, _at) => patchWrite('human', { dedicated: input.dedicated }),
  deny: (input, at) => denyFinding({ reason: input.reason ?? null }, at),
  reopen: (_input, at) => reopenFinding(at),
  ask: (input, at) => askQuestion({ text: input.text }, at, 'human'),
  withdraw: (input, _at) => withdrawQuestion({ index: input.index }),
  unblock: (input, at) => alsoMarking(unblockFinding({ note: input.note }, at), input.dedicated),
  // A status this entry writes is the reader's act whichever field it lands on,
  // so the writer is named rather than taken: attributing it to the agent would
  // record the human moving work the agent stopped as the agent's own report,
  // and would move the agent's last-reported stamp with it.
  progress: (input, at) =>
    updateProgress(
      present({ status: input.status, note: input.note, verified: input.verified }),
      at,
      'human'
    ),
} satisfies ActionTransitions;

/**
 * Applies the entry an action names, for a caller holding an action it knows
 * only at runtime. The table is read through its declared type rather than
 * through the value: indexing the mapped type keeps the entry and the input
 * correlated on the same key, while indexing the value leaves the compiler
 * comparing every entry against every input, which no argument satisfies.
 */
export function buildTransition<TAction extends FindingAction>(
  action: TAction,
  input: ActionInputs[TAction],
  at: string
): Transition {
  const table: ActionTransitions = ACTION_TRANSITIONS;
  return table[action](input, at);
}
