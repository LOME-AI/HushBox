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
  changePasswordFinishBodySchema,
  changePasswordInitBodySchema,
  createPasswordChangeFinishFlow,
  idempotencyExempt,
  idempotent,
  runMutation,
  startPasswordChange,
} from '../domain/index.js';
import { errorJson, stepUpInitRefusal, rotationRefused } from './refusals.js';
import { fullClaims, opaqueDeps, freshHandshake } from './handler-support.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { IdentityRouteDeps } from './deps.js';

export function passwordChangeRoutes(deps: IdentityRouteDeps) {
  return (
    new Hono<AppEnv>()
      // Password change: step-up (old password) + a new OPAQUE registration;
      // the finish stamps the pw-changed watermark, staling prior sessions.
      .post(
        '/change-password/init',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', changePasswordInitBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                startPasswordChange({
                  ...opaqueDeps(c, deps),
                  userId: fullClaims(c).userId,
                  ke1: body.ke1,
                  newRegistrationRequest: body.newRegistrationRequest,
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
              c.json(
                {
                  ke2: o.ke2,
                  newRegistrationResponse: o.newRegistrationResponse,
                  changePasswordSessionId: o.changePasswordSessionId,
                },
                200
              )
            )
            .exhaustive();
        }
      )
      .post(
        '/change-password/finish',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', changePasswordFinishBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const flow = createPasswordChangeFinishFlow({
            ...opaqueDeps(c, deps),
            emailPort: deps.passwordChangedEmailPort,
            logger: c.var.logger,
            userId: fullClaims(c).userId,
            ke3: body.ke3,
            changePasswordSessionId: body.changePasswordSessionId,
            newRegistrationRecord: body.newRegistrationRecord,
            newPasswordWrappedPrivateKey: body.newPasswordWrappedPrivateKey,
            now: Date.now(),
            evictUser: deps.evictUser(c.var.redis, c.env),
          });
          const result = await runMutation(() => idempotent.byEventId(flow));
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'no-step-up' }, () => errorJson(c, ERROR_CODES.NO_PENDING_STEP_UP, 400))
            .with({ kind: 'bad-proof' }, () => errorJson(c, ERROR_CODES.AUTH_FAILED, 401))
            .with({ kind: 'verified' }, ({ value }) =>
              match(value)
                .with({ kind: P.union('kek-rotated', 'credential-conflict') }, (o) =>
                  rotationRefused(c, o)
                )
                .with({ kind: 'rotated' }, () => c.json({ success: true as const }, 200))
                .exhaustive()
            )
            .exhaustive();
        }
      )
  );
}
