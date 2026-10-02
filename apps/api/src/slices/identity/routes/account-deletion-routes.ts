import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { P, match } from 'ts-pattern';
import { ERROR_CODES, nanoUSD, serializeNanoUSD } from '@hushbox/shared';
import {
  rejectInvalid,
  respondDomainError,
  routeClass,
} from '../../../middleware/pipeline-manifest.js';
import {
  createDeleteAccountFinishFlow,
  createErrorResponse,
  deleteAccountFinishBodySchema,
  deleteAccountInitBodySchema,
  destroySessionCookie,
  idempotencyExempt,
  idempotent,
  runMutation,
  startDeleteAccount,
} from '../domain/index.js';
import { errorJson, totpSecretStranded, stepUpInitRefusal } from './refusals.js';
import { fullClaims, opaqueDeps, freshHandshake } from './handler-support.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { IdentityRouteDeps } from './deps.js';

export function accountDeletionRoutes(deps: IdentityRouteDeps) {
  return (
    new Hono<AppEnv>()
      // Account-deletion request: step-up gated, with a deletion lockout.
      .post(
        '/account/delete/init',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', deleteAccountInitBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                startDeleteAccount({
                  ...opaqueDeps(c, deps),
                  userId: fullClaims(c).userId,
                  ke1: c.req.valid('json').ke1,
                })
              )
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: P.union('locked', 'server-material-unreadable') }, (o) =>
              stepUpInitRefusal(c, o)
            )
            .with({ kind: 'started' }, (o) =>
              c.json({ ke2: o.ke2, deleteAccountSessionId: o.deleteAccountSessionId }, 200)
            )
            .exhaustive();
        }
      )
      .post(
        '/account/delete/finish',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', deleteAccountFinishBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const { userId } = fullClaims(c);
          const flow = createDeleteAccountFinishFlow({
            ...opaqueDeps(c, deps),
            db: c.var.db,
            purge: deps.deletionPurge(c.env, c.var.db),
            accountDeletedEmail: deps.accountDeletedEmailPort,
            evictUser: deps.evictUser(c.var.redis, c.env),
            userId,
            // Legacy parity: the anonymous forensic event records the request's
            // network fingerprint, never an identity.
            ipAddress: c.req.header('cf-connecting-ip') ?? null,
            userAgent: c.req.header('user-agent') ?? null,
            ke3: body.ke3,
            deleteAccountSessionId: body.deleteAccountSessionId,
            confirmationPhrase: body.confirmationPhrase,
            totpCode: body.totpCode,
            billingStores: deps.billingStores,
            acknowledgedForfeitNanoUsd: body.acknowledgedForfeitNanoUsd,
            now: new Date(),
          });
          const result = await runMutation(() => idempotent.byEventId(flow));
          if (result.isErr()) return respondDomainError(c, result.error);
          const outcome = result.value;
          if (outcome.kind === 'deleted') {
            // The account is gone; the cookie follows it (mirrors logout).
            await destroySessionCookie({
              request: c.req.raw,
              response: c.res,
              secret: c.var.bindings.IRON_SESSION_SECRET,
              isProduction: c.var.envUtils.isProduction,
            });
            return c.json({ success: true as const }, 200);
          }
          return (
            match(outcome)
              .with({ kind: 'no-step-up' }, () => errorJson(c, ERROR_CODES.NO_PENDING_STEP_UP, 400))
              // Legacy parity: the deletion lock answers 403 DELETE_ACCOUNT_LOCKED
              // (not the generic 429 TOO_MANY_ATTEMPTS). `retryAfterSeconds` stays
              // in `details` so the web client — which keys on that detail, not the
              // code — still renders the lockout countdown.
              .with({ kind: 'locked' }, (o) =>
                c.json(
                  createErrorResponse(ERROR_CODES.DELETE_ACCOUNT_LOCKED, {
                    retryAfterSeconds: o.retryAfterSeconds,
                  }),
                  403
                )
              )
              .with({ kind: 'bad-proof' }, () => errorJson(c, ERROR_CODES.AUTH_FAILED, 401))
              .with({ kind: 'invalid-phrase' }, () =>
                errorJson(c, ERROR_CODES.INVALID_CONFIRMATION_PHRASE, 400)
              )
              .with({ kind: 'totp-required' }, () =>
                errorJson(c, ERROR_CODES.TOTP_CODE_REQUIRED, 400)
              )
              .with({ kind: 'invalid-totp' }, () =>
                errorJson(c, ERROR_CODES.INVALID_TOTP_CODE, 400)
              )
              .with({ kind: 'totp-not-configured' }, () => errorJson(c, ERROR_CODES.INTERNAL, 500))
              .with({ kind: 'totp-stranded' }, () => totpSecretStranded(c, userId))
              .with({ kind: 'forfeit-unacknowledged' }, (o) =>
                c.json(
                  createErrorResponse(ERROR_CODES.DELETE_ACCOUNT_FORFEIT_UNACKNOWLEDGED, {
                    purchasedBalanceNanoUsd: serializeNanoUSD(nanoUSD(o.purchasedBalanceNanoUsd)),
                  }),
                  409
                )
              )
              // The vanished-user race: another finish deleted the row first.
              .with({ kind: 'not-found' }, () => errorJson(c, ERROR_CODES.NOT_FOUND, 404))
              .exhaustive()
          );
        }
      )
  );
}
