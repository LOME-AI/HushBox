/**
 * The API worker's liveness route, defined once for every caller that probes
 * it, whatever harness the caller belongs to. Two derivations of one URL could
 * disagree, and the disagreement would be silent — a watchdog probing an
 * endpoint the run does not use either never trips while the run dies or trips
 * while the run is healthy.
 *
 * `/health` (`apps/api/src/app.ts`) is a static 200 touching no dependency, so
 * a failure to answer it means the worker is not executing, which is a
 * different claim from a dependency being down.
 *
 * The port is a parameter rather than read here: callers resolve it under
 * deliberately different policies — a missing port is a fatal misconfiguration
 * to a caller that has to run against the worker, and nothing to watch to one
 * that only observes a run.
 */
export function apiHealthUrl(port: string): string {
  return `http://localhost:${port}/health`;
}
