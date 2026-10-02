import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { match } from 'ts-pattern';
import { ERROR_CODES } from '@hushbox/shared';
import {
  rejectInvalid,
  respondDomainError,
  routeClass,
} from '../../../middleware/pipeline-manifest.js';
import {
  billingTokenLogin,
  billingTokenLoginBodySchema,
  idempotencyExempt,
  idempotent,
  resendVerification,
  resendVerificationBodySchema,
  runMutation,
  verifyEmailBodySchema,
  verifyEmailToken,
} from '../domain/index.js';
import { rateLimitedResponse, errorJson } from './refusals.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { IdentityRouteDeps } from './deps.js';

export function emailTokenRoutes(deps: IdentityRouteDeps) {
  return (
    new Hono<AppEnv>()
      // Billing-portal token login (public, mobile → web handoff). The token
      // IS the idempotency key: redemption converges on one deterministic
      // billing-portal credential, so the convergent write is `byUpsert`-shaped.
      // Unknown, expired, and orphaned tokens answer one uniform 401.
      //
      // Rate limited per IP by `tokenLoginIpRateLimit`, declared against this
      // route key in the slice's posture fragment: the token is the
      // credential, so an unlimited
      // redemption endpoint is an enumeration surface however narrow the
      // window. This route's `token-is-key` idempotency exemption buys nothing
      // here — it is an exemption from a different law.
      .post(
        '/token-login',
        routeClass('public'),
        idempotencyExempt('token-is-key'),
        zValidator('json', billingTokenLoginBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              billingTokenLogin({
                redis: c.var.redis,
                store: deps.stores(c.var.db).users,
                token: c.req.valid('json').token,
                request: c.req.raw,
                response: c.res,
                secret: c.var.bindings.IRON_SESSION_SECRET,
                isProduction: c.var.envUtils.isProduction,
                now: Date.now(),
              })
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'invalid' }, () => errorJson(c, ERROR_CODES.LOGIN_TOKEN_INVALID, 401))
            .with({ kind: 'logged-in' }, () => c.json({ success: true as const }, 200))
            .exhaustive();
        }
      )
      // Email verification (public). The token IS the idempotency key.
      .post(
        '/verify-email',
        routeClass('public'),
        idempotencyExempt('token-is-key'),
        zValidator('json', verifyEmailBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              verifyEmailToken({
                redis: c.var.redis,
                store: deps.stores(c.var.db).verification,
                token: c.req.valid('json').token,
                now: new Date(),
              })
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'rate-limited' }, (o) => rateLimitedResponse(c, o.retryAfterSeconds))
            .with({ kind: 'verified' }, () => c.json({ success: true as const }, 200))
            .with({ kind: 'invalid' }, () =>
              errorJson(c, ERROR_CODES.INVALID_VERIFICATION_TOKEN, 400)
            )
            .exhaustive();
        }
      )
      .post(
        '/verify-email/resend',
        routeClass('public'),
        idempotencyExempt('token-is-key'),
        zValidator('json', resendVerificationBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              resendVerification({
                redis: c.var.redis,
                store: deps.stores(c.var.db).verification,
                emailPort: deps.emailPort,
                email: c.req.valid('json').email,
                now: Date.now(),
              })
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return (
            match(result.value)
              .with({ kind: 'rate-limited' }, (o) => rateLimitedResponse(c, o.retryAfterSeconds))
              // Enumeration-safe: a known and an unknown address answer identically.
              .with({ kind: 'ok' }, () => c.json({ success: true as const }, 200))
              .exhaustive()
          );
        }
      )
      // Dev-only escape hatch: the email mock is instance-per-call, so local
      // signup is otherwise uncompletable. `dev-only` 404s in production.
      .get(
        '/verify-email/dev-link',
        routeClass('dev-only'),
        zValidator('query', z.object({ email: z.email() }), rejectInvalid),
        async (c) => {
          const token = await deps
            .stores(c.var.db)
            .verification.findLatestVerificationToken(
              c.req.valid('query').email.toLowerCase(),
              new Date()
            );
          if (token.isErr()) return respondDomainError(c, token.error);
          return c.json({ token: token.value }, 200);
        }
      )
  );
}
