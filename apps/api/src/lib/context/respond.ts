import { ERROR_CODES } from '@hushbox/shared';
import { createErrorResponse } from '../errors/index.js';
import type { Context, Env, TypedResponse } from 'hono';
import type { ErrorResponse } from '@hushbox/shared';
import type { ClientErrorStatusCode, ServerErrorStatusCode } from 'hono/utils/http-status';
import type { JSONParsed } from 'hono/utils/types';

/**
 * The shared success tail. Returns `c.json(body, 200)` while preserving the
 * concrete body type instead of widening it to `Response`.
 *
 * `hc<AppType>` infers a route's 200 body only when the handler's returned
 * value keeps its `TypedResponse<T>` type through to the route chain. Annotating
 * a success return as bare `Response` — or routing it through a helper that
 * does — erases `T`, blinding the typed client and forcing the web app to
 * re-assert every body by hand. Every slice routes its 200 through this idiom
 * (or an inline `c.json(body, 200)`, which is type-equivalent) so the body type
 * flows into `AppType`.
 */
export function respondOk<T extends object>(
  c: Context,
  body: T
): TypedResponse<JSONParsed<T>, 200, 'json'> {
  return c.json(body, 200);
}

/**
 * The status range a refusal answers in. Narrower than `ContentfulStatusCode` so
 * a client's `InferResponseType<…, 200>` still resolves to the success body
 * alone rather than to it unioned with every refusal body.
 */
export type RefusalStatus = ClientErrorStatusCode | ServerErrorStatusCode;

/**
 * The refusal counterpart to `respondOk`: a rejection answered as the uniform
 * `{code}` body. What a bare `Response` costs the typed client instead is
 * demonstrated by the slices' route-response type pins, under counterfactual.
 *
 * The `Response` intersection (what `c.json` itself returns) is load-bearing:
 * helpers that hand a refusal-or-value back to their caller discriminate the two
 * with `value instanceof Response`, which narrows on it.
 */
export type RefusalResponse = Response &
  TypedResponse<JSONParsed<ErrorResponse>, RefusalStatus, 'json'>;

/**
 * The `zValidator` hook every route hands its schemas: malformed input answers
 * the uniform `{code}` body at 400 instead of the validator's default
 * `ZodError` dump.
 *
 * The context is typed with hono's base `Env` rather than `AppEnv` because the
 * hook's `E` is not inferred from the route chain, and `AppEnv` here would fail
 * contravariance.
 */
export function rejectInvalid(
  result: { readonly success: boolean },
  c: Context<Env, string>
): Response | undefined {
  return result.success ? undefined : c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
}
