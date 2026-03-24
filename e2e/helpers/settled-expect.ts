/**
 * Settled-aware `expect` wrapper for Playwright.
 *
 * Automatically races locator/page assertions against the app's settled signal.
 * When the app settles (all TanStack Query fetches, mutations, and SSE streams
 * complete with 300ms debounce) and an assertion hasn't passed, it fails
 * immediately instead of waiting for the full timeout.
 *
 * Opt out for assertions that wait for external events (webhooks, WebSocket):
 *   import { unsettledExpect } from './settled-expect.js';
 *   await unsettledExpect(locator).toBeVisible({ timeout: 30_000 });
 */

import { expect as baseExpect, type Page } from '@playwright/test';

const FLOOR_MS = 500;
const GRACE_MS = 1000;
const POLL_MS = 200;
const DEFAULT_TIMEOUT = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkSettled(page: Page): Promise<boolean> {
  try {
    const value = await page
      .locator('[data-testid="settled-indicator"]')
      .getAttribute('data-settled');
    return value === 'true';
  } catch {
    return false;
  }
}

/** Check settled once and throw if the app has settled after the grace period. */
async function checkAndThrowIfSettled(page: Page, signal: { cancelled: boolean }): Promise<void> {
  const isSettled = await checkSettled(page);
  if (signal.cancelled) return;

  if (isSettled) {
    await sleep(GRACE_MS);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (signal.cancelled) return;

    throw new Error(
      'App settled (all queries/mutations/streams complete) but assertion not satisfied. ' +
        'The expected condition will not be met. ' +
        'Use unsettledExpect to opt out.'
    );
  }
}

/** Poll the settled indicator until it fires, then throw. */
async function pollUntilSettled(
  page: Page,
  signal: { cancelled: boolean },
  timeout: number
): Promise<never> {
  const start = Date.now();

  while (!signal.cancelled && Date.now() - start < timeout) {
    await sleep(POLL_MS);
    // signal.cancelled is mutated asynchronously by Promise.race .finally()
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (signal.cancelled) break;

    if (Date.now() - start >= FLOOR_MS) {
      await checkAndThrowIfSettled(page, signal);
    }
  }

  // Never resolve — let the original assertion handle timeout
  return new Promise<never>(Function.prototype as () => void);
}

async function raceWithSettled<T>(page: Page, assertion: Promise<T>, timeout: number): Promise<T> {
  const signal = { cancelled: false };

  try {
    return await Promise.race([
      assertion.finally(() => {
        signal.cancelled = true;
      }),
      pollUntilSettled(page, signal, timeout),
    ]);
  } finally {
    signal.cancelled = true;
  }
}

function extractTimeout(arguments_: unknown[]): number {
  const last = arguments_.at(-1);
  if (last && typeof last === 'object' && 'timeout' in last) {
    return (last as { timeout?: number }).timeout ?? DEFAULT_TIMEOUT;
  }
  return DEFAULT_TIMEOUT;
}

function isLocator(value: unknown): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    'page' in value &&
    typeof (value as Record<string, unknown>)['page'] === 'function'
  );
}

function isPage(value: unknown): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    'url' in value &&
    typeof (value as Record<string, unknown>)['url'] === 'function' &&
    !('page' in value)
  );
}

function getPageFromTarget(target: unknown): Page | null {
  if (isLocator(target)) return (target as { page: () => Page }).page();
  if (isPage(target)) return target as Page;
  return null;
}

function createSettledMatcherProxy<T extends object>(assertions: T, page: Page): T {
  const handler: ProxyHandler<T> = {
    // Proxy get handlers inherently return mixed types — the handler must return
    // whatever the underlying target would return for a given property access.
    // eslint-disable-next-line sonarjs/function-return-type
    get(proxyTarget, property, receiver) {
      if (property === 'not') {
        const notAssertions = Reflect.get(proxyTarget, property, receiver) as object;
        return createSettledMatcherProxy(notAssertions, page);
      }

      const value = Reflect.get(proxyTarget, property, receiver);
      if (typeof value !== 'function') return value;

      return (...arguments_: unknown[]): unknown => {
        const result = (value as (...a: unknown[]) => unknown).apply(proxyTarget, arguments_);
        if (result instanceof Promise) {
          const timeout = extractTimeout(arguments_);
          return raceWithSettled(page, result, timeout);
        }
        return result;
      };
    },
  };

  return new Proxy(assertions, handler);
}

type BaseExpect = typeof baseExpect;

/** Playwright's configure options extended with our settled-aware flag. */
type SettledConfigureOptions = Parameters<BaseExpect['configure']>[0] & {
  settledAware?: boolean;
};

/** Expect with settled-aware configure. */
type SettledExpect = BaseExpect & {
  configure(options: SettledConfigureOptions): SettledExpect;
};

function wrapExpectCall(
  baseFunction: (...arguments_: unknown[]) => unknown,
  arguments_: unknown[]
): unknown {
  const [actual] = arguments_;
  const result = baseFunction(...arguments_);
  const page = getPageFromTarget(actual);
  if (page && result && typeof result === 'object') {
    return createSettledMatcherProxy(result, page);
  }
  return result;
}

function createSettledExpect(base: BaseExpect): BaseExpect {
  const handler: ProxyHandler<BaseExpect> = {
    apply(target, thisArgument, arguments_: unknown[]) {
      return wrapExpectCall(
        (...a: unknown[]) => Reflect.apply(target, thisArgument, a),
        arguments_
      );
    },

    get(target, property, receiver) {
      if (property === 'configure') {
        return (options: Record<string, unknown>): BaseExpect => {
          const { settledAware, ...playwrightOptions } = options;
          const configured = target.configure(
            playwrightOptions as Parameters<BaseExpect['configure']>[0]
          );
          if (settledAware === false) {
            return configured;
          }
          return createSettledExpect(configured);
        };
      }

      if (property === 'soft') {
        const softFunction = Reflect.get(target, property, receiver) as (
          ...arguments_: unknown[]
        ) => unknown;
        return (...arguments_: unknown[]): unknown => wrapExpectCall(softFunction, arguments_);
      }

      return Reflect.get(target, property, receiver) as unknown;
    },
  };

  return new Proxy(base, handler);
}

export const expect: SettledExpect = createSettledExpect(baseExpect) as SettledExpect;
export const unsettledExpect = expect.configure({ settledAware: false });
export { createSettledExpect };
export type { SettledExpect, SettledConfigureOptions };
