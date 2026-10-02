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
  createRecoverySaveFinishFlow,
  idempotencyExempt,
  idempotent,
  recoverySaveFinishBodySchema,
  recoverySaveInitBodySchema,
  runMutation,
  startRecoverySave,
} from '../domain/index.js';
import { errorJson, stepUpInitRefusal } from './refusals.js';
import { fullClaims, opaqueDeps, freshHandshake } from './handler-support.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { IdentityRouteDeps } from './deps.js';

export function recoverySaveRoutes(deps: IdentityRouteDeps) {
  return (
    new Hono<AppEnv>()
      // Recovery-phrase acknowledgement: persists the client's recovery-wrapped
      // key and flips hasAcknowledgedPhrase, behind an OPAQUE step-up. A session
      // alone cannot replace the recovery keypair — the new phrase is a
      // permanent path back into the account, so the write is priced at the
      // password. The material rides the finish round because that is the call
      // the proof gates.
      .post(
        '/recovery/save/init',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', recoverySaveInitBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshHandshake(() =>
                startRecoverySave({
                  ...opaqueDeps(c, deps),
                  userId: fullClaims(c).userId,
                  ke1: body.ke1,
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
              c.json({ ke2: o.ke2, recoverySaveSessionId: o.recoverySaveSessionId }, 200)
            )
            .exhaustive();
        }
      )
      .post(
        '/recovery/save/finish',
        routeClass('session'),
        idempotencyExempt('opaque-protocol'),
        zValidator('json', recoverySaveFinishBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const flow = createRecoverySaveFinishFlow({
            ...opaqueDeps(c, deps),
            userId: fullClaims(c).userId,
            ke3: body.ke3,
            recoverySaveSessionId: body.recoverySaveSessionId,
            recoveryWrappedPrivateKey: body.recoveryWrappedPrivateKey,
            recoveryPublicKey: body.recoveryPublicKey,
          });
          const result = await runMutation(() => idempotent.byEventId(flow));
          if (result.isErr()) return respondDomainError(c, result.error);
          return match(result.value)
            .with({ kind: 'no-step-up' }, () => errorJson(c, ERROR_CODES.NO_PENDING_STEP_UP, 400))
            .with({ kind: 'bad-proof' }, () => errorJson(c, ERROR_CODES.AUTH_FAILED, 401))
            .with({ kind: 'verified' }, () => c.json({ success: true as const }, 200))
            .exhaustive();
        }
      )
  );
}
