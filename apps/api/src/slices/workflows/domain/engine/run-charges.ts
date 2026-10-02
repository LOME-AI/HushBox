import type { NodeBillingMetadata, NodeRunSuccess } from './execution-registry.js';
import type { SettlementCharge } from '@hushbox/shared';

/**
 * Lifts a modelCall's per-generation facts into a keyed settlement charge.
 * Only modelCall executions carry `billing`; transform/control successes
 * produce no billable generation, so this is a no-op for them.
 *
 * Its caller invokes it only for a generation whose value committed, which is
 * the invariant settlement's run-level anchor rests on: a charge reaching
 * settlement always names a generation the run accepted, so anchoring one that
 * persisted no content OF ITS OWN — a consumed value, such as the turn's
 * classifier — onto the run's content bills real, accepted work.
 */
export function collectCharge(
  charges: SettlementCharge[],
  key: string,
  success: NodeRunSuccess
): void {
  const billing = success.billing;
  if (billing !== undefined) {
    // Only the primary answer charge carries the smartModel chip signal; the
    // display chip reads "the routing pipeline ran", never "the classifier
    // billed", so an unrouted fallback answer still badges.
    pushCharge(charges, key, billing, {
      billableCostNanoUsd: success.costNanoUsd,
      isEstimated: success.isEstimated ?? false,
      smartModelRan: success.smartModelRan === true,
    });
  }
  // An auxiliary generation charges under the node key plus its suffix, so its
  // DB idempotency key never collides with the node's own. No node execution
  // produces one today — the turn's classifier is its own node with its own
  // top-level key — so this loop is the mechanism without a producer.
  for (const auxiliary of success.auxiliaryCharges ?? []) {
    pushCharge(charges, `${key}#${auxiliary.keySuffix}`, auxiliary.billing, {
      billableCostNanoUsd: auxiliary.billableCostNanoUsd,
      isEstimated: auxiliary.isEstimated,
    });
  }
}

function pushCharge(
  charges: SettlementCharge[],
  key: string,
  billing: NodeBillingMetadata,
  facts: {
    readonly billableCostNanoUsd: bigint;
    readonly isEstimated: boolean;
    readonly smartModelRan?: boolean;
  }
): void {
  charges.push({
    key,
    modelId: billing.modelId,
    providerName: billing.providerName,
    modality: billing.modality,
    ...(billing.generationId === undefined ? {} : { generationId: billing.generationId }),
    billableCostNanoUsd: facts.billableCostNanoUsd,
    isEstimated: facts.isEstimated,
    ...(billing.tokens === undefined ? {} : { tokens: billing.tokens }),
    ...(billing.media === undefined ? {} : { media: billing.media }),
    ...(billing.reasoningEffort === undefined ? {} : { reasoningEffort: billing.reasoningEffort }),
    ...(billing.reasoningDurationMs === undefined
      ? {}
      : { reasoningDurationMs: billing.reasoningDurationMs }),
    ...(facts.smartModelRan === true ? { smartModelRan: true } : {}),
  });
}
