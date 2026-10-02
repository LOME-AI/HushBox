import { routePath } from 'hono/route';
import { respondDomainError, respondOk } from '../../../middleware/pipeline-manifest.js';
import {
  callerUserId,
  createErrorResponse,
  idempotent,
  isRefusal,
  readIdempotencyKey,
  refusalToWire,
  runMutation,
} from '../domain/index.js';
import type { Context } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { DomainError, Outcome, Refusal, Result } from '../domain/index.js';

/**
 * Success payloads pass through; refusals answer their mapped wire error. The
 * success-response type `R` is threaded through (not widened to `Response`) so
 * the concrete 200 body survives into `AppType` for `hc<AppType>` to infer.
 *
 * eslint-disable-next-line sonarjs/function-return-type -- the polymorphic
 * return is the point: the caller's success `TypedResponse<R>` must reach the
 * route chain distinct from the refusal's error `TypedResponse`; collapsing the
 * two to one type re-erases the 200 body from `AppType`.
 */
// eslint-disable-next-line sonarjs/function-return-type -- see doc comment above
export function respondOutcome<S extends object, R>(
  c: Context<AppEnv>,
  outcome: Outcome<S>,
  respond: (success: Exclude<S, Refusal>) => R
) {
  if (isRefusal(outcome)) {
    const wire = refusalToWire(outcome);
    return c.json(createErrorResponse(wire.code, wire.details), wire.status);
  }
  // The guard above eliminated every refusal variant; TS cannot subtract a
  // union member from an unresolved generic, so the narrowing is asserted.
  return respond(outcome as Exclude<S, Refusal>);
}

/**
 * The uniform handler tail: success answers 200 JSON, refusals and errors map
 * to wire codes. The return type is inferred so the 200 body type flows into
 * `AppType` — annotating it `Response` would erase it and blind the typed
 * client.
 */
export function respond200<S extends object>(
  c: Context<AppEnv>,
  result: Result<Outcome<S>, DomainError>
) {
  return result.match(
    (outcome) => respondOutcome(c, outcome, (success) => respondOk(c, success)),
    (error) => respondDomainError(c, error)
  );
}

/**
 * The pipeline enforced the header before the handler ran; absence is a
 * defect. Exported so the defect arm stays executable in tests — no request
 * can reach a byKey handler without the header while the pipeline stage
 * holds (the `continueFromClaim` precedent in lib/idempotency).
 */
export function requiredIdempotencyKey(c: Context<AppEnv>): string {
  const key = readIdempotencyKey(c);
  if (key === undefined) {
    throw new Error('conversations: idempotency key missing after the pipeline stage');
  }
  return key;
}

interface ByKeyRoute<T> {
  readonly c: Context<AppEnv>;
  /** The validated request identity (body and/or params) for the body hash. */
  readonly body: unknown;
  readonly responseSchema: z.ZodType<T>;
  readonly execute: Parameters<typeof idempotent.byKey<T>>[0]['execute'];
}

/** One byKey envelope per mutating route: scope, body hash, claim, execute. */
export function runByKey<T>(route: ByKeyRoute<T>): ReturnType<typeof idempotent.byKey<T>> {
  const { c } = route;
  return runMutation(() =>
    idempotent.byKey({
      db: c.var.db,
      scope: {
        userId: callerUserId(c.var.principal),
        route: routePath(c),
        key: requiredIdempotencyKey(c),
      },
      body: route.body,
      executorId: crypto.randomUUID(),
      responseSchema: route.responseSchema,
      execute: route.execute,
    })
  );
}
