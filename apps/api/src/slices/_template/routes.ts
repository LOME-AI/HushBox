import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  defineSliceManifest,
  rejectInvalid,
  respondDomainError,
  respondOk,
  routeClass,
} from '../../middleware/pipeline-manifest.js';
import {
  buildGreeting,
  callerUserId,
  idempotencyExempt,
  idempotent,
  putNoteBodySchema,
  runMutation,
  saveNote,
} from './domain/index.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { TemplateDeps } from './domain/index.js';

/**
 * Manifest factory: dependencies arrive from the composition root (the
 * `app.ts` assembly), so routes never import adapters themselves. Every
 * route declares its class via `routeClass` as its first handler — the
 * pipeline default-denies any route that reaches it undeclared.
 *
 * `PUT /note` is the mutation exemplar, and every part of it is enforced
 * rather than stylistic: `zValidator` with the shared `rejectInvalid` hook
 * (so malformed input answers the uniform `{code}` body at 400 instead of a
 * `ZodError` dump), an idempotency classification the arch rules read
 * structurally, a `Result`-returning domain function, and `respondDomainError`
 * for the failure arm. Copy the shape; do not re-derive it.
 *
 * The classification here is `naturally-idempotent` because the write is one
 * upsert converging on a single row per user. A mutation that is NOT naturally
 * idempotent (it would file a second row on a repeat) takes no exemption: it
 * requires the `Idempotency-Key` header and wraps in `idempotent.byKey`. The
 * five wrappers are the only entry to `runMutation`.
 *
 * The return type is deliberately inferred: annotating it with a bare
 * `Hono<AppEnv>` widens the routes to `BlankSchema` and erases the route
 * schema from `AppType` (the typed client goes blind to this slice).
 */
export function createTemplateManifest(deps: TemplateDeps) {
  return defineSliceManifest({
    basePath: '/template',
    routes: new Hono<AppEnv>()
      .get('/greeting', routeClass('public'), (c) => {
        return c.json({ greeting: buildGreeting(deps.clock) });
      })
      .put(
        '/note',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', putNoteBodySchema, rejectInvalid),
        async (c) => {
          const { text } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              saveNote(deps.notes(c.var.db), callerUserId(c.var.principal), text)
            )
          );
          return result.match(
            (note) => respondOk(c, note),
            (error) => respondDomainError(c, error)
          );
        }
      ),
  });
}
