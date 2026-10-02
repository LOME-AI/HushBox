import { routePath } from 'hono/route';
import { P, match } from 'ts-pattern';
import { ERROR_CODES } from '@hushbox/shared';
import { FINGERPRINT_CODES, createErrorResponse } from '../domain/index.js';
import type { ErrorCode } from '@hushbox/shared';
import type { Context } from 'hono';
import type {
  AppEnv,
  RefusalResponse,
  RefusalStatus,
} from '../../../middleware/pipeline-manifest.js';

export function rateLimitedResponse(
  c: Context<AppEnv>,
  retryAfterSeconds: number
): RefusalResponse {
  return c.json(createErrorResponse(ERROR_CODES.RATE_LIMITED, { retryAfterSeconds }), 429);
}

function tooManyAttemptsResponse(c: Context<AppEnv>, retryAfterSeconds: number): RefusalResponse {
  return c.json(createErrorResponse(ERROR_CODES.TOO_MANY_ATTEMPTS, { retryAfterSeconds }), 429);
}

/** One-line error arm for the ts-pattern matches below. */
export function errorJson(
  c: Context<AppEnv>,
  code: ErrorCode,
  status: RefusalStatus
): RefusalResponse {
  return c.json(createErrorResponse(code), status);
}

/**
 * A row whose sealed OPAQUE material names a KEK this deployment does not
 * hold. The user can do nothing about it and the caller's code says only that
 * the server failed; the capture is the channel an operator learns from.
 */
export function serverMaterialUnreadable(c: Context<AppEnv>): RefusalResponse {
  c.var.logger.captureError(
    new Error(
      'identity: stored OPAQUE server material is sealed under a KEK this deployment does not hold'
    ),
    FINGERPRINT_CODES.opaqueServerMaterialUnreadable
  );
  return errorJson(c, ERROR_CODES.INTERNAL, 500);
}

/**
 * A stored TOTP secret sealed under a TOTP key this deployment does not hold.
 * Every 2FA gate refuses the user until an admin clears the stranded second
 * factor, so a human must act, and the repair is addressed to one user — hence
 * both facts ride as PROPERTIES of the captured error rather than only on the
 * log line: the Sentry scrub drops the message and rebuilds the event from an
 * allowlist, and `apps/api/src/lib/telemetry/adapters/sentry-scrub.ts` lifts
 * these two keys into tags, which is the only channel a deployment retains.
 * The route is the matched route TEMPLATE, so it names the gate without
 * carrying anything a caller supplied.
 */
export function totpSecretStranded(c: Context<AppEnv>, userId: string): RefusalResponse {
  const route = routePath(c);
  c.var.logger.error('identity: stored TOTP secret is sealed under a foreign TOTP key', {
    userId,
    route,
    errorCode: FINGERPRINT_CODES.totpSecretStranded,
  });
  const error = new Error(
    'identity: stored TOTP secret is sealed under a TOTP key this deployment does not hold'
  );
  Object.assign(error, { totpStrandedUserId: userId, totpStrandedRoute: route });
  c.var.logger.captureError(error, FINGERPRINT_CODES.totpSecretStranded);
  return errorJson(c, ERROR_CODES.TOTP_SECRET_STRANDED, 500);
}

/**
 * The two refusals every password-gated init shares: the attempt cap and a
 * row whose material this deployment cannot open.
 */
export function stepUpInitRefusal(
  c: Context<AppEnv>,
  outcome: { kind: 'locked'; retryAfterSeconds: number } | { kind: 'server-material-unreadable' }
): RefusalResponse {
  return outcome.kind === 'locked'
    ? tooManyAttemptsResponse(c, outcome.retryAfterSeconds)
    : serverMaterialUnreadable(c);
}

/**
 * The wire mapping of a stored-TOTP verdict, shared by every gate that checks
 * a stored code so no gate can answer `stranded` differently from another.
 * The wrong-code arm carries two names across the gates; both are one 400.
 */
export function totpVerdictResponse(
  c: Context<AppEnv>,
  userId: string,
  verdict:
    | { kind: 'locked'; retryAfterSeconds: number }
    | { kind: 'not-configured' }
    | { kind: 'stranded' }
    | { kind: 'invalid' | 'invalid-code' }
): RefusalResponse {
  return match(verdict)
    .with({ kind: 'locked' }, (o) => tooManyAttemptsResponse(c, o.retryAfterSeconds))
    .with({ kind: 'not-configured' }, () => errorJson(c, ERROR_CODES.INTERNAL, 500))
    .with({ kind: 'stranded' }, () => totpSecretStranded(c, userId))
    .with({ kind: P.union('invalid', 'invalid-code') }, () =>
      errorJson(c, ERROR_CODES.INVALID_TOTP_CODE, 400)
    )
    .exhaustive();
}

/**
 * A re-registration refused at its finish: the KEK moved under the pin, or
 * the observed record was replaced first. Both are a conflict the client
 * resolves by starting over.
 */
export function rotationRefused(
  c: Context<AppEnv>,
  outcome: { kind: 'kek-rotated' } | { kind: 'credential-conflict' }
): RefusalResponse {
  return errorJson(
    c,
    outcome.kind === 'kek-rotated'
      ? ERROR_CODES.OPAQUE_KEK_ROTATED
      : ERROR_CODES.CREDENTIAL_CONFLICT,
    409
  );
}
