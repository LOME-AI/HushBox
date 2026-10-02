import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { selfReportActionSchema } from '@hushbox/shared';
import {
  rejectInvalid,
  respondDomainError,
  routeClass,
} from '../../../middleware/pipeline-manifest.js';
import {
  applySelfReport,
  idempotencyExempt,
  idempotent,
  readAcquisitionSource,
  resolveMe,
  runMutation,
} from '../domain/index.js';
import { fullClaims } from './handler-support.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { IdentityRouteDeps } from './deps.js';

export function accountProfileRoutes(deps: IdentityRouteDeps) {
  return (
    new Hono<AppEnv>()
      // Where this account came from, as the account holder tells it. The
      // question is a closed set with no free-text field anywhere, because the
      // answers are read through a database role by a model that holds write
      // tools elsewhere, and no scrub separates an instruction from a genuine
      // answer.
      .get('/account/acquisition-source', routeClass('session'), async (c) => {
        const result = await readAcquisitionSource({
          store: deps.stores(c.var.db).users,
          db: c.var.db,
          userId: fullClaims(c).userId,
        });
        if (result.isErr()) return respondDomainError(c, result.error);
        return c.json(result.value, 200);
      })
      // One verb per call, both convergent: the answer is guarded on there
      // being none yet, and the skip moves forward through the two ordered
      // contexts and never back. The server owns the whole predicate — the
      // client renders what this says is due and records nothing on the device,
      // so a skip on one device holds on every other.
      .patch(
        '/account/acquisition-source',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', selfReportActionSchema, rejectInvalid),
        async (c) => {
          const action = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              applySelfReport(
                {
                  store: deps.stores(c.var.db).users,
                  db: c.var.db,
                  userId: fullClaims(c).userId,
                },
                action,
                new Date()
              )
            )
          );
          return result.match(
            (view) => c.json(view, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // Bootstrap read: identity owns the profile + crypto-key fields. The
      // pipeline downgrades a revoked session before authorization, so no
      // explicit sessionActive recheck is needed (an intentional deviation from
      // legacy). customInstructionsEncrypted is the account slice's; the client
      // fetches it from /account/instructions separately (single-writer).
      .get('/me', routeClass('session'), async (c) => {
        const result = await resolveMe(deps.stores(c.var.db).users, fullClaims(c).userId);
        if (result.isErr()) return respondDomainError(c, result.error);
        return c.json(result.value, 200);
      })
  );
}
