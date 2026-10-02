import { Hono } from 'hono';
import { hc } from 'hono/client';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  ADMIN_OP_CONTRACTS,
  ADMIN_OP_NAMES,
  adminOpsCatalogSchema,
  defineAdminOpContract,
} from '@hushbox/shared';
import { createAdminManifest } from './routes.js';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { bindRequestValue } from '../../lib/context/index.js';
import type { AppEnv, Principal } from '../../middleware/pipeline-manifest.js';
import type { AdminRouteDeps } from './routes.js';
import type { AdminOpEngine } from './domain/index.js';
import type { ErrorResponse } from '@hushbox/shared';
import type { InferResponseType } from 'hono/client';
import type { JSONParsed } from 'hono/utils/types';

/**
 * Unit coverage for the route seam alone: the manifest's routes are mounted
 * WITHOUT the pipeline (the class markers are pass-throughs), so the catalog
 * renderer and the principal defect guard are reachable directly. The full
 * pipeline path lives in routes.integration.test.ts.
 */

const unreachableEngine: AdminOpEngine = {
  run: () => {
    throw new Error('unit test: engine must not be reached');
  },
  read: () => {
    throw new Error('unit test: engine must not be reached');
  },
};

const reason = z.string().trim().min(1);

/** A stand-in audit row id — the route only carries it through, so any uuid does. */
const AUDIT_ID = crypto.randomUUID();

const capsContract = defineAdminOpContract({
  name: 'unit.caps',
  title: 'Guardrail render variants',
  kind: 'mutation',
  input: z.object({ targetId: z.uuid(), reason }),
  inverse: null,
  effectClass: 'ephemeral',
  target: null,
  allowedRoles: ['operator'],
  guardrails: { maxAmountNanoUsd: 1_000_000_000n },
});

const bareContract = defineAdminOpContract({
  name: 'unit.bare',
  title: 'No guardrails',
  kind: 'mutation',
  input: z.object({ targetId: z.uuid(), reason }),
  inverse: null,
  effectClass: 'ephemeral',
  target: null,
  allowedRoles: ['operator'],
});

// The one class the Iron Law lets off an inverse, and the only class whose
// contract may state a reason — so it is what proves the catalog carries one,
// where `unit.caps` and `unit.bare` prove it is carried nowhere else.
const systemOwnedContract = defineAdminOpContract({
  name: 'unit.systemOwned',
  title: 'System-owned effect',
  kind: 'mutation',
  input: z.object({ targetId: z.uuid(), reason }),
  inverse: null,
  effectClass: 'system-owned',
  systemOwnedReason: 'resumes work the system already owed',
  target: null,
  allowedRoles: ['operator'],
});

function appWithPrincipal(
  principal: Principal,
  prefill: AdminRouteDeps['prefill'] = () => null
): Hono<AppEnv> {
  const manifest = createAdminManifest({
    engine: () => unreachableEngine,
    listOps: () => [capsContract, bareContract, systemOwnedContract],
    prefill,
    reads: () => {
      throw new Error('admin reads are not under test in this suite');
    },
  });
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    bindRequestValue(c, 'principal', principal);
    await next();
  });
  app.route(manifest.basePath, manifest.routes);
  app.onError((error, c) => c.json({ message: error.message }, 500));
  return app;
}

const adminActor: Principal = {
  kind: 'admin-actor',
  email: 'admin@hushbox.test',
  audience: 'aud',
  role: 'operator',
};

describe('GET /admin/ops catalog rendering', () => {
  // Exact objects, deliberately: the catalog is the contract the SPA renders,
  // so a silently added or silently dropped field must fail here. Relaxing
  // this to a partial match removes the only gate on the projection's shape.
  it('renders money guardrails as NanoUSD strings and omits absent ones', async () => {
    const response = await appWithPrincipal(adminActor).request('/admin/ops');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ops: [
        {
          name: 'unit.caps',
          title: 'Guardrail render variants',
          kind: 'mutation',
          effectClass: 'ephemeral',
          inverse: null,
          fields: ['targetId', 'reason'],
          guardrails: { maxAmountNanoUsd: '1000000000' },
        },
        {
          name: 'unit.bare',
          title: 'No guardrails',
          kind: 'mutation',
          effectClass: 'ephemeral',
          inverse: null,
          fields: ['targetId', 'reason'],
        },
        {
          name: 'unit.systemOwned',
          title: 'System-owned effect',
          kind: 'mutation',
          effectClass: 'system-owned',
          inverse: null,
          fields: ['targetId', 'reason'],
          systemOwnedReason: 'resumes work the system already owed',
        },
      ],
      role: 'operator',
    });
  });

  it('serializes the stated reason only on the system-owned entry', async () => {
    const response = await appWithPrincipal(adminActor).request('/admin/ops');
    const body: { ops: Record<string, unknown>[] } = await response.json();
    const stated = body.ops.filter((op) => 'systemOwnedReason' in op);
    expect(stated.map((op) => op['name'])).toEqual(['unit.systemOwned']);
  });
});

describe('GET /admin/ops/:name/prefill', () => {
  it('answers the resolved input envelope for an op with a resolver', async () => {
    const app = appWithPrincipal(adminActor, (_db, name) =>
      name === 'unit.caps' ? okAsync({ targetId: 'seeded' }) : null
    );
    const response = await app.request('/admin/ops/unit.caps/prefill');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input: { targetId: 'seeded' } });
  });

  it('answers 404 when the dep resolves nothing (unknown op and resolver-less op alike)', async () => {
    const response = await appWithPrincipal(adminActor).request('/admin/ops/unit.caps/prefill');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('maps a resolver domain failure through the uniform error body', async () => {
    const app = appWithPrincipal(adminActor, () => errAsync(unavailableError('store down')));
    const response = await app.request('/admin/ops/unit.caps/prefill');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'UNAVAILABLE' });
  });
});

describe('the admin-actor defect guard', () => {
  it('treats a non-admin principal reaching a handler as a defect, never a client error', async () => {
    // Only possible when the authorizer is bypassed (as this bare mount
    // does) — the route seam still refuses to attribute an op to a session.
    const full: Principal = {
      kind: 'full',
      claims: {
        userId: crypto.randomUUID(),
        sessionId: 's1',
        createdAt: 0,
        pending2FA: false,
        pending2FAExpiresAt: 0,
      },
    };
    const response = await appWithPrincipal(full).request('/admin/ops/unit.caps/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { targetId: crypto.randomUUID(), reason: 'x' } }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      message: 'admin routes: handler reached without an admin-actor principal',
    });
  });
});

/**
 * The admin slice's typed-client contract. This pin fails as a typecheck error
 * the moment the slice's refusal responder reverts to a bare `Response`, which
 * lands at hono's whole `StatusCode` and leaves every refusal body information-free.
 *
 * The client is constructed purely as a `typeof` anchor for `InferResponseType`;
 * no request is made, so the base URL is never dereferenced.
 */
const _typeClient = hc<ReturnType<typeof createAdminManifest>['routes']>('http://demo.invalid');

describe('admin route response types', () => {
  it('infers the op-prefill refusal body', () => {
    expectTypeOf<
      InferResponseType<(typeof _typeClient)['ops'][':name']['prefill']['$get'], 503>
    >().toEqualTypeOf<JSONParsed<ErrorResponse>>();
  });
});

/**
 * The catalogue a growth-viewer receives from the REAL inventory, not from
 * fixtures: what makes an operation visible to that role is its own contract's
 * `allowedRoles`, and a contract that forgets the role produces an empty
 * catalogue rather than an error — which reads as a rendering fault. This is
 * the assertion that would catch it.
 */
describe('GET /admin/ops for the read-only role', () => {
  const viewerActor: Principal = {
    kind: 'admin-actor',
    email: 'viewer@hushbox.test',
    audience: 'aud',
    role: 'growth-viewer',
  };

  function appWithRealInventory(principal: Principal): Hono<AppEnv> {
    const manifest = createAdminManifest({
      engine: () => unreachableEngine,
      listOps: () => ADMIN_OP_NAMES.map((name) => ADMIN_OP_CONTRACTS[name]),
      prefill: () => null,
      reads: () => {
        throw new Error('admin reads are not under test in this suite');
      },
    });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      bindRequestValue(c, 'principal', principal);
      await next();
    });
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  it('serves the viewer exactly the growth reads and nothing else', async () => {
    const response = await appWithRealInventory(viewerActor).request('/admin/ops');

    const body = adminOpsCatalogSchema.parse(await response.json());
    expect(body.role).toBe('growth-viewer');
    expect(body.ops.map((op) => op.name).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'growth.campaigns.read',
      'growth.events.read',
      'growth.freshness.read',
      'growth.funnel.read',
      'growth.marketing.read',
      'growth.reach.read',
      'growth.sources.read',
    ]);
  });

  it('serves the operator the campaign pair the viewer never sees', async () => {
    const response = await appWithRealInventory(adminActor).request('/admin/ops');

    const body = adminOpsCatalogSchema.parse(await response.json());
    const names = body.ops.map((op) => op.name);
    expect(names).toContain('growth.campaign.create');
    expect(names).toContain('growth.campaign.archive');
  });
});

describe('POST /admin/ops/:name/execute dispatches on the contract kind', () => {
  const readContract = defineAdminOpContract({
    name: 'unit.look',
    title: 'Unit read',
    kind: 'read',
    input: z.object({}),
    inverse: null,
    effectClass: 'ephemeral',
    target: null,
    allowedRoles: ['operator', 'growth-viewer'],
  });

  function appWithRead(engine: AdminOpEngine): Hono<AppEnv> {
    const manifest = createAdminManifest({
      engine: () => engine,
      listOps: () => [readContract, capsContract],
      prefill: () => null,
      reads: () => {
        throw new Error('admin reads are not under test in this suite');
      },
    });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      bindRequestValue(c, 'principal', adminActor);
      await next();
    });
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  it('sends a read contract to the engine’s read path and answers its result', async () => {
    const calls: unknown[] = [];
    const app = appWithRead({
      run: () => {
        throw new Error('a read must not reach the mutation path');
      },
      read: (params) => {
        calls.push(params);
        return okAsync({ kind: 'read', auditId: AUDIT_ID, data: { panels: {} } });
      },
    });

    const response = await app.request('/admin/ops/unit.look/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: 'read',
      auditId: AUDIT_ID,
      data: { panels: {} },
    });
    expect(calls).toEqual([
      { name: 'unit.look', input: {}, actor: 'admin@hushbox.test', role: 'operator' },
    ]);
  });

  it('sends a mutation contract to the op engine, key header and all', async () => {
    const calls: { name: string; mode: string }[] = [];
    const app = appWithRead({
      run: (params) => {
        calls.push({ name: params.name, mode: params.mode });
        return okAsync({ auditId: AUDIT_ID, effects: [], inverseInput: null });
      },
      read: () => {
        throw new Error('a mutation must not reach the read path');
      },
    });

    const response = await app.request('/admin/ops/unit.caps/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'unit-key' },
      body: JSON.stringify({ input: {} }),
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ name: 'unit.caps', mode: 'execute' }]);
  });
});
