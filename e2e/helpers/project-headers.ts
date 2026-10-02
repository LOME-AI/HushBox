import { test } from '@playwright/test';
import { projectCallerIp } from '../../scripts/lib/playwright/identities.js';

/**
 * The caller identity the running worker presents. Both axes are load-bearing:
 * without the project axis every project spends one set of per-IP windows, and
 * without the worker axis every concurrently-running worker of a project piles
 * onto one window between resets — which turned the ten-per-hour registration
 * cap into a suite-wide budget that any worker's reset freed for the rest to
 * drain. `playwright.config.ts` can name only slot 0, because a worker index
 * exists no earlier than a test.
 *
 * Must be called inside a test or a test-scoped fixture — reads `test.info()`
 * lazily, the same way persona resolution does, so a module-scope constant is
 * not an option.
 */
export function callerHeaders(): Record<string, string> {
  const info = test.info();
  return { 'cf-connecting-ip': projectCallerIp(info.project.name, info.parallelIndex) };
}

/**
 * A hand-built context's own headers, merged OVER the running project's bag and
 * over this worker's caller identity.
 *
 * Playwright copies a project's `extraHTTPHeaders` into `newContext` options
 * only when the key is absent (playwright/lib/index.js, its
 * `runBeforeCreate*Context` hooks), so a context that passes any header bag of
 * its own replaces the project's whole bag and silently drops the
 * `cf-connecting-ip` identity — the context then falls back to whatever address
 * the local runtime injects, which is one shared address for every project.
 * Every context that sets a header of its own goes through here.
 *
 * Must be called inside a test or a test-scoped fixture, for `callerHeaders`'
 * reason.
 */
export function withProjectHeaders(headers: Record<string, string>): Record<string, string> {
  return { ...test.info().project.use.extraHTTPHeaders, ...callerHeaders(), ...headers };
}
