import { z } from 'zod';
import {
  CANONICAL_REASONING_EFFORTS,
  REASONING_OFF,
  ResolvedReasoningEffort,
  assistantAnswerText,
} from '@hushbox/shared';
import { cheapestClassifierEffort, resolveClassifierAnswer } from '@hushbox/shared/affordability';

/**
 * The turn's decision envelope: the value a classifier generation's answer
 * becomes on its way to the nodes that act on it.
 *
 * A classifier is an ordinary `modelCall`, so its answer leaves it as text on an
 * ordinary edge. `decideTurn` is the registered reducer that joins that text to
 * the turn's prompt and produces this envelope, and every consumer reads it
 * through its own single input port (`docs/BILLING.md` §How the decision reaches
 * the answer). Keeping the decision on an edge is what makes the definition that
 * is priced the definition that executes: nothing recompiles after the
 * classifier answers.
 */

/** The registered `json<…>` schema name a decision-consuming input port carries. */
export const TURN_DECISION_SCHEMA_NAME = 'turnDecision';

export const TurnDecision = z.object({
  /**
   * The turn's prompt. It rides the envelope because a consumer declares one
   * input port: a node reading the decision would otherwise have no channel
   * left for the text it must send.
   */
  prompt: z.string(),
  /**
   * The candidate the turn's Smart Model slot binds: the one the answer named,
   * else the declared fallback. Absent on a turn that listed no candidate, one
   * with no slot, whose nodes read the effort alone.
   */
  modelId: z.string().min(1).optional(),
  /**
   * The canonical effort the turn runs at, already resolved onto the closed
   * ladder and clamped to a rung the bound candidate answers at. `auto` is a
   * SELECTION, not a choice: by the time a decision exists auto has been
   * resolved, so the domain here is the two authorities that make up a real
   * choice and never the wider selection enum.
   */
  effort: z.enum([...CANONICAL_REASONING_EFFORTS, REASONING_OFF]),
});

export type TurnDecision = z.infer<typeof TurnDecision>;

/**
 * The decision a node was handed, or `undefined` when it was handed raw text.
 * Consumers read the envelope through their ordinary single input port, so this
 * is the one place the two input shapes are told apart.
 */
export function decisionOf(input: unknown): TurnDecision | undefined {
  const parsed = TurnDecision.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

/**
 * What a node actually sends: the envelope's prompt when it was handed a
 * decision, the value itself otherwise. One place tells the two input shapes
 * apart, so no consumer has to carry the branch.
 */
export function callInputOf(input: unknown): unknown {
  return decisionOf(input)?.prompt ?? input;
}

/**
 * What a turn's decision is resolved within: the effort options its prompt
 * presented, and the candidates its Smart Model slot may bind, in the slot's own
 * order, each with the presented rungs it answers at. A turn with no slot lists
 * no candidate. The reducer is handed its inputs and never the node it runs on,
 * so the domain arrives as an input, and its encoder and decoder live together
 * here.
 */
export interface DecisionDomain {
  readonly presentedEfforts: readonly ResolvedReasoningEffort[];
  readonly candidates: readonly {
    readonly id: string;
    readonly answerableRungs: readonly ResolvedReasoningEffort[];
  }[];
}

const DecisionDomainSchema: z.ZodType<DecisionDomain> = z.object({
  presentedEfforts: z.array(ResolvedReasoningEffort),
  candidates: z.array(
    z.object({ id: z.string().min(1), answerableRungs: z.array(ResolvedReasoningEffort) })
  ),
});

/** The decision domain as the reducer's third input carries it. */
export function decisionDomainInput(domain: DecisionDomain): string {
  return JSON.stringify(domain);
}

const EMPTY_DOMAIN: DecisionDomain = { presentedEfforts: [], candidates: [] };

/**
 * The domain a turn handed its reducer; empty when it handed none. The encoding
 * is this module's own, so an input it cannot read is a defect and throws.
 */
function decisionDomainOf(encoded: string | undefined): DecisionDomain {
  if (encoded === undefined) return EMPTY_DOMAIN;
  return DecisionDomainSchema.parse(JSON.parse(encoded));
}

/**
 * Parse one classifier answer into the turn's decision. Pure: the same answer
 * always yields the same envelope, and an absent answer is an ordinary input
 * rather than a caught failure.
 *
 * The split, the per-dimension matchers, the clamp and the declared fallbacks all
 * live behind the money wall, so the reducer states only what it holds: the
 * answer and the domain the turn resolves it within. Resolving the model here,
 * rather than in the slot, is what lets every node of the turn read one rung
 * the bound candidate can run.
 *
 * A turn that presented no effort option never asked about the axis, so there is
 * no rung to resolve and none to invent; the envelope's schema still needs a
 * value, and the axis's own cheapest is the one that is never read.
 */
export function decideTurn(
  prompt: string,
  classifierAnswer?: string,
  decisionDomain?: string
): TurnDecision {
  const domain = decisionDomainOf(decisionDomain);
  // A reasoning-capable classifier's value carries its thinking in the same
  // text; only the root answer text is routing output. No classifier at all answers
  // nothing, which is an ordinary empty answer to the same resolver rather than
  // a second arm applying the fallbacks a second time.
  const answer = classifierAnswer === undefined ? '' : assistantAnswerText(classifierAnswer);
  const resolution = resolveClassifierAnswer(answer, domain.presentedEfforts, domain.candidates);
  return {
    prompt,
    ...(resolution.modelId === undefined ? {} : { modelId: resolution.modelId }),
    effort: resolution.effort ?? cheapestClassifierEffort(),
  };
}
