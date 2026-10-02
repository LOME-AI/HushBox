import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, bannerDismissals, createDb, preferences } from '@hushbox/db';
import { applyPipeline } from '../middleware/pipeline.js';
import { routeClass } from '../middleware/pipeline-markers.js';
import { ROUTE_CACHE_POLICIES } from '../composition/route-cache-policy.js';
import {
  CALLER_HEADER_ARMS,
  CALLER_QUERY_ARMS,
  proveCallerInvariance,
} from './caller-invariance.js';
import type { CallerRequest } from './caller-invariance.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';
import type { Context } from 'hono';

/**
 * The proof helper is the whole evidence behind every storable declaration, so
 * what it FAILS on is the part worth pinning: a guard that accepts a
 * caller-varying route proves nothing about the ones it accepts.
 *
 * The header canaries are generated from {@link CALLER_HEADER_ARMS}, which the
 * helper reads off the builders that send its two callers' headers: a header
 * either caller starts carrying acquires its canary with nothing written here,
 * and one carried identically by both fails the canary it generates. An arm
 * that is not a request header is probed by hand, and one added there needs its
 * case written with it.
 *
 * Most cases name `$get /health`, which is declared no-store and so reaches
 * the helper's tag assertion only through its skip arm; the storable cases
 * name `$get /public/roadmap` to reach the other arm. Neither discharges a
 * declaration: `cacheable-routes-prove-caller-invariance` counts a proof only
 * inside `apps/api/src/slices/`, precisely so a file whose subject is the
 * helper cannot answer for a route it never serves.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for the caller-invariance helper's own tests`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');

const SESSION_SECRET = 'secret-at-least-32-characters-long!!';

const env: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: SESSION_SECRET,
  TELEMETRY_SINKS: 'console',
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

afterAll(async () => {
  await db.$client.end();
});

/**
 * The credentials a route may read off the query string rather than a header:
 * `slices/chat/routes.ts` reads `trialToken` and the conversations upgrade reads
 * a link guest's `ticket`, both on their WebSocket upgrade, where a browser can
 * set no header. Named here rather than derived, because the query the helper
 * sends is a sample and this is the half of it that must not shrink — a
 * credential absent from BOTH callers is one no proof varies.
 */
const QUERY_CREDENTIAL_ARMS = ['trialToken', 'ticket'];

const STORABLE_ROUTE = '$get /public/roadmap';
const STORABLE_PATH = '/public/roadmap';

/** A stand-in route, sync or async — the stored-state probes read the database. */
type Probe = (c: Context<AppEnv>) => Response | Promise<Response>;

function probeAnswering(handler: Probe): {
  respondTo: (request: CallerRequest) => Promise<Response>;
} {
  const app = applyPipeline(new Hono<AppEnv>()).get('/probe', routeClass('public'), handler);
  return { respondTo: async ({ path, headers }) => app.request(path, { headers }, env) };
}

/**
 * A stand-in answering a route the map declares storable, so the response
 * carries the declared `Cache-Tag` the stage renders onto it. Omitting the
 * policies leaves the stage writing nothing outside production — the shape a
 * proof that wires no map has, and the shape the tag assertion has to refuse.
 */
function storableProbeAnswering(
  handler: Probe,
  options?: { readonly withoutPolicies?: true }
): { respondTo: (request: CallerRequest) => Promise<Response> } {
  const app = applyPipeline(
    new Hono<AppEnv>(),
    options?.withoutPolicies === true ? undefined : { cache: { policies: ROUTE_CACHE_POLICIES } }
  ).get(STORABLE_PATH, routeClass('public'), handler);
  return { respondTo: async ({ path, headers }) => app.request(path, { headers }, env) };
}

async function proveStorable(
  handler: Probe,
  options?: { readonly withoutPolicies?: true }
): Promise<void> {
  await proveCallerInvariance(STORABLE_ROUTE, {
    path: STORABLE_PATH,
    sessionSecret: SESSION_SECRET,
    databaseUrl: DATABASE_URL,
    seedIdentifiedState: (): Promise<void> => Promise.resolve(),
    ...storableProbeAnswering(handler, options),
  });
}

async function prove(handler: Probe, seed?: (userId: string) => Promise<void>): Promise<void> {
  await proveCallerInvariance('$get /health', {
    path: '/probe',
    sessionSecret: SESSION_SECRET,
    databaseUrl: DATABASE_URL,
    seedIdentifiedState: seed ?? ((): Promise<void> => Promise.resolve()),
    ...probeAnswering(handler),
  });
}

/** The caller's own id, or `undefined` for the caller presenting no session. */
function probeUserId(c: Context<AppEnv>): string | undefined {
  return c.var.principal.kind === 'full' ? c.var.principal.claims.userId : undefined;
}

describe('proving a route invariant across callers', () => {
  it('accepts a route that answers both callers the same bytes', async () => {
    await expect(prove((c) => c.json({ banner: 'same for everyone' }))).resolves.toBeUndefined();
  });

  it('refuses a route whose body answers the caller query', async () => {
    await expect(prove((c) => c.json({ locale: c.req.query('locale') ?? null }))).rejects.toThrow(
      /different/
    );
  });

  it('refuses a route whose body answers the caller session', async () => {
    await expect(prove((c) => c.json({ caller: c.var.principal.kind }))).rejects.toThrow(
      /different bytes/
    );
  });

  it.each(CALLER_HEADER_ARMS)(
    'refuses a route whose body answers the caller %s header',
    async (header) => {
      await expect(prove((c) => c.text(c.req.header(header) ?? 'absent'))).rejects.toThrow(
        /different/
      );
    }
  );

  it('refuses a route whose body answers a stored row keyed on the caller', async () => {
    await expect(
      prove(async (c) => {
        const userId = probeUserId(c);
        const rows =
          userId === undefined
            ? []
            : await c.var.db
                .select({ id: preferences.id })
                .from(preferences)
                .where(eq(preferences.userId, userId));
        return c.json({ settled: rows.length > 0 });
      })
    ).rejects.toThrow(/different/);
  });

  it('refuses a route whose body answers the state the proof seeded for the caller', async () => {
    await expect(
      prove(
        async (c) => {
          const userId = probeUserId(c);
          const rows =
            userId === undefined
              ? []
              : await c.var.db
                  .select({ id: bannerDismissals.id })
                  .from(bannerDismissals)
                  .where(eq(bannerDismissals.userId, userId));
          return c.json({ dismissed: rows.length > 0 });
        },
        async (userId) => {
          await db.insert(bannerDismissals).values({ userId, messageSetHash: 'dismissed-set' });
        }
      )
    ).rejects.toThrow(/different/);
  });

  it('refuses two bodies that parse alike but serialize differently', async () => {
    let served = 0;
    await expect(
      prove((c) => {
        served += 1;
        return c.text(served === 1 ? '{"a":1,"b":2}' : '{"b":2,"a":1}');
      })
    ).rejects.toThrow(/different bytes/);
  });

  it.each(QUERY_CREDENTIAL_ARMS)('varies the %s query credential', (parameter) => {
    expect(CALLER_QUERY_ARMS).toContain(parameter);
  });

  it('accepts a storable route whose response carries its declared cache tag', async () => {
    await expect(
      proveStorable((c) => c.json({ board: 'same for everyone' }))
    ).resolves.toBeUndefined();
  });

  it('refuses a storable route whose response carries no cache tag', async () => {
    await expect(
      proveStorable((c) => c.json({ board: 'same for everyone' }), { withoutPolicies: true })
    ).rejects.toThrow(/Cache-Tag/);
  });

  it('refuses a route that answers neither caller successfully', async () => {
    await expect(prove((c) => c.json({ code: 'SERVICE_UNAVAILABLE' }, 503))).rejects.toThrow(
      /error/
    );
  });
});
