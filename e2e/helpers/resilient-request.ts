import { isRetryableError, retryOnTransientStatus } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import type { APIRequestContext, APIResponse } from '@playwright/test';

/**
 * HTTP methods that return an `APIResponse`, and so the ones this wrapper can
 * retry at all. Whether a given call is actually re-sent is settled per call by
 * {@link isReplaySafe} — carrying a retryable method is necessary, not
 * sufficient.
 */
const RETRYABLE_METHODS = new Set(['get', 'head', 'post', 'put', 'patch', 'delete', 'fetch']);

/** Methods whose re-send double-applies unless the server can recognise the replay. */
const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** The slice of Playwright's request options this wrapper reads. */
interface InspectedOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
}

/** The options bag a request method was called with, or an empty one. */
function inspectedOptions(args: readonly unknown[]): InspectedOptions {
  const [, options] = args;
  return typeof options === 'object' && options !== null ? (options as InspectedOptions) : {};
}

function carriesIdempotencyKey({ headers }: InspectedOptions): boolean {
  if (headers === undefined) return false;
  return Object.keys(headers).some((name) => name.toLowerCase() === IDEMPOTENCY_KEY_HEADER);
}

/**
 * The method named by a `Request` handed to `fetch` as its target, when one was.
 * `fetch` takes `string | Request`, and a `Request` carries its own method, so
 * reading the options bag alone would classify a POST as a read.
 */
function targetRequestMethod(args: readonly unknown[]): string | undefined {
  const [target] = args;
  if (typeof target !== 'object' || target === null) return undefined;
  const { method } = target as { method?: () => string };
  return typeof method === 'function' ? method.call(target) : undefined;
}

/**
 * Whether re-issuing this exact call cannot double-apply. A read always can be.
 * A mutating call can only while the server collapses the replay, which it does
 * on the `Idempotency-Key` the call carries — minted once per logical call by
 * the wrappers in `e2e/helpers/idempotent-request.ts`, so a re-send presents the
 * same key. A mutating call carrying none (a dev or setup route declaring an
 * idempotency exemption, say) is sent once and its failure surfaces, rather than
 * being re-sent on a premise this wrapper cannot see.
 *
 * `fetch` names its method in the options bag or in its target `Request` instead
 * of in the property, and defaults to GET when neither names one. The key is
 * read off the options bag only, so a target `Request` carrying its own key
 * reads as unkeyed — the refusing direction, which is the safe one.
 */
function isReplaySafe(property: string, args: readonly unknown[]): boolean {
  const options = inspectedOptions(args);
  const method =
    property === 'fetch' ? (options.method ?? targetRequestMethod(args) ?? 'get') : property;
  if (!MUTATING_METHODS.has(method.toLowerCase())) return true;
  return carriesIdempotencyKey(options);
}

/** Brands a context as already wrapped so re-wrapping is a no-op. */
const WRAPPED = Symbol('withRequestRetry');

/**
 * Wrap a Playwright `APIRequestContext` so a call that {@link isReplaySafe}
 * admits transparently retries a transient failure — a 5xx runtime envelope or
 * a thrown `socket hang up` from a wrangler/workerd recycle under host
 * saturation — until it settles or the {@link TIMEOUTS.API_SETUP} budget
 * elapses. A terminal status (2xx/4xx) returns immediately, so a genuine app
 * error still surfaces.
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
        return (...args: unknown[]): Promise<APIResponse> => {
          const send = (): Promise<APIResponse> => method.apply(target, args);
          if (!isReplaySafe(property, args)) return send();
          return retryOnTransientStatus(send, (response) => response.status(), {
            timeoutMs: TIMEOUTS.API_SETUP,
            isRetryableError,
          });
        };
      }
      return (value as (...args: unknown[]) => unknown).bind(target);
    },
  });
}
