import { jobOutcome } from '../../../../lib/jobs/index.js';
import { readExposedCatalog } from './list-descriptors.js';
import { alertMassExclusion, refreshCatalog } from './refresh.js';
import { CATALOG_REFRESH_JOB_DECLARATION } from './refresh-job-declaration.js';
import type { JobOutcome } from '../../../../lib/jobs/index.js';
import type { CatalogRefreshJobRegistration } from './refresh-job-declaration.js';
import type { RefreshCatalogDeps } from './refresh.js';

interface CatalogRefreshJobDeps {
  /** Resolved inside the handler, so a config fault is an isolated row failure. */
  readonly resolveRefresh: () => RefreshCatalogDeps;
}

/**
 * The failure a run reports when its refresh completed yet the catalog exposes
 * no row at the running descriptor version — an empty gateway listing, say.
 */
const EXPOSED_NOTHING = 'catalog-refresh-exposed-nothing';

/**
 * The `catalog.refresh.v1` registration the dispatcher runs: one run of the
 * hourly catalog refresh, for a catalog read that found no row at the
 * descriptor version the running code bakes. The refresh compares stored
 * content with the version included, so every row it still admits is rewritten
 * at the running version.
 *
 * The job's purpose is a readable catalog, so a refresh that leaves none fails
 * the run rather than succeeding over the outage: the row then retries on the
 * dispatcher's backoff, pending, which keeps refused reads from enqueuing
 * another, and dead-letters at its failure cap, which pages. A check read that
 * itself fails reports the same failure, because the run has not shown the
 * catalog readable either way.
 */
export function createCatalogRefreshJobRegistration(
  deps: CatalogRefreshJobDeps
): CatalogRefreshJobRegistration {
  return {
    ...CATALOG_REFRESH_JOB_DECLARATION,
    handler: async (): Promise<JobOutcome> => {
      const refreshDeps = deps.resolveRefresh();
      const refreshed = await refreshCatalog(refreshDeps);
      if (refreshed.isErr()) return jobOutcome.fail(refreshed.error.code);
      const summary = refreshed.value;
      alertMassExclusion(refreshDeps.telemetry, summary);
      const exposed = await readExposedCatalog(
        { db: refreshDeps.db, telemetry: refreshDeps.telemetry },
        refreshDeps.now().getTime()
      );
      if (exposed.isErr() || exposed.value.descriptors.length === 0) {
        return jobOutcome.fail(EXPOSED_NOTHING);
      }
      return jobOutcome.ok({
        written: summary.written,
        unchanged: summary.unchanged,
        excluded: summary.excluded,
      });
    },
  };
}
