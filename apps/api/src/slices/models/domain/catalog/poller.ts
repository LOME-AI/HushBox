import { alertMassExclusion, refreshCatalog } from './refresh.js';
import { runOrThrow } from '../../../../lib/jobs/index.js';
import type { RefreshCatalogDeps, RefreshJitter } from './refresh.js';
import type { CronEntry } from '../../../../lib/jobs/index.js';

/**
 * The hourly model-catalog poller. The refresh itself is the models slice's
 * published, skip-unchanged, upsert-converging query; the cron supplies live
 * infra plus, in production alone, a start jitter, and is the only reader of
 * the summary the refresh returns — without that read, a refresh that hides the
 * sellable catalog is silent until the next hour repairs it.
 */

/** Random start delay ceiling so a fleet of triggers spreads out. */
export const CATALOG_REFRESH_JITTER_MAX_MS = 60_000;

export function productionRefreshJitter(): RefreshJitter {
  return {
    maxMs: CATALOG_REFRESH_JITTER_MAX_MS,
    random: Math.random,
    sleep: (ms: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}

export function createCatalogRefreshEntry(deps: RefreshCatalogDeps): CronEntry {
  return {
    name: 'model-catalog-refresh',
    run: async (): Promise<void> => {
      alertMassExclusion(deps.telemetry, await runOrThrow(refreshCatalog(deps)));
    },
  };
}
