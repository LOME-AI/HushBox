import { isRetryableError, retryOnTransientStatus } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import type { APIRequestContext, APIResponse } from '@playwright/test';

/**
 * HTTP methods that return an `APIResponse` and are safe to retry on a transient
 * failure. Every endpoint a test hits node-side is a dev/setup or read endpoint
 * (idempotent), so re-issuing one — including a POST — cannot double-apply.
 */
const RETRYABLE_METHODS = new Set(['get', 'head', 'post', 'put', 'patch', 'delete', 'fetch']);

/** Brands a context as already wrapped so re-wrapping is a no-op. */
const WRAPPED = Symbol('withRequestRetry');

/**
 * Wrap a Playwright `APIRequestContext` so every HTTP method transparently
 * retries a transient failure — a 5xx runtime envelope or a thrown
 * `socket hang up` from a wrangler/workerd recycle under host saturation —
 * until it settles or the {@link TIMEOUTS.API_SETUP} budget elapses. A terminal
 * status (2xx/4xx) returns immediately, so a genuine app error still surfaces.
 *
 * This is the single retry mechanism for node-side test requests: the `request`
 * and `authenticatedRequest` fixtures (and every `playwright.request.newContext`
 * the harness creates) hand back a wrapped context, so a plain `request.get(...)`
 * is resilient by construction — there are no per-call `*WithRetry` wrappers to
 * forget. A lint rule forbids reaching past it via `page.request.<method>()`.
 *
 * Idempotent: re-wrapping an already-wrapped context returns it unchanged, so a
 * helper that defensively wraps an injected context never double-retries.
 */
export function withRequestRetry(request: APIRequestContext): APIRequestContext {
  const marker = request as APIRequestContext & { [WRAPPED]?: true };
  if (marker[WRAPPED]) return request;

  return new Proxy(request, {
    get(target, property, receiver): unknown {
      if (property === WRAPPED) return true;
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (typeof property === 'string' && RETRYABLE_METHODS.has(property)) {
        const method = value as (...args: unknown[]) => Promise<APIResponse>;
        return (...args: unknown[]): Promise<APIResponse> =>
          retryOnTransientStatus(
            () => method.apply(target, args),
            (response) => response.status(),
            { timeoutMs: TIMEOUTS.API_SETUP, isRetryableError }
          );
      }
      return (value as (...args: unknown[]) => unknown).bind(target);
    },
  });
}
