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
  createRegisterFinishFlow,
  idempotencyExempt,
  idempotent,
  registerFinishBodySchema,
  registerInitBodySchema,
  resolveClientIp,
  runMutation,
  startRegistration,
} from '../domain/index.js';
import { rateLimitedResponse, errorJson } from './refusals.js';
import { opaqueDeps, listActiveTags, freshHandshake } from './handler-support.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { IdentityRouteDeps } from './deps.js';

export function registrationRoutes(deps: IdentityRouteDeps) {
  return new Hono<AppEnv>()
    .post(
      '/register/init',
      routeClass('public'),
      idempotencyExempt('opaque-protocol'),
      zValidator('json', registerInitBodySchema, rejectInvalid),
      async (c) => {
        const body = c.req.valid('json');
        const address = resolveClientIp((name) => c.req.header(name), c.var.envUtils);
        const result = await runMutation(() =>
          idempotent.byEventId(
            freshHandshake(() =>
              startRegistration({
                ...opaqueDeps(c, deps),
                email: body.email,
                username: body.username,
                registrationRequest: body.registrationRequest,
                now: Date.now(),
                growth: {
                  campaignTag: body.c,
                  address,
                  secret: c.env.GROWTH_HASH_SECRET,
                  listActiveTags: listActiveTags(c, deps),
                },
                logger: c.var.logger,
              })
            )
          )
        );
        if (result.isErr()) return respondDomainError(c, result.error);
        return match(result.value)
          .with({ kind: 'rate-limited' }, (o) => rateLimitedResponse(c, o.retryAfterSeconds))
          .with({ kind: 'started' }, (o) =>
            c.json(
              {
                registrationResponse: o.registrationResponse,
                registerSessionId: o.registerSessionId,
              },
              200
            )
          )
          .exhaustive();
      }
    )
    .post(
      '/register/finish',
      routeClass('public'),
      idempotencyExempt('opaque-protocol'),
      zValidator('json', registerFinishBodySchema, rejectInvalid),
      async (c) => {
        const flow = createRegisterFinishFlow({
          ...opaqueDeps(c, deps),
          db: c.var.db,
          billingStores: deps.billingStores,
          verificationStore: deps.stores(c.var.db).verification,
          welcomeEmail: deps.welcomeEmailPort,
          verificationEmail: deps.emailPort,
          now: Date.now(),
          listActiveTags: listActiveTags(c, deps),
          logger: c.var.logger,
          ...c.req.valid('json'),
        });
        const outcome = await runMutation(() => idempotent.byEventId(flow));
        if (outcome.isErr()) return respondDomainError(c, outcome.error);
        return match(outcome.value)
          .with({ kind: 'no-pending' }, () =>
            errorJson(c, ERROR_CODES.NO_PENDING_REGISTRATION, 400)
          )
          .with({ kind: 'existing' }, () =>
            // Enumeration safety: identical success shape with a throwaway
            // id when the email is already registered.
            c.json({ success: true as const, userId: crypto.randomUUID() }, 201)
          )
          .with({ kind: 'created' }, (o) =>
            c.json({ success: true as const, userId: o.userId }, 201)
          )
          .with({ kind: 'kek-rotated' }, () => errorJson(c, ERROR_CODES.OPAQUE_KEK_ROTATED, 409))
          .with({ kind: 'email-taken' }, () => errorJson(c, ERROR_CODES.EMAIL_TAKEN, 409))
          .with({ kind: 'username-taken' }, () => errorJson(c, ERROR_CODES.USERNAME_TAKEN, 409))
          .exhaustive();
      }
    );
}
