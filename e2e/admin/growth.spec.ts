import { ERROR_CODES, adminOpsCatalogSchema } from '@hushbox/shared';
import { test as base, expect } from './fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
// The plane's primary authorization control, read here rather than re-listed:
// the sweep below probes every route this map closes to the read-only role, so
// a route added to the map joins the sweep without anyone remembering to add
// it. A list spelled here instead would have to agree with the map to be
// correct, which is the shape `docs/CODE-RULES.md` §One Implementation, Shared
// refuses. Nothing in this import reaches past the literal — its own imports
// are types.
import { ADMIN_ROUTE_ROLES } from '../../apps/api/src/composition/admin-route-roles.js';
import { GROWTH_ACTORS, mintGrowthAdminContext } from '../helpers/growth-admin.js';
import { idempotentPost } from '../helpers/idempotent-request.js';
import { executeOpApi } from './helpers/op-modal.js';
import type { AdminRole } from '@hushbox/shared';
import type { APIRequestContext } from './fixtures.js';

const SPEC_MATRIX = matrix({ engine: 'engine-fixed', formFactor: 'desktop' });

/** The read-only role the Growth screen is built for. */
const GROWTH_VIEWER: AdminRole = 'growth-viewer';

/** The one growth mutation, and the cheapest growth read (it takes no window). */
const CAMPAIGN_MINT = 'growth.campaign.create';
const CAMPAIGN_READ = 'growth.campaigns.read';

/** The reason every admin operation records; the contract requires one. */
const REASON = 'e2e admin growth authorization';

/**
 * The route map as the pipeline reads it — keys `$<method> <path>`, values the
 * roles admitted. Annotated rather than asserted: the literal's per-entry role
 * tuples are narrower than the map shape, and a declaration widens them where
 * a cast would only silence the compiler.
 */
const ROUTE_ROLES: Readonly<Record<string, readonly AdminRole[]>> = ADMIN_ROUTE_ROLES;

/**
 * The segment a path parameter is probed with. The role refusal is a pipeline
 * stage that runs before any handler, validator, rate-limit counter or
 * idempotency check (`apps/api/src/middleware/pipeline.ts` states the order),
 * so what this segment says reaches nothing that reads it — it only has to
 * match the registration, which routes on segment count rather than shape.
 */
const PROBE_SEGMENT = 'refusal-probe';

/** The response type, derived from the context's own signature so no spec-banned
 * `@playwright/test` import is needed to name it. */
type ProbeResponse = Awaited<ReturnType<APIRequestContext['get']>>;

interface RouteProbe {
  readonly method: string;
  readonly path: string;
}

/** One route key split into the request that probes it. */
function routeProbe(key: string): RouteProbe {
  const [verb, path] = key.split(' ');
  if (verb === undefined || path === undefined) {
    throw new Error(`the admin route map holds a key this sweep cannot read: ${key}`);
  }
  return { method: verb.slice(1), path: path.replaceAll(/:[^/]+/g, PROBE_SEGMENT) };
}

/**
 * Issues one refusal probe. An unknown verb raises by name rather than being
 * skipped: a route this sweep cannot issue is a route nothing then proves the
 * refusal of, and a silent skip would read as a pass.
 */
function probe(api: APIRequestContext, key: string): Promise<ProbeResponse> {
  const { method, path } = routeProbe(key);
  if (method === 'get') return api.get(path);
  if (method === 'post') return idempotentPost(api, path, { data: {} });
  throw new Error(
    `the admin route map declares ${method.toUpperCase()} ${path}, and this sweep issues GET and POST only — add the verb here rather than letting the route fall out of the sweep`
  );
}

/** The `{ code }` refusal body every admin denial answers with. */
async function codeOf(response: ProbeResponse): Promise<string> {
  return ((await response.json()) as { readonly code: string }).code;
}

/** How a probe settled, as one line naming its route — so a failure says which. */
async function outcomeOf(api: APIRequestContext, key: string): Promise<string> {
  const response = await probe(api, key);
  return `${key} → ${String(response.status())} ${await codeOf(response)}`;
}

const AUDIT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The audit row id a run answers with, refused unless it is a plain identifier:
 * it is interpolated into the SQL-panel query below, which takes query text and
 * offers no binding.
 */
function auditIdOf(body: unknown): string {
  const { auditId } = body as { readonly auditId?: unknown };
  if (typeof auditId !== 'string' || !AUDIT_ID.test(auditId)) {
    throw new Error('an admin run answered without an audit row id to read the role off');
  }
  return auditId;
}

/** What the SQL panel answers with: the rows, as untyped records. */
interface PanelPage {
  readonly rows: readonly Record<string, unknown>[];
}

interface GrowthPrincipals {
  /**
   * The two principals this specification acts as, both admitted by the API's
   * dev-mode allowlist and mapped to their roles by `ADMIN_ROLE_MAP`. The
   * reader is the subject; the operator is here to hold the other side of
   * every claim the reader's refusals make.
   */
  principals: {
    readonly operator: APIRequestContext;
    readonly reader: APIRequestContext;
  };
}

const test = base.extend<GrowthPrincipals>({
  principals: async ({ playwright }, use) => {
    const operator = await mintGrowthAdminContext(playwright.request, GROWTH_ACTORS.operator);
    const reader = await mintGrowthAdminContext(playwright.request, GROWTH_ACTORS.reader);
    try {
      await use({ operator, reader });
    } finally {
      await operator.dispose();
      await reader.dispose();
    }
  },
});

/**
 * The growth reader's authorization, proven against the running Worker rather
 * than against package tests alone.
 *
 * Pure API — no page fixture. The subject is what the server decides, and the
 * admin SPA's own navigation and controls are a courtesy drawn from the
 * catalogue this specification reads directly: rendering is not the control, so
 * driving a browser would assert the courtesy and leave the control unproven.
 */
test.describe('Admin growth authorization', SPEC_MATRIX, () => {
  test('the read-only role reaches the growth reads and is refused everything else on the plane', async ({
    principals,
  }) => {
    const { reader } = principals;

    // The operations catalogue is where a caller learns which role the plane
    // resolved it as and which operations that role may run — and it is the
    // Growth screen's own authority for which controls to render.
    const catalogue = await reader.get('/admin/ops');
    expect(catalogue.status()).toBe(200);
    const surface = adminOpsCatalogSchema.parse(await catalogue.json());
    expect(surface.role).toBe(GROWTH_VIEWER);

    // The surface is non-empty and everything on it is a read. Claimed as a
    // property rather than against a list derived from the same contracts the
    // server filtered by: a mirrored list would agree with a wrong filter.
    expect(surface.ops.length).toBeGreaterThan(0);
    expect(surface.ops.filter((op) => op.kind !== 'read')).toEqual([]);

    // Being offered a read is not reaching it: one runs end to end, through the
    // engine, under this role.
    const read = await executeOpApi(
      reader,
      CAMPAIGN_READ,
      {},
      { idempotencyKey: crypto.randomUUID() }
    );
    expect(read.status()).toBe(200);

    // The catalogue omits the mutation, which is all the interface has to go
    // on — and that is presentation. The same operation issued straight at the
    // server, with input its contract accepts, is refused by the engine before
    // it reaches a transaction, so the refusal rests on nothing the interface
    // did.
    expect(surface.ops.map((op) => op.name)).not.toContain(CAMPAIGN_MINT);
    const tag = `e2e-growth-${crypto.randomUUID().slice(0, 8)}`;
    const refusedMutation = await executeOpApi(
      reader,
      CAMPAIGN_MINT,
      { tag, label: `E2E ${tag}`, reason: REASON },
      { idempotencyKey: crypto.randomUUID() }
    );
    expect(refusedMutation.status()).toBe(403);
    expect(await codeOf(refusedMutation)).toBe(ERROR_CODES.FORBIDDEN);

    // And every route the map does not open to this role, refused before any
    // handler runs. The closed set is computed from the role the SERVER just
    // resolved, so the sweep is exactly "everything this principal was not
    // granted" rather than everything some named role was not granted.
    const closed = Object.keys(ROUTE_ROLES).filter(
      (key) => !(ROUTE_ROLES[key] ?? []).includes(surface.role)
    );
    expect(closed.length).toBeGreaterThan(0);
    const answered = await Promise.all(closed.map((key) => outcomeOf(reader, key)));
    expect(answered).toEqual(closed.map((key) => `${key} → 403 ${ERROR_CODES.FORBIDDEN}`));
  });

  test('the audit row carries the role that ran the operation', async ({ principals }) => {
    const { operator, reader } = principals;

    // A tag nothing else holds, so the mint commits rather than meeting an
    // active campaign of its own from an earlier run and answering a conflict.
    const tag = `e2e-growth-${crypto.randomUUID().slice(0, 8)}`;
    const minted = await executeOpApi(
      operator,
      CAMPAIGN_MINT,
      { tag, label: `E2E ${tag}`, reason: REASON },
      { idempotencyKey: crypto.randomUUID() }
    );
    expect(minted.status()).toBe(200);
    const mintedRow = auditIdOf(await minted.json());

    const read = await executeOpApi(
      reader,
      CAMPAIGN_READ,
      {},
      { idempotencyKey: crypto.randomUUID() }
    );
    expect(read.status()).toBe(200);
    const readRow = auditIdOf(await read.json());

    // Read off the column, through the operator's read-only SQL panel. The
    // trail's own wire projection carries no role field at all
    // (`adminAuditRowWireSchema` in `packages/shared/src/admin/wire.ts`), so
    // neither `GET /admin/audit` nor the screen rendering it could evidence
    // this claim: the column is the only place the fact exists.
    const panel = await operator.get('/admin/sql', {
      params: {
        query: `SELECT id, role FROM admin_audit WHERE id IN ('${mintedRow}', '${readRow}')`,
      },
    });
    expect(panel.status()).toBe(200);
    const page = (await panel.json()) as PanelPage;
    const roleOf = new Map(page.rows.map((row) => [String(row['id']), String(row['role'])]));

    // Both directions. One row alone would pass just as well against a column
    // stamped with a constant; the pair is what shows the stamp tracks the
    // actor that ran the operation.
    expect(roleOf.get(mintedRow)).toBe('operator');
    expect(roleOf.get(readRow)).toBe(GROWTH_VIEWER);
  });
});
