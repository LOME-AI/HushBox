import { fileURLToPath } from 'node:url';
import { request } from '@playwright/test';
import { claim } from '../../scripts/lib/claims/claim.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { requireEnv } from './env.js';
import { idempotentDelete } from './idempotent-request.js';
import { expectOkResponse } from './ok-response.js';
import { withRequestRetry } from './resilient-request.js';
import type { OnHeld } from '../../scripts/lib/claims/claim.js';
import type { CheckedResponse } from './ok-response.js';

/** The single global row this lock guards. Named in a refusal and in a wait. */
const RESOURCE = 'banner_config';

/**
 * The longest guarded window this design sanctions, sized on the wider of the
 * two holders — the admin lifecycle spec, whose four OpModal round trips, three
 * prefill reopens and audit-trail journey all run inside the lock.
 */
const MAX_HOLD_MS = TIMEOUTS.XXLONG;

/**
 * The per-test budget both banner specs configure on their describe: one whole
 * sanctioned hold spent queued behind the other project, one hold of their own,
 * and the teardown that follows. Exported as one value rather than summed at
 * each call site so neither spec can invent a budget of its own.
 *
 * A Playwright budget for a test, not an input to any decision this module
 * makes: nothing here reads a clock to work out whether the other project is
 * still holding the row.
 */
export const BANNER_LOCK_TEST_TIMEOUT_MS = MAX_HOLD_MS * 2 + TIMEOUTS.LONG;

/**
 * `.cache/` is git-ignored repo-wide, so the lock file never reaches a commit.
 * It outlives every hold: the primitive deliberately never unlinks a lock file,
 * because unlinking one lets a waiter hold a deleted inode while the next
 * acquirer locks a fresh one. Its presence says nothing about whether anyone
 * holds the row.
 */
const DEFAULT_LOCK_PATH = fileURLToPath(new URL('../.cache/banner-config.lock', import.meta.url));

/** Restores the banner to disabled, and throws unless the restore was confirmed. */
export type BannerReset = () => Promise<void>;

/** Throws unless the dev route answered the banner reset with 200. */
export async function expectBannerReset(response: CheckedResponse): Promise<void> {
  await expectOkResponse(response, 'banner reset', 200);
}

/**
 * `DELETE /dev/banner` on the E2E API: a dev-only route, so it needs no admin
 * token and draws on no admin-ops rate limit, which is what lets the restore
 * run on every release without ever being refused.
 */
async function resetBannerThroughDevRoute(): Promise<void> {
  const api = withRequestRetry(await request.newContext({ baseURL: requireEnv('VITE_API_URL') }));
  try {
    const response = await idempotentDelete(api, '/dev/banner');
    await expectBannerReset(response);
  } finally {
    await api.dispose();
  }
}

/** Settles `run` into its outcome, so a failure is held rather than raised. */
async function settle<T>(run: () => T | PromiseLike<T>): Promise<PromiseSettledResult<T>> {
  const [outcome] = await Promise.allSettled([(async () => run())()]);
  return outcome;
}

interface BannerLockOptions {
  /** Overridden by the helper's own tests so they never touch the real lock. */
  readonly lockPath?: string;
  /**
   * Defaults to queuing, which is what the two banner specs want from each
   * other. The helper's own tests pass `refuse` where they have to observe
   * contention rather than wait it out.
   */
  readonly onHeld?: OnHeld;
  /** Overridden by the helper's own tests so they never reach the API. */
  readonly resetBanner?: BannerReset;
}

/**
 * Run `body` holding an exclusive advisory lock on the global banner row.
 *
 * `banner_config` is one global row with no per-test isolation seam, and the
 * two specs that enable it run in different Playwright projects — separate
 * worker processes on one host — so no in-file mechanism can exclude them from
 * each other. The claim primitive can: the same OS advisory lock the rest of the
 * repo's cross-process exclusion is built on. In CI each project is its own job
 * with its own stack, so the lock is uncontended and inert.
 *
 * Liveness comes from the kernel and from nothing else. This helper used to keep
 * a heartbeat interval and break any lock whose file had not been restamped for
 * a window, which gets both directions wrong: a frozen holder writes nothing and
 * was declared dead while it still held the row, and a killed holder's file
 * still looked fresh, so a waiter sat out the whole window before taking a row
 * nobody owned. An advisory lock answers both immediately — a stopped process
 * still holds its lock, and a dead one holds nothing.
 *
 * Queuing has no timeout for the same reason: a live holder finishes and a dead
 * one has already released, so a wait can only end one of two ways. The spec's
 * own budget is what bounds it.
 *
 * The release path is the banner's one restore: once `body` settles, resolved
 * or thrown, the banner is reset to disabled while the row is still held, so no
 * holder can hand the next one an enabled banner. A reset that fails fails the
 * holder; when `body` failed too, both failures are raised together.
 */
export async function withBannerLock<T>(
  body: () => T | PromiseLike<T>,
  options: BannerLockOptions = {}
): Promise<T> {
  const resetBanner = options.resetBanner ?? resetBannerThroughDevRoute;
  return claim(
    { name: RESOURCE, lockPath: options.lockPath ?? DEFAULT_LOCK_PATH },
    { onHeld: options.onHeld ?? 'wait', holder: `e2e banner spec (pid ${String(process.pid)})` },
    async () => {
      const bodyOutcome = await settle(body);
      const resetOutcome = await settle(resetBanner);

      const failures: unknown[] = [];
      if (bodyOutcome.status === 'rejected') failures.push(bodyOutcome.reason);
      if (resetOutcome.status === 'rejected') failures.push(resetOutcome.reason);

      if (bodyOutcome.status === 'fulfilled' && failures.length === 0) return bodyOutcome.value;
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, 'banner lock holder and its banner reset both failed');
    }
  );
}
