import type { Ownership, OwnershipState } from '../claims/ownership.js';

/**
 * The state of a resource whose name carries the run that created it, for the
 * families whose reclaimer has both a claim record and a name to read.
 *
 * Two things can attribute such a resource and each answers a different half of
 * the run's life. While the run's record is on disk it names the prefix the run
 * creates under, which is the answer that also covers a name minted before
 * names carried a run id. A run that ends the way it meant to removes that
 * record, and what is left of an orphan its workers made is the run id in the
 * orphan's own name — read from a lock file the registry never unlinks.
 *
 * The order is what makes both true at once. Reading the run first would answer
 * *unowned* for a live run whose resources are named in the older spelling, and
 * *unowned* is the state a pass reports rather than reclaims; reading only the
 * record leaves every cleanly-exited run's orphan unattributable forever, which
 * is the defect this exists to close.
 */
export function stateOfRunNamedResource(
  ownership: Ownership,
  kind: Parameters<Ownership['stateOfResource']>[0],
  claimId: string,
  /** Omitted where the name carries none, which is what a foreign one has. */
  runId?: string
): OwnershipState {
  const recorded = ownership.stateOfResource(kind, claimId);
  return recorded === 'unowned' ? ownership.stateOfRun(runId) : recorded;
}
