/**
 * Settled-aware `expect` wrapper for Playwright.
 *
 * Automatically races locator/page assertions against the app's settled signal.
 * When the app settles (all TanStack Query fetches, mutations, and SSE streams
 * complete with 300ms debounce) and an assertion hasn't passed, it fails
 * immediately instead of waiting for the full timeout.
 *
 * Opt out for assertions that wait for external events (webhooks, WebSocket):
 *   const raw = expect.configure({ settledAware: false });
 *   await raw(locator).toBeVisible({ timeout: 30_000 });
 */

import { expect as baseExpect, type Page } from '@playwright/test';

const FLOOR_MS = 500;
const GRACE_MS = 500;
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

async function raceWithSettled<T>(page: Page, assertion: Promise<T>, timeout: number): Promise<T> {
  let cancelled = false;

  const watcher = (async (): Promise<never> => {
    const start = Date.now();

    while (!cancelled && Date.now() - start < timeout) {
      await sleep(POLL_MS);
      if (cancelled) break;

      // Don't check settled until floor period has passed
      if (Date.now() - start < FLOOR_MS) continue;

      const isSettled = await checkSettled(page);
      if (cancelled) break;

      if (isSettled) {
        await sleep(GRACE_MS);
        if (cancelled) break;

        throw new Error(
          'App settled (all queries/mutations/streams complete) but assertion not satisfied. ' +
            'The expected condition will not be met. ' +
            'Use expect.configure({ settledAware: false }) to opt out.'
        );
      }
    }

    // Never resolve — let the original assertion handle timeout
    return new Promise<never>(() => {});
  })();

  try {
    return await Promise.race([
      assertion.finally(() => {
        cancelled = true;
      }),
      watcher,
    ]);
  } finally {
    cancelled = true;
  }
}

function extractTimeout(args: unknown[]): number {
  const lastArg = args.at(-1);
  if (lastArg && typeof lastArg === 'object' && lastArg !== null && 'timeout' in lastArg) {
    return ((lastArg as { timeout?: number }).timeout ?? DEFAULT_TIMEOUT);
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
    get(proxyTarget, prop, receiver) {
      if (prop === 'not') {
        const notAssertions = Reflect.get(proxyTarget, prop, receiver) as object;
        return createSettledMatcherProxy(notAssertions, page);
      }

      const value = Reflect.get(proxyTarget, prop, receiver);
      if (typeof value !== 'function') return value;

      return (...args: unknown[]): unknown => {
        const result = (value as (...a: unknown[]) => unknown).apply(proxyTarget, args);
        if (result instanceof Promise) {
          const timeout = extractTimeout(args);
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

function wrapExpectCall(baseFn: (...args: unknown[]) => unknown, args: unknown[]): unknown {
  const [actual] = args;
  const result = baseFn(...args);
  const page = getPageFromTarget(actual);
  if (page && result && typeof result === 'object') {
    return createSettledMatcherProxy(result as object, page);
  }
  return result;
}

function createSettledExpect(base: BaseExpect): BaseExpect {
  const handler: ProxyHandler<BaseExpect> = {
    apply(target, thisArg, args: unknown[]) {
      return wrapExpectCall(
        (...a: unknown[]) => Reflect.apply(target, thisArg, a),
        args
      );
    },

    get(target, prop, receiver) {
      if (prop === 'configure') {
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

      if (prop === 'soft') {
        const softFn = Reflect.get(target, prop, receiver) as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown => wrapExpectCall(softFn, args);
      }

      return Reflect.get(target, prop, receiver);
    },
  };

  return new Proxy(base, handler) as BaseExpect;
}

export const expect: SettledExpect = createSettledExpect(baseExpect) as SettledExpect;
export { createSettledExpect };
export type { SettledExpect, SettledConfigureOptions };
