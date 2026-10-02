import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { CRON_SCHEDULES, fireCronSchedule } from '../helpers/cron.js';
import type { CronScheduleName } from '../helpers/cron.js';

const SPEC_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'either',
  reason:
    'The test fires the Worker’s scheduled endpoint over HTTP and asserts the handler settled; no page is navigated, so no rendering engine takes part.',
});

// The same cast `cronScheduleNameFor` makes over the same map: `Object.keys`
// widens to `string[]`, and iterating the map rather than a written-out list is
// what keeps this spec covering every deployed schedule as the map grows.
const SCHEDULE_NAMES = Object.keys(CRON_SCHEDULES) as CronScheduleName[];

/**
 * The scheduled surface's only coverage under the real Worker. Every entry's
 * logic is already tested against live local infrastructure; what only this
 * layer sees is composition — the dependencies the handler builds from the
 * Worker's own bindings before any entry is isolated.
 *
 * That is the whole assertion, and it is deliberately no wider: the runner
 * converts an entry's failure into telemetry whose sinks are console and
 * Sentry, so no entry outcome is observable from here. What is observable is a
 * handler that never reached the runner, because `createScheduledHandler` has
 * no catch and the scheduled endpoint answers 500 when the handler rejects.
 */
test.describe('Worker scheduled handler', SPEC_MATRIX, () => {
  for (const schedule of SCHEDULE_NAMES) {
    test(`the ${schedule} schedule composes and completes`, async ({ request }) => {
      test.setTimeout(TIMEOUTS.XXLONG);

      await expect(
        fireCronSchedule(request, schedule, TIMEOUTS.CRON_FIRE)
      ).resolves.toBeUndefined();
    });
  }
});
