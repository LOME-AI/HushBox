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
  createRecoveryResetFinishFlow,
  getRecoveryWrappedKey,
  idempotencyExempt,
  idempotent,
  recoveryGetKeyBodySchema,
  recoveryResetFinishBodySchema,
  recoveryResetInitBodySchema,
  resolveTrustedCallerIpId,
  runMutation,
  startRecoveryReset,
} from '../domain/index.js';
import { rateLimitedResponse, errorJson, rotationRefused } from './refusals.js';
import { opaqueDeps, freshHandshake } from './handler-support.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { IdentityRouteDeps } from './deps.js';

export function recoveryResetRoutes(deps: IdentityRouteDeps) {
  return (
    new Hono<AppEnv>()
      // Recovery (public, enumeration-safe): get-wrapped-key returns the stored
      // recovery blob or a same-shape dummy; reset re-registers via the phrase
      // the client holds. Both are the `opaque-protocol` recovery family.
      .post(
        '/recovery/get-wrapped-key',
        routeClass('public'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', recoveryGetKeyBodySchema, rejectInvalid),
        async (c) => {
          // The trusted resolver, never the sentinel one: a request the edge
          // left no address on must refuse rather than join one window every
          // caller behind that fault would share.
          const callerNetworkId = await resolveTrustedCallerIpId(
            (name) => c.req.header(name),
            c.var.envUtils
          );
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                getRecoveryWrappedKey({
                  ...opaqueDeps(c, deps),
                  identifier: c.req.valid('json').identifier,
                  callerNetworkId,
                })
              )
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'rate-limited' }, (o) => rateLimitedResponse(c, o.retryAfterSeconds))
            .with({ kind: 'ok' }, (o) =>
              c.json({ recoveryWrappedPrivateKey: o.recoveryWrappedPrivateKey }, 200)
            )
            .exhaustive();
        }
      )
      .post(
        '/recovery/reset/init',
        routeClass('public'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', recoveryResetInitBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const callerNetworkId = await resolveTrustedCallerIpId(
            (name) => c.req.header(name),
            c.var.envUtils
          );
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                startRecoveryReset({
                  ...opaqueDeps(c, deps),
                  identifier: body.identifier,
                  newRegistrationRequest: body.newRegistrationRequest,
                  callerNetworkId,
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
                  newRegistrationResponse: o.newRegistrationResponse,
                  recoverySessionId: o.recoverySessionId,
                  sealedChallenge: o.sealedChallenge,
                },
                200
              )
            )
            .exhaustive();
        }
      )
      .post(
        '/recovery/reset/finish',
        routeClass('public'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', recoveryResetFinishBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const flow = createRecoveryResetFinishFlow({
            ...opaqueDeps(c, deps),
            emailPort: deps.passwordResetEmailPort,
            logger: c.var.logger,
            identifier: body.identifier,
            newRegistrationRecord: body.newRegistrationRecord,
            newPasswordWrappedPrivateKey: body.newPasswordWrappedPrivateKey,
            recoverySessionId: body.recoverySessionId,
            resetProof: body.resetProof,
            now: Date.now(),
            evictUser: deps.evictUser(c.var.redis, c.env),
          });
          const result = await runMutation(() => idempotent.byEventId(flow));
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'no-pending' }, () => errorJson(c, ERROR_CODES.NO_PENDING_RECOVERY, 400))
            .with({ kind: P.union('kek-rotated', 'credential-conflict') }, (o) =>
              rotationRefused(c, o)
            )
            .with({ kind: 'reset' }, () => c.json({ success: true as const }, 200))
            .exhaustive();
        }
      )
  );
}
