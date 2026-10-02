import { CRON_SCHEDULES, scheduledTriggerUrl } from '../../scripts/cron-trigger.js';
import { requireEnv } from './env.js';
import { expectOkResponse } from './ok-response.js';
import type { CronScheduleName } from '../../scripts/cron-trigger.js';
import type { APIRequestContext } from '@playwright/test';

// Re-exported so a spec names a schedule through this helper alone, never by
// reaching into the scripts tree for the map or writing a cron string of its own.
export { CRON_SCHEDULES } from '../../scripts/cron-trigger.js';
export type { CronScheduleName } from '../../scripts/cron-trigger.js';

const API_BASE = requireEnv('VITE_API_URL');

/**
 * Fire one of the Worker's deployed schedules and wait for the whole handler,
 * `waitUntil` promises included, to finish. That wait is the point: it is what
 * lets a spec assert on a cron's effect directly instead of polling for it.
 *
 * The dev-server ticker that fires these on their real cadence is off under
 * E2E, so a spec's fire is the only one that happens and its effects are the
 * spec's own.
 *
 * The fire rides the transient-failure retry every fixture context carries
 * (`withRequestRetry` in `e2e/helpers/resilient-request.ts`), and a GET is
 * replay-safe, so a fire answered by a 5xx envelope can be re-issued. Nothing
 * ever overlaps: that retry consults its budget only once a response has
 * returned and never aborts a request in flight, so a second fire can only
 * follow a handler that has already failed. Sequential is what makes it safe —
 * a cron entry is idempotent per run, not per duplicate concurrent invocation.
 *
 * A non-2xx means the handler threw before any entry could be isolated — a
 * binding missing from the Worker's composition, which is the fault class this
 * surface exists to catch — so it fails the spec rather than being returned.
 */
export async function fireCronSchedule(
  request: APIRequestContext,
  schedule: CronScheduleName,
  timeout: number
): Promise<void> {
  const cron = CRON_SCHEDULES[schedule];
  const response = await request.get(scheduledTriggerUrl(API_BASE, cron), { timeout });
  await expectOkResponse(response, `fireCronSchedule(${schedule})`);
}
