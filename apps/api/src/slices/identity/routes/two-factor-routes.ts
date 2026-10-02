import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { P, match } from 'ts-pattern';
import { ERROR_CODES } from '@hushbox/shared';
import {
  rejectInvalid,
  respondDomainError,
  routeClass,
} from '../../../middleware/pipeline-manifest.js';
import {
  createDisable2faFinishFlow,
  createTotpVerifySetupFlow,
  disable2faFinishBodySchema,
  disable2faInitBodySchema,
  idempotencyExempt,
  idempotent,
  runMutation,
  startDisable2fa,
  startTotpSetup,
  totpCodeBodySchema,
  verifyLogin2fa,
} from '../domain/index.js';
import { errorJson, stepUpInitRefusal, totpVerdictResponse } from './refusals.js';
import { loginSuccessBody, fullClaims, opaqueDeps, freshHandshake } from './handler-support.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { IdentityRouteDeps } from './deps.js';

export function twoFactorRoutes(deps: IdentityRouteDeps) {
  return (
    new Hono<AppEnv>()
      // 2FA enrollment: setup mints a fresh secret (server-minted event id, so
      // the first delivery wins by construction); verify confirms the first
      // code and flips totpEnabled. Both are the `opaque-protocol` 2FA family.
      .post(
        '/2fa/setup',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                startTotpSetup({
                  ...opaqueDeps(c, deps),
                  userId: fullClaims(c).userId,
                })
              )
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'already-enabled' }, () =>
              errorJson(c, ERROR_CODES.TOTP_ALREADY_ENABLED, 400)
            )
            .with({ kind: 'started' }, (o) => c.json({ totpUri: o.totpUri, secret: o.secret }, 200))
            .exhaustive();
        }
      )
      .post(
        '/2fa/verify',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', totpCodeBodySchema, rejectInvalid),
        async (c) => {
          const flow = createTotpVerifySetupFlow({
            ...opaqueDeps(c, deps),
            enabledEmail: deps.twoFactorEnabledEmailPort,
            userId: fullClaims(c).userId,
            code: c.req.valid('json').code,
            now: new Date(),
          });
          const result = await runMutation(() => idempotent.byEventId(flow));
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'no-pending' }, () => errorJson(c, ERROR_CODES.NO_PENDING_2FA_SETUP, 400))
            .with({ kind: 'invalid-code' }, () => errorJson(c, ERROR_CODES.INVALID_TOTP_CODE, 400))
            .with({ kind: 'already-enabled' }, () =>
              errorJson(c, ERROR_CODES.TOTP_ALREADY_ENABLED, 400)
            )
            .with({ kind: 'enabled' }, () => c.json({ success: true as const }, 200))
            .exhaustive();
        }
      )
      // Login 2FA: promotes a pending-2fa session to full. A wrong code answers
      // the same invalid-code as an unenrolled attempt; the lockout throttles.
      .post(
        '/login/2fa/verify',
        routeClass('pending-2fa'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', totpCodeBodySchema, rejectInvalid),
        async (c) => {
          // The pending-2fa class deliberately admits every principal kind
          // (logout shares it), so a non-pending caller here is EXPECTED
          // client input — a graceful 401 (no live 2FA challenge; re-login),
          // never a thrown defect. Mirrors derivePrincipal degrading an
          // expired challenge to `none`.
          const principal = c.var.principal;
          if (principal.kind !== 'pending-2fa') {
            return errorJson(c, ERROR_CODES.UNAUTHORIZED, 401);
          }
          const claims = principal.claims;
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                verifyLogin2fa({
                  ...opaqueDeps(c, deps),
                  userId: claims.userId,
                  sessionId: claims.sessionId,
                  code: c.req.valid('json').code,
                  now: new Date(),
                  request: c.req.raw,
                  response: c.res,
                  secret: c.var.bindings.IRON_SESSION_SECRET,
                  isProduction: c.var.envUtils.isProduction,
                  evictUser: deps.evictUser(c.var.redis, c.env),
                })
              )
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: P.union('locked', 'not-configured', 'stranded', 'invalid') }, (o) =>
              totpVerdictResponse(c, claims.userId, o)
            )
            .with({ kind: 'promoted' }, ({ user }) => c.json(loginSuccessBody(user), 200))
            .exhaustive();
        }
      )
      // 2FA disable: step-up (password) AND a TOTP code both required.
      .post(
        '/2fa/disable/init',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', disable2faInitBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                startDisable2fa({
                  ...opaqueDeps(c, deps),
                  userId: fullClaims(c).userId,
                  ke1: c.req.valid('json').ke1,
                })
              )
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'not-enabled' }, () => errorJson(c, ERROR_CODES.TOTP_NOT_ENABLED, 400))
            .with({ kind: P.union('locked', 'server-material-unreadable') }, (o) =>
              stepUpInitRefusal(c, o)
            )
            .with({ kind: 'started' }, (o) =>
              c.json({ ke2: o.ke2, disable2FASessionId: o.disable2FASessionId }, 200)
            )
            .exhaustive();
        }
      )
      .post(
        '/2fa/disable/finish',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', disable2faFinishBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const { userId } = fullClaims(c);
          const flow = createDisable2faFinishFlow({
            ...opaqueDeps(c, deps),
            disabledEmail: deps.twoFactorDisabledEmailPort,
            userId,
            ke3: body.ke3,
            code: body.code,
            disable2FASessionId: body.disable2FASessionId,
            now: new Date(),
          });
          const result = await runMutation(() => idempotent.byEventId(flow));
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'no-step-up' }, () => errorJson(c, ERROR_CODES.NO_PENDING_STEP_UP, 400))
            .with({ kind: 'bad-proof' }, () => errorJson(c, ERROR_CODES.AUTH_FAILED, 401))
            .with({ kind: 'verified' }, ({ value }) =>
              match(value)
                .with(
                  { kind: P.union('locked', 'not-configured', 'stranded', 'invalid-code') },
                  (o) => totpVerdictResponse(c, userId, o)
                )
                .with({ kind: 'not-enabled' }, () =>
                  errorJson(c, ERROR_CODES.TOTP_NOT_ENABLED, 400)
                )
                .with({ kind: 'disabled' }, () => c.json({ success: true as const }, 200))
                .exhaustive()
            )
            .exhaustive();
        }
      )
  );
}
