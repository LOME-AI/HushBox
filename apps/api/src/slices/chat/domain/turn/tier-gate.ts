import { pinnedSourceIds, resolveFunding } from '@hushbox/shared';
import { findTierLockedModel } from '../../../models/index.js';
import type { TurnModality } from './pricing.js';
import type { FundingDecisionInputs } from './context.js';
import type { ModelDescriptor, TurnSourceList } from '@hushbox/shared';

/** The client-selection fields the premium-tier gate inspects. */
export interface TierGateBody {
  readonly turnSources: TurnSourceList;
  readonly modality?: TurnModality | undefined;
}

/**
 * What the premium-tier gate decided about a selection — an entitlement verdict,
 * not an error. The gate reads nothing and cannot fail: it composes the shared
 * funding core against a snapshot handed to it, so `allowed` and `tier-locked`
 * are two ordinary answers to one funding question, and the caller distinguishes
 * them alongside the other answers the same resolution can give.
 */
export type TierGateVerdict = 'allowed' | 'tier-locked';

/** The verdicts that refuse the turn — every one of them owes the caller a status. */
export type TierGateRefusal = Exclude<TierGateVerdict, 'allowed'>;

/**
 * The models the paid premium-tier gate judges for a turn: the models the
 * client PINNED by name. A media (image/video) turn is out of the gate's scope,
 * and the Smart slot names no model — it derives its candidates from the
 * affordable set already — so it contributes nothing to the judged set rather
 * than exempting the whole turn. Reading the PINNED sources, not the body, is
 * what keeps a pinned premium model gated when the selection ALSO carries the
 * Smart slot. Null (no tier check) only when nothing pinned survives.
 */
function gatedTierModels(body: TierGateBody): readonly string[] | null {
  if (body.modality === 'image' || body.modality === 'video') return null;
  const pinned = pinnedSourceIds(body.turnSources);
  return pinned.length === 0 ? null : pinned;
}

/**
 * The paid premium-tier gate — the MODEL_TIER_LOCKED refusal (legacy
 * `enforceTierLock`). It gates only the DIRECT-BILLING path: a caller paying
 * from their own wallet (a solo turn, or a group turn that fell through to
 * self-funding). "Can access premium" is the caller's own purchased-wallet
 * balance being positive (founder ruling); an owner-funded group turn — where
 * the payer wallet belongs to the owner, not the caller — is exempt, as are all
 * media / Smart-Model sends. A selected premium model (the same fresh premium
 * legs the trial gate uses) is `tier-locked`.
 *
 * Pure, and told its snapshot rather than reading one. The seam above it already
 * holds the snapshot that priced the payer freeze, and a second read of its own
 * could return a different one — pricing the freeze on one catalog while
 * classifying premium on another. One read, one snapshot, one funding answer.
 */
export function tierGateVerdict(
  exposedCatalog: readonly ModelDescriptor[],
  body: TierGateBody,
  fundingInputs: FundingDecisionInputs,
  nowMs: number
): TierGateVerdict {
  const models = gatedTierModels(body);
  if (models === null) return 'allowed';
  // The baseline (model-agnostic) run of the shared core says who pays and
  // whether the caller can access premium. An owner-funded turn (payer 'owner')
  // is exempt, and a caller who can access premium is unlocked.
  const baseline = resolveFunding({ ...fundingInputs, isPremiumModel: false });
  if (baseline.payer !== 'self' || baseline.premiumAllowed) return 'allowed';
  const anyPremium = findTierLockedModel(models, exposedCatalog, false, nowMs) !== undefined;
  // The refusal itself comes from the SAME core, now told the selection's tier.
  const decision = resolveFunding({ ...fundingInputs, isPremiumModel: anyPremium });
  return decision.payer === 'refuse' && decision.refusalCode === 'MODEL_TIER_LOCKED'
    ? 'tier-locked'
    : 'allowed';
}
