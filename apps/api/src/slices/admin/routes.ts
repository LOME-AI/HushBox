import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  ERROR_CODES,
  FEEDBACK_STATUSES,
  MAX_ADMIN_SQL_QUERY_LENGTH,
  NEWSLETTER_STATUSES,
  adminOpCatalogEntry,
} from '@hushbox/shared';
import {
  defineSliceManifest,
  rejectInvalid,
  respondDomainError,
  routeClass,
} from '../../middleware/pipeline-manifest.js';
import {
  IDEMPOTENCY_KEY_HEADER,
  createErrorResponse,
  idempotencyExempt,
  newsletterMarkdownSchema,
} from './domain/index.js';
import type { Context } from 'hono';
import type { Database } from '@hushbox/db';
import type {
  AdminOpExecuteResult,
  AdminOpReadResult,
  AdminRole,
  AdminOpPrefillResult,
  AdminOpPreviewResult,
  AdminOpsCatalog,
  AnyAdminOpContract,
} from '@hushbox/shared';
import type { AppEnv, Principal } from '../../middleware/pipeline-manifest.js';
import type {
  AdminOpEngine,
  AdminOpEngineDb,
  AdminOpPrefill,
  AdminOpReadRunResult,
  AdminOpRunResult,
  AdminReadSurface,
  Customer360Query,
  RunAdminOpParams,
  RunAdminReadParams,
  Telemetry,
} from './domain/index.js';

/** What the read-surface factory may see of the request environment. */
export interface AdminReadContext {
  readonly db: Database;
  /** The requesting actor's role, stamped on every read-audit row the surface writes. */
  readonly role: AdminRole;
  readonly telemetry: Telemetry;
  /** Raw bindings — the SQL panel's second connection string lives here and
   * the composition root owns its own fail-fast (like OPAQUE's secret). */
  readonly env: { readonly ADMIN_SQL_PANEL_DATABASE_URL?: string };
  readonly isDev: boolean;
}

export interface AdminRouteDeps {
  /**
   * Per-request engine over the pipeline's `c.var.db` + logger. The
   * composition root constructs it WITHOUT engine hooks: `afterAudit` is a
   * test-only seam and must be unreachable in production wiring.
   */
  readonly engine: (db: AdminOpEngineDb, telemetry: Telemetry) => AdminOpEngine;
  /** The registry's contract catalog (the `GET /ops` read surface). */
  readonly listOps: () => readonly AnyAdminOpContract[];
  /**
   * Resolve an op's current-state form prefill over the pipeline's
   * `c.var.db`; `null` when the op is unknown OR registers no resolver —
   * indistinguishable by design (no catalog advertisement exists; the SPA
   * probes blindly and treats any failure as "open blank"). The composition
   * root runs the registered resolver with the same composed deps the op
   * bodies receive. Payloads are wire-JSON input values, never `reason`.
   */
  readonly prefill: (db: Database, name: string) => AdminOpPrefill | null;
  /** Per-request bespoke read surface (360, dashboard, jobs, audit, SQL). */
  readonly reads: (context: AdminReadContext) => AdminReadSurface;
}

/**
 * The op input rides an `input` envelope (never spread into the body root)
 * so route-level fields — `undoes`, future envelope fields — can never
 * collide with an op's own flat input keys. The envelope stays `unknown`-
 * valued: the CONTRACT schema is the validator, applied by the engine.
 */
const opBodySchema = z.object({
  input: z.record(z.string(), z.unknown()),
  /** The audit row id being undone when this run is an undo. Preview takes it
   * too, so the undo target is validated on the same code path as execute. */
  undoes: z.uuid().optional(),
});

/**
 * The engine seam the idempotency arch check requires lexically in every
 * `admin-engine`-exempted terminal handler: all op traffic — preview and
 * execute — flows through the engine's own key-row machinery (claim /
 * replay / fenced flips), never `runMutation`/`idempotent.*` at the route.
 */
function runAdminOp(
  engine: AdminOpEngine,
  params: RunAdminOpParams
): ReturnType<AdminOpEngine['run']> {
  return engine.run(params);
}

/**
 * The read half of that seam. It claims no key row and opens no transaction,
 * because a read lands nothing an idempotency key could dedup — what it does
 * write, the read-audit row, is meant to show every request, and the same rule
 * already governs the preview route's row.
 */
function readAdminOp(
  engine: AdminOpEngine,
  params: RunAdminReadParams
): ReturnType<AdminOpEngine['read']> {
  return engine.read(params);
}

/**
 * Which path a name takes, read off the contract the registry published. The
 * two kinds share one route because they share one surface: a caller runs an
 * operation, and whether that operation changes anything is the contract's
 * fact, never the caller's.
 */
function contractKindOf(
  contracts: readonly AnyAdminOpContract[],
  name: string
): AnyAdminOpContract['kind'] | undefined {
  return contracts.find((contract) => contract.name === name)?.kind;
}

/** The authorizer admits only the admin-actor kind to `admin`-classed
 * routes, so any other kind here is a pipeline defect, not a client error. */
function adminActor(principal: Principal): { readonly email: string; readonly role: AdminRole } {
  if (principal.kind !== 'admin-actor') {
    throw new Error('admin routes: handler reached without an admin-actor principal');
  }
  return { email: principal.email, role: principal.role };
}

function adminActorEmail(principal: Principal): string {
  return adminActor(principal).email;
}

/**
 * The op routes' response bodies. Each builder is annotated with the shared
 * wire schema's inferred type, so a field rename in
 * `packages/shared/src/admin/wire.ts` is a compile error here rather than a
 * parse failure in the admin SPA.
 *
 * The catalog is filtered to what the caller's role may see, which keeps the
 * SPA's op list and its command palette role-correct without either surface
 * deciding anything; the engine refuses a hidden op regardless, so the filter
 * is presentation and never the gate.
 */
function opsCatalogResponse(
  contracts: readonly AnyAdminOpContract[],
  role: AdminRole
): AdminOpsCatalog {
  return {
    ops: contracts
      .filter((contract) => contract.allowedRoles.includes(role))
      .map((contract) => adminOpCatalogEntry(contract)),
    role,
  };
}

/** The op audit row a preview writes rolls back with its transaction, so its
 * id must not leak. */
function previewResponse(run: AdminOpRunResult): AdminOpPreviewResult {
  return { effects: run.effects, inverseInput: run.inverseInput };
}

function executeResponse(run: AdminOpRunResult): AdminOpExecuteResult {
  return {
    auditId: run.auditId,
    effects: run.effects,
    inverseInput: run.inverseInput,
  };
}

/** A read run's body: its read-audit row id and the read's own payload. Field
 * by field, so a rename in the shared wire schema fails to compile here. */
function readExecuteResponse(run: AdminOpReadRunResult): AdminOpReadResult {
  return { kind: run.kind, auditId: run.auditId, data: run.data };
}

function prefillResponse(input: Record<string, unknown>): AdminOpPrefillResult {
  return { input };
}

/** One lookup key: `email` wins when both arrive (zod strips the loser),
 * neither refuses — the union's output IS the domain's `Customer360Query`. */
const overviewQuerySchema = z.union([
  z.object({ email: z.email() }),
  z.object({ userId: z.uuid() }),
]);

const auditQuerySchema = z.object({
  actor: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  targetType: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});

const jobsQuerySchema = z.object({
  status: z.enum(['pending', 'running', 'succeeded', 'cancelled', 'dead', 'discarded']).optional(),
  type: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});

const feedbackQuerySchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const feedbackDetailParameterSchema = z.object({ id: z.uuid() });

const newsletterIssuesQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const newsletterRenderBodySchema = z.object({
  subject: z.string().trim().min(1),
  bodyMarkdown: newsletterMarkdownSchema.min(1),
});

const newsletterSubscribersQuerySchema = z.object({
  status: z.enum(NEWSLETTER_STATUSES).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const sqlQuerySchema = z.object({
  query: z.string().min(1).max(MAX_ADMIN_SQL_QUERY_LENGTH),
});

/** The read-surface factory's view of the request (never raw `c` deeper in). */
function readContextOf(c: Context<AppEnv>): AdminReadContext {
  return {
    db: c.var.db,
    role: adminActor(c.var.principal).role,
    telemetry: c.var.logger,
    env: c.env,
    isDev: c.var.envUtils.isDev,
  };
}

/**
 * The admin plane's HTTP surface: the generic ops routes over the audited
 * engine (one definition, many surfaces — Charter #8; the admin SPA hits
 * exactly these). Every route is `admin`-classed: only the `admin-actor`
 * principal minted by the verified Access assertion passes. The mutating
 * routes are `admin-engine`-exempt from the Idempotency-Key stage: the
 * engine itself claims/replays/fences on the key row and REJECTS an execute
 * without a client key. A preview has nothing for such a key to dedup: its
 * transaction always rolls back, and the read-audit row it writes outside
 * that transaction is deliberately not deduped — a repeated preview is a
 * repeated read, and the trail is meant to show each one.
 *
 * The return type is deliberately inferred: annotating it with a bare
 * `Hono<AppEnv>` widens the routes to `BlankSchema` and erases the route
 * schema from `AppType` (the typed client goes blind to this slice).
 */
export function createAdminManifest(deps: AdminRouteDeps) {
  return defineSliceManifest({
    basePath: '/admin',
    routes: new Hono<AppEnv>()
      .get('/ops', routeClass('admin'), (c) =>
        c.json(opsCatalogResponse(deps.listOps(), adminActor(c.var.principal).role), 200)
      )
      // Read-only and unaudited on purpose: it returns admin-authored config
      // (what the op's own preview would show), never customer metadata.
      .get('/ops/:name/prefill', routeClass('admin'), async (c) => {
        const pending = deps.prefill(c.var.db, c.req.param('name'));
        if (pending === null) {
          return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
        }
        const result = await pending;
        return result.match(
          (input) => c.json(prefillResponse(input), 200),
          (error) => respondDomainError(c, error)
        );
      })
      .post(
        '/ops/:name/preview',
        routeClass('admin'),
        idempotencyExempt('admin-engine'),
        zValidator('json', opBodySchema, rejectInvalid),
        async (c) => {
          const { input, undoes } = c.req.valid('json');
          const result = await runAdminOp(deps.engine(c.var.db, c.var.logger), {
            name: c.req.param('name'),
            input,
            actor: adminActor(c.var.principal).email,
            role: adminActor(c.var.principal).role,
            mode: 'preview',
            ...(undoes === undefined ? {} : { undoes }),
          });
          return result.match(
            (run) => c.json(previewResponse(run), 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .post(
        '/ops/:name/execute',
        routeClass('admin'),
        idempotencyExempt('admin-engine'),
        zValidator('json', opBodySchema, rejectInvalid),
        async (c) => {
          const { input, undoes } = c.req.valid('json');
          const name = c.req.param('name');
          const { email, role } = adminActor(c.var.principal);
          if (contractKindOf(deps.listOps(), name) === 'read') {
            const read = await readAdminOp(deps.engine(c.var.db, c.var.logger), {
              name,
              input,
              actor: email,
              role,
            });
            return read.match(
              (run) => c.json(readExecuteResponse(run), 200),
              (error) => respondDomainError(c, error)
            );
          }
          const idempotencyKey = c.req.header(IDEMPOTENCY_KEY_HEADER);
          const result = await runAdminOp(deps.engine(c.var.db, c.var.logger), {
            name,
            input,
            actor: email,
            role,
            mode: 'execute',
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
            ...(undoes === undefined ? {} : { undoes }),
          });
          return result.match(
            (run) => c.json(executeResponse(run), 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get(
        '/users/overview',
        routeClass('admin'),
        zValidator('query', overviewQuerySchema, rejectInvalid),
        async (c) => {
          const query: Customer360Query = c.req.valid('query');
          const result = await deps.reads(readContextOf(c)).customer360({
            actor: adminActorEmail(c.var.principal),
            query,
          });
          return result.match(
            (view) => c.json(view, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get('/dashboard', routeClass('admin'), async (c) => {
        const result = await deps.reads(readContextOf(c)).dashboard({
          actor: adminActorEmail(c.var.principal),
        });
        return result.match(
          (view) => c.json(view, 200),
          (error) => respondDomainError(c, error)
        );
      })
      .get(
        '/jobs',
        routeClass('admin'),
        zValidator('query', jobsQuerySchema, rejectInvalid),
        async (c) => {
          const { status, type, limit, cursor } = c.req.valid('query');
          const result = await deps.reads(readContextOf(c)).jobQueue({
            actor: adminActorEmail(c.var.principal),
            limit,
            ...(status === undefined ? {} : { status }),
            ...(type === undefined ? {} : { type }),
            ...(cursor === undefined ? {} : { cursor }),
          });
          return result.match(
            (page) => c.json(page, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // The feedback triage surface: a keyset inbox page and an audited detail
      // read, both composing the feedback slice's published barrel (this slice
      // never touches the `feedback` table). The read-volume cap is declared on
      // both paths in this slice's posture fragment, like the other sensitive
      // reads.
      .get(
        '/feedback',
        routeClass('admin'),
        zValidator('query', feedbackQuerySchema, rejectInvalid),
        async (c) => {
          const { status, cursor, limit } = c.req.valid('query');
          const result = await deps.reads(readContextOf(c)).feedbackInbox({
            limit,
            ...(status === undefined ? {} : { status }),
            ...(cursor === undefined ? {} : { cursor }),
          });
          return result.match(
            (page) => c.json(page, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get(
        '/feedback/:id',
        routeClass('admin'),
        zValidator('param', feedbackDetailParameterSchema, rejectInvalid),
        async (c) => {
          const result = await deps.reads(readContextOf(c)).feedbackDetail({
            actor: adminActorEmail(c.var.principal),
            id: c.req.valid('param').id,
          });
          return result.match(
            (detail) => c.json(detail, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // Newsletter issues table: admin-authored content over the newsletter
      // slice's published keyset read — unaudited like the feedback inbox
      // (nothing customer-derived); the query schema caps the page size.
      .get(
        '/newsletter/issues',
        routeClass('admin'),
        zValidator('query', newsletterIssuesQuerySchema, rejectInvalid),
        async (c) => {
          const { cursor, limit } = c.req.valid('query');
          const result = await deps.reads(readContextOf(c)).newsletterIssues({
            limit,
            ...(cursor === undefined ? {} : { cursor }),
          });
          return result.match(
            (page) => c.json(page, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // Compose-screen preview: renders the exact issue template the
      // dispatch job sends, its unsubscribe link carrying a token no
      // subscriber holds — never a live subscriber's URL.
      // A POST for body size, but a pure read (SELECT-only read surface, no
      // write): the `read-over-post` exemption states that posture explicitly
      // instead of leaning on the universal Idempotency-Key demand.
      .post(
        '/newsletter/render',
        routeClass('admin'),
        idempotencyExempt('read-over-post'),
        zValidator('json', newsletterRenderBodySchema, rejectInvalid),
        async (c) => {
          const result = await deps.reads(readContextOf(c)).renderIssue(c.req.valid('json'));
          return result.match(
            (rendered) => c.json(rendered, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // Aggregate subscriber counts — no per-person data, so unaudited. The
      // per-row consent-evidence list below is the audited, volume-capped one
      // (its rate-limit posture is declared in this slice's fragment with the
      // other sensitive reads).
      .get('/newsletter/subscribers/stats', routeClass('admin'), async (c) => {
        const result = await deps.reads(readContextOf(c)).newsletterSubscriberStats();
        return result.match(
          (stats) => c.json(stats, 200),
          (error) => respondDomainError(c, error)
        );
      })
      .get(
        '/newsletter/subscribers',
        routeClass('admin'),
        zValidator('query', newsletterSubscribersQuerySchema, rejectInvalid),
        async (c) => {
          const { status, cursor, limit } = c.req.valid('query');
          const result = await deps.reads(readContextOf(c)).newsletterSubscribers({
            actor: adminActorEmail(c.var.principal),
            limit,
            ...(status === undefined ? {} : { status }),
            ...(cursor === undefined ? {} : { cursor }),
          });
          return result.match(
            (page) => c.json(page, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // Catalog data, not customer metadata — outside the audited read set
      // and not actor-rate-limited (the slice's rate-limit fragment is what
      // names the reads that are). Single capped page, no cursor: the catalog
      // is small-by-design (see ADMIN_CATALOG_MODEL_CAP).
      .get('/models', routeClass('admin'), async (c) => {
        const result = await deps.reads(readContextOf(c)).modelsCatalog();
        return result.match(
          (page) => c.json(page, 200),
          (error) => respondDomainError(c, error)
        );
      })
      .get(
        '/audit',
        routeClass('admin'),
        zValidator('query', auditQuerySchema, rejectInvalid),
        async (c) => {
          const { actor, action, targetType, targetId, from, to, limit, cursor } =
            c.req.valid('query');
          const result = await deps.reads(readContextOf(c)).auditSearch({
            limit,
            ...(actor === undefined ? {} : { actor }),
            ...(action === undefined ? {} : { action }),
            ...(targetType === undefined ? {} : { targetType }),
            ...(targetId === undefined ? {} : { targetId }),
            ...(cursor === undefined ? {} : { cursor }),
            ...(from === undefined ? {} : { from: new Date(from) }),
            ...(to === undefined ? {} : { to: new Date(to) }),
          });
          return result.match(
            (page) => c.json(page, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // A GET: the panel is a read. Nothing about idempotency forces the
      // method — the `read-over-post` exemption class takes this handler's
      // `deps.reads(...)` call as its architecture-rule evidence, which is how
      // `/newsletter/render` in this file posts a read.
      .get(
        '/sql',
        routeClass('admin'),
        zValidator('query', sqlQuerySchema, rejectInvalid),
        async (c) => {
          const result = await deps.reads(readContextOf(c)).sqlPanel({
            actor: adminActorEmail(c.var.principal),
            query: c.req.valid('query').query,
          });
          return result.match(
            (page) => c.json(page, 200),
            (error) => respondDomainError(c, error)
          );
        }
      ),
  });
}
