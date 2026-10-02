import type { AnyAdminOpContract } from './contract.ts';
import type { AdminOpWire } from './wire.ts';

/**
 * The one projection of an op contract into its `GET /admin/ops` catalog
 * entry — used by the admin routes that serve the catalog and by the SPA
 * test fixtures that stand for it. Two projections of this shape must agree
 * to be correct, so there is exactly one (CODE-RULES §One Implementation,
 * Shared).
 *
 * `guardrails` is present whenever the contract declares the object, even
 * with no money cap inside it: the entry states what the contract states,
 * and a guardrail kind the wire does not yet carry must not read to the SPA
 * as an op with no guardrails at all. The stated `system-owned` reason rides
 * along for the same reason — the operator reads the case for a no-inverse
 * effect at the moment of running it, and the contract constructor is what
 * confines that field to the one class, so this copies rather than re-decides
 * who may carry one.
 */
export function adminOpCatalogEntry(contract: AnyAdminOpContract): AdminOpWire {
  const { description, systemOwnedReason, guardrails } = contract;
  const cap = guardrails?.maxAmountNanoUsd;
  return {
    name: contract.name,
    title: contract.title,
    kind: contract.kind,
    ...(description === undefined ? {} : { description }),
    effectClass: contract.effectClass,
    inverse: contract.inverse,
    fields: Object.keys(contract.input.shape),
    ...(systemOwnedReason === undefined ? {} : { systemOwnedReason }),
    ...(guardrails === undefined
      ? {}
      : { guardrails: cap === undefined ? {} : { maxAmountNanoUsd: cap.toString(10) } }),
  };
}
