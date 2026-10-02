import { currentRunId } from './ownership.js';
import { enumerateRegistry } from './registry.js';

/**
 * The containers THIS run's own claim records.
 *
 * The question anything asks when it means "what did I start" rather than "what
 * is running on this machine". Every checkout and every concurrent run shares
 * one Docker daemon, so a name prefix selects every run's containers alike, and
 * a check written over that set reports a sibling run's container as a leak of
 * its own — the failure this answers instead of tolerating.
 *
 * Ownership is the claim, as it is for every other resource kind: a container
 * is this run's when this run's record names it, which the container itself
 * carries nowhere. No name shape, no age and no creation order enters it.
 *
 * A process holding no run claim is refused rather than answered. Its answer
 * would be "none" whatever exists, which reads as a clean sheet, and a check
 * resting on it passes while proving nothing.
 */
export async function containersThisRunRecorded(registryDir?: string): Promise<string[]> {
  const runId = currentRunId();
  if (runId === null) {
    throw new Error(
      'containersThisRunRecorded: this process holds no run claim, so nothing here can tell the ' +
        "containers it started from another run's. Register a run before asking."
    );
  }
  const reading = await enumerateRegistry(registryDir);
  return reading.claims
    .filter((found) => found.claim.runId === runId)
    .flatMap((found) => found.claim.resources)
    .filter((resource) => resource.kind === 'container')
    .map((resource) => resource.id);
}
