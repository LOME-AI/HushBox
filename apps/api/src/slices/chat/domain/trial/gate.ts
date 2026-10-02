import {
  TRIAL_MESSAGE_COST_CAP_NANO_USD,
  trialEligibility,
  trialMessageBillableNanoUsd,
} from '../../../models/index.js';
import { ok } from '../../../../lib/result/index.js';
import type { ModelDescriptor } from '@hushbox/shared';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Result } from '../../../../lib/result/index.js';

/**
 * What the trial send's model/affordability gate decided — three refusals and
 * an admission, none of them a failure. `media-blocked` and `premium-required`
 * adapt the models slice's eligibility verdict; `too-expensive` is this gate's
 * own composition.
 */
export type TrialGateVerdict = 'allowed' | 'media-blocked' | 'premium-required' | 'too-expensive';

/** The verdicts that refuse the send — every one of them owes the caller a status. */
export type TrialGateRefusal = Exclude<TrialGateVerdict, 'allowed'>;

/**
 * The trial send's MODEL/AFFORDABILITY gate: three pre-run refusals that keep
 * the free trial to cheap text models — a non-text (image/video) model, a
 * premium model (top price quartile, recent release, or an unaffordable minimal
 * exchange), and an actual message whose estimated cost exceeds the per-message
 * cap. `allowed` proceeds. An unknown model is absent from the exposed catalog
 * (`target === undefined`): the gate is a no-op and the compile step refuses it
 * as an unknown model.
 *
 * It lives in domain, not at the route, because it COMPOSES a domain rule: the
 * eligibility verdict is the models slice's, but the comparison of a priced
 * message against the cap is assembled out of two published values and
 * published by no slice. Composing a rule is what decides where a gate lives,
 * whatever status its outcome carries: this gate's cost refusal is a 402, which
 * the domain-error taxonomy has no member for, while the premium-tier gate
 * beside it refuses with a 403, which the taxonomy maps — and both are domain
 * for the same reason.
 *
 * The outcomes are VERDICTS rather than `DomainError`s because one funding
 * question has several non-error answers the caller must tell apart, each owing
 * its own wire code: nothing failed in producing "this model is not for trial"
 * or "this message costs too much", and folding them into the error channel
 * would flatten them into one refusal with a code and hand the caller something
 * to re-branch on in place of a map the compiler can see is total. The error
 * channel stays for what did fail — pricing the message.
 *
 * Pure, and told its reference clock: `nowMs` is the instant the premium
 * recency leg is judged against.
 */
export function trialGateVerdict(
  target: ModelDescriptor | undefined,
  exposedCatalog: readonly ModelDescriptor[],
  promptCharacterCount: number,
  nowMs: number
): Result<TrialGateVerdict, DomainError> {
  if (target === undefined) return ok('allowed');
  const eligibility = trialEligibility(target, exposedCatalog, nowMs);
  if (!eligibility.eligible) {
    return ok(eligibility.reason === 'non-text' ? 'media-blocked' : 'premium-required');
  }
  // Priced on the SAME character count the compiled turn is budgeted against —
  // system prompt and custom instructions included, not history-plus-prompt alone.
  // The gate has to dominate the definition's own floor, and the system prompt is
  // the term that made the two differ.
  return trialMessageBillableNanoUsd(target, promptCharacterCount).map((cost) =>
    cost > TRIAL_MESSAGE_COST_CAP_NANO_USD ? 'too-expensive' : 'allowed'
  );
}
