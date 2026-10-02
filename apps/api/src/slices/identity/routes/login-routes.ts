import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { match } from 'ts-pattern';
import { ERROR_CODES } from '@hushbox/shared';
import {
  rejectInvalid,
  respondDomainError,
  routeClass,
} from '../../../middleware/pipeline-manifest.js';
import {
  createLoginFinishFlow,
  destroySessionCookie,
  idempotencyExempt,
  idempotent,
  loginFinishBodySchema,
  loginInitBodySchema,
  resolveTrustedCallerIpId,
  revokeSession,
  runMutation,
  startLogin,
} from '../domain/index.js';
import { rateLimitedResponse, errorJson, serverMaterialUnreadable } from './refusals.js';
import { loginSuccessBody, opaqueDeps, freshHandshake } from './handler-support.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { IdentityRouteDeps } from './deps.js';

export function loginRoutes(deps: IdentityRouteDeps) {
  return (
    new Hono<AppEnv>()
      .post(
        '/login/init',
        routeClass('public'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', loginInitBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          // The caller's network identity, which half this route's bound is
          // keyed on. The trusted resolver, never the sentinel one: a request
          // the edge left no address on must refuse rather than join one
          // window every caller behind that fault would share.
          const callerNetworkId = await resolveTrustedCallerIpId(
            (name) => c.req.header(name),
            c.var.envUtils
          );
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                startLogin({
                  ...opaqueDeps(c, deps),
                  accountLockedEmail: deps.accountLockedEmailPort,
                  identifier: body.identifier,
                  ke1: body.ke1,
                  callerNetworkId,
                })
              )
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'rate-limited' }, (o) => rateLimitedResponse(c, o.retryAfterSeconds))
            .with({ kind: 'server-material-unreadable' }, () => serverMaterialUnreadable(c))
            .with({ kind: 'started' }, (o) =>
              c.json({ ke2: o.ke2, loginSessionId: o.loginSessionId }, 200)
            )
            .exhaustive();
        }
      )
      .post(
        '/login/finish',
        routeClass('public'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', loginFinishBodySchema, rejectInvalid),
        async (c) => {
          const callerNetworkId = await resolveTrustedCallerIpId(
            (name) => c.req.header(name),
            c.var.envUtils
          );
          const flow = createLoginFinishFlow({
            ...opaqueDeps(c, deps),
            callerNetworkId,
            request: c.req.raw,
            response: c.res,
            secret: c.var.bindings.IRON_SESSION_SECRET,
            isProduction: c.var.envUtils.isProduction,
            now: Date.now(),
            ...c.req.valid('json'),
          });
          const result = await runMutation(() => idempotent.byEventId(flow));
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'no-pending' }, () => errorJson(c, ERROR_CODES.NO_PENDING_LOGIN, 400))
            .with({ kind: 'auth-failed' }, () => errorJson(c, ERROR_CODES.AUTH_FAILED, 401))
            .with({ kind: 'locked' }, () => errorJson(c, ERROR_CODES.ACCOUNT_LOCKED, 403))
            .with({ kind: 'email-not-verified' }, () =>
              errorJson(c, ERROR_CODES.EMAIL_NOT_VERIFIED, 401)
            )
            .with({ kind: 'logged-in', requires2FA: true }, ({ user }) =>
              c.json({ requires2FA: true as const, userId: user.id }, 200)
            )
            .with({ kind: 'logged-in', requires2FA: false }, ({ user }) =>
              c.json(loginSuccessBody(user), 200)
            )
            .exhaustive();
        }
      )
      // pending-2fa class: the auth-flow surface — a mid-2FA session must be
      // able to log out. Repeating converges on the same end state (no active
      // session), hence naturally-idempotent: Redis DEL is the single
      // converging statement `idempotent.byUpsert` declares. The billing-portal
      // credential has no logout at all: this route sits outside its cookie
      // path and the authorizer refuses the kind here, so it expires on its TTL.
      .post(
        '/logout',
        routeClass('pending-2fa'),
        idempotencyExempt('naturally-idempotent'),
        async (c) => {
          const principal = c.var.principal;
          // link-guest, trial-session, admin-actor and billing-portal carry no
          // session claims (and the authorizer denies them this route anyway);
          // every other non-none kind holds a revocable one.
          if (
            principal.kind !== 'none' &&
            principal.kind !== 'link-guest' &&
            principal.kind !== 'trial-session' &&
            principal.kind !== 'admin-actor' &&
            principal.kind !== 'billing-portal'
          ) {
            const revoked = await runMutation(() =>
              idempotent.byUpsert(() =>
                revokeSession(c.var.redis, principal.claims, deps.evictUser(c.var.redis, c.env))
              )
            );
            if (revoked.isErr()) return respondDomainError(c, revoked.error);
          }
          await destroySessionCookie({
            request: c.req.raw,
            response: c.res,
            secret: c.var.bindings.IRON_SESSION_SECRET,
            isProduction: c.var.envUtils.isProduction,
          });
          return c.json({ success: true as const }, 200);
        }
      )
  );
}
