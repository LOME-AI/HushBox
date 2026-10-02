import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { ERROR_CODES } from '@hushbox/shared';
import { createApp } from '../app.js';
import { defineSliceManifest, routeClass } from '../middleware/pipeline-manifest.js';
import { routeKey } from '../lib/context/index.js';
import { CLASS_DEFAULTS, bindRoutePosture } from '../lib/rate-limit/index.js';
import { readRouteClass } from '../middleware/pipeline-markers.js';
import { ROUTE_POSTURES } from '../composition/rate-limit-posture.js';
import type { AppEnv } from '../middleware/pipeline-manifest.js';
import type { Bindings, RouteClass } from '../lib/context/index.js';
import type { ThrottleLimit } from '../lib/rate-limit/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `posture-stage tests: missing ${name}. Run via the package test script ` +
        '(with-env loads apps/api/.dev.vars) with the local dev stack up (pnpm db:up).'
    );
  }
  return value;
}

const devEnv: Bindings &
  TelemetryEnv & {
    FRONTEND_URL: string;
    MARKETING_URL: string;
    FRONTEND_PREVIEW_URL: string;
  } = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  // The composed pipeline runs CORS first; it fail-fasts on absent web origins.
  FRONTEND_URL: requiredEnv('FRONTEND_URL'),
  MARKETING_URL: requiredEnv('MARKETING_URL'),
  FRONTEND_PREVIEW_URL: requiredEnv('FRONTEND_PREVIEW_URL'),
};

/**
 * A slice mounted the way a real one is, at a path the posture map cannot
 * declare — the map is keyed off `AppType`, so a key naming this route would
 * fail as an excess property. Its refusal is the assembled app's own answer,
 * from the map the composition root wired: nothing here supplies a posture.
 */
function fixtureManifest(): ReturnType<typeof defineSliceManifest> {
  return defineSliceManifest({
    basePath: '/fixture',
    routes: new Hono<AppEnv>().get('/undeclared', routeClass('public'), (c) =>
      c.json({ route: 'undeclared' })
    ),
  });
}

function appWithUndeclaredRoute(): ReturnType<typeof createApp> {
  const manifest = fixtureManifest();
  const app = createApp();
  app.route(manifest.basePath, manifest.routes);
  return app;
}

describe('the assembled app enforces the posture map', () => {
  it('refuses a route the wired posture map does not declare', async () => {
    const res = await appWithUndeclaredRoute().request('/fixture/undeclared', {}, devEnv);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ code: ERROR_CODES.RATE_LIMITED });
  });

  it('serves a caller-mounted route once the caller declares its posture', async () => {
    const manifest = fixtureManifest();
    const app = createApp({ '$get /fixture/undeclared': { kind: 'default', failure: 'open' } });
    app.route(manifest.basePath, manifest.routes);
    const res = await app.request('/fixture/undeclared', {}, devEnv);
    expect(res.status).toBe(200);
  });

  it('serves a real public route the map declares', async () => {
    const res = await createApp().request('/health', {}, devEnv);
    expect(res.status).toBe(200);
  });

  it('serves the route the map declares exempt (a signature-gated webhook)', async () => {
    // The exemption's whole claim is that the signature verifier, not a
    // counter, is the bound — so the delivery must reach that verifier. Its
    // 401 on absent svix headers is the evidence it did; a posture refusal
    // would answer 429 before the handler ran. The secret is the dev-mode
    // registry literal, well-formed so the verifier constructs.
    const webhookEnv: typeof devEnv & { RESEND_WEBHOOK_SECRET: string } = {
      ...devEnv,
      RESEND_WEBHOOK_SECRET: 'whsec_bmV3c2xldHRlci1kZXYtd2ViaG9vay1zZWNyZXQ=',
    };
    const res = await createApp().request(
      '/newsletter/webhooks/resend',
      { method: 'POST', body: '{}' },
      webhookEnv
    );
    expect(res.status).toBe(401);
  });

  it('serves a route whose declaration carries a counter the stage spends', async () => {
    // The one case here whose posture spends something: the stage resolves the
    // identity, spends the declared window and admits. The validator's 400 is
    // the evidence the request reached the route rather than a 429.
    const res = await createApp().request(
      '/newsletter/subscribe',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      devEnv
    );
    expect(res.status).toBe(400);
  });

  it('serves a dev-only route the map declares with a class default', async () => {
    const res = await createApp().request('/dev/mock-charge-basis', {}, devEnv);
    expect(res.status).toBe(200);
  });
});

/**
 * A posture no product route could carry: `/health` is `public`-classed, so a
 * caller reaches it with no principal at all and a `user`-keyed layer throws
 * rather than resolving. That is what makes it an ORDER probe — if the
 * argument were merged last, this declaration would replace the product's and
 * the liveness route would answer 500.
 */
const CALLER_OVERRIDE_PROBE = {
  kind: 'throttle',
  maxAttempts: 1,
  windowSeconds: 60,
  buildKey: (id: string) => `posture-fixture:caller-override:${id}`,
} as const satisfies ThrottleLimit;

describe("the posture argument against the product's own declarations", () => {
  it("leaves the product's declaration standing when a caller names a route it already declares", async () => {
    const app = createApp({
      '$get /health': bindRoutePosture({
        failure: 'closed',
        layers: [{ identity: 'user', countedAt: 'edge', definition: CALLER_OVERRIDE_PROBE }],
      }),
    });

    const res = await app.request('/health', {}, devEnv);

    expect(res.status).toBe(200);
  });
});

/**
 * The route classes a `default` posture sends to a class default. A class
 * default is the whole content of that posture, so this set is the row set any
 * class-default table has to cover; a class arriving here without one would be
 * a declared bound with nothing behind it. Measured off the assembled router
 * rather than read off the map, because the class travels on the handler.
 */
function classDefaultReachableRouteClasses(): readonly RouteClass[] {
  const classByKey = new Map<string, RouteClass>();
  for (const route of createApp().routes) {
    if (route.method === 'ALL') continue;
    const cls = readRouteClass(route.handler);
    if (cls !== undefined) classByKey.set(routeKey(route), cls);
  }
  const reached = new Set<RouteClass>();
  for (const [key, posture] of Object.entries(ROUTE_POSTURES)) {
    if (posture.kind !== 'default') continue;
    const cls = classByKey.get(key);
    if (cls !== undefined) reached.add(cls);
  }
  return [...reached].toSorted((a, b) => a.localeCompare(b));
}

describe('what a class default has to cover', () => {
  it('sends exactly these route classes to a class default', () => {
    expect(classDefaultReachableRouteClasses()).toEqual([
      'admin',
      'billing-token',
      'dev-only',
      'pending-2fa',
      'public',
      'session',
    ]);
  });

  it('gives every one of them a default to be sent to', () => {
    const missing = classDefaultReachableRouteClasses().filter(
      (cls) => !Object.hasOwn(CLASS_DEFAULTS, cls)
    );
    expect(missing).toEqual([]);
  });
});
