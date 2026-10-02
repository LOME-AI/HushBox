/**
 * # The half of the caching contract this Worker controls
 *
 * Nothing this suite runs against emulates a shared cache, so a test here
 * cannot show that a declared-cacheable response IS served from one. What it
 * can show is the half carrying the privacy risk: that no response leaves this
 * Worker in a state a shared cache is permitted to store unless its own route
 * declared that state. So the assembled router is walked and the storage
 * disposition read off the response each registration actually serves.
 *
 * A route whose handler cannot complete under this fixture — a binding it does
 * not supply, a placeholder path parameter the route's validator rejects —
 * answers a non-200, which the default-deny stage refuses storage on. The
 * proof holds whichever way that goes, and tightens as more routes reach their
 * handlers.
 *
 * Expectations are rendered through `cacheDirectives`, the rendering the
 * pipeline stage writes with, rather than spelled out as header strings: a
 * literal here would be one more place the directives have to agree, which is
 * the drift `CODE-RULES.md` §One Implementation, Shared bans.
 *
 * Production mode, because that is the mode the claim is about — and the mode
 * where the `dev-only` surface answers 404 rather than running handlers that
 * clear Redis state shared with every other file in the run.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { ROUTE_CACHE_POLICIES } from '../composition/route-cache-policy.js';
import { cacheDirectives } from '../lib/cache-policy/index.js';
import { routeKey } from '../lib/context/index.js';
import type { CacheDirectives, CachePolicy } from '../lib/cache-policy/index.js';
import type { Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for the cache-storability walk`);
  }
  return value;
}

const productionEnv: Bindings &
  TelemetryEnv & {
    APP_VERSION: string;
    FRONTEND_URL: string;
    MARKETING_URL: string;
    FRONTEND_PREVIEW_URL: string;
  } = {
  NODE_ENV: 'production',
  DATABASE_URL: requiredEnv('DATABASE_URL'),
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  // Absent, the served-version read fail-fasts and its route answers a defect
  // instead of the response whose disposition this walk is here to measure.
  APP_VERSION: '1.0.0',
  // The admin plane's Access config, in the shape `pipeline-admin.test.ts`
  // uses. Present so the admin routes answer their own fail-closed 401 for a
  // caller carrying no Access assertion, rather than the misconfiguration
  // defect a Worker mounting them without config is meant to raise. No
  // assertion is presented anywhere here, so no key is ever fetched.
  CF_ACCESS_TEAM_DOMAIN: 'hushbox-cache-walk',
  CF_ACCESS_AUD: 'cache-walk-access-aud',
  ADMIN_ACTOR_ALLOWLIST: 'admin@hushbox.test',
  ADMIN_ROLE_MAP: 'admin@hushbox.test=operator',
  // CORS fail-fasts on absent web origins, so the allowlist must be resolvable.
  FRONTEND_URL: requiredEnv('FRONTEND_URL'),
  MARKETING_URL: requiredEnv('MARKETING_URL'),
  FRONTEND_PREVIEW_URL: requiredEnv('FRONTEND_PREVIEW_URL'),
};

/**
 * The edge supplies a caller address on every production request, and the
 * IP-keyed limiters fail closed without one. Fresh per run so a repeat run
 * spends its own windows rather than the previous run's.
 */
const CALLER_IP = `203.0.113.5-${crypto.randomUUID()}`;

/**
 * A stand-in for any path parameter. Its only job is to make a concrete URL —
 * a route whose validator rejects it answers 400, which is a disposition this
 * walk measures like any other.
 */
const PATH_PARAMETER = '00000000-0000-4000-8000-000000000000';

/** The refusal, rendered from the vocabulary rather than written out. */
const REFUSED: CacheDirectives = cacheDirectives({ kind: 'no-store' });

/**
 * The declarations at the lookup type, exactly as the composition root hands
 * them to the stage: this reads the map by key, and never witnesses it.
 */
const POLICIES: Readonly<Record<string, CachePolicy>> = ROUTE_CACHE_POLICIES;

interface ServedDisposition {
  readonly key: string;
  readonly cacheControl: string | null;
  readonly cacheTag: string | null;
}

function concretePath(routePath: string): string {
  return routePath
    .split('/')
    .map((segment) => (segment.startsWith(':') ? PATH_PARAMETER : segment))
    .join('/');
}

/** One comparable rendering, so a served disposition and a declared one read alike. */
function render(cacheControl: string | null, cacheTag: string | null): string {
  return `${cacheControl ?? '(no Cache-Control)'} + Cache-Tag: ${cacheTag ?? '(none)'}`;
}

function renderDeclared(directives: CacheDirectives): string {
  return render(directives.cacheControl, directives.cacheTag ?? null);
}

/**
 * What the declarations permit this route to serve: its own policy, or the
 * refusal — which every route may answer with, since the stage forces it on
 * any response the declaration does not license.
 */
function permitted(key: string): readonly string[] {
  const policy = POLICIES[key];
  const refusal = renderDeclared(REFUSED);
  const declared = policy === undefined ? refusal : renderDeclared(cacheDirectives(policy));
  return [...new Set([refusal, declared])];
}

const served: ServedDisposition[] = [];

beforeAll(async () => {
  const app = createApp();
  const walked = new Set<string>();
  for (const route of app.routes) {
    if (route.method === 'ALL') continue;
    // One request per key: a route class marker and the handler it guards are
    // two registrations of the same method and path.
    const key = routeKey(route);
    if (walked.has(key)) continue;
    walked.add(key);
    const response = await app.request(
      concretePath(route.path),
      { method: route.method, headers: { 'cf-connecting-ip': CALLER_IP } },
      productionEnv
    );
    served.push({
      key,
      cacheControl: response.headers.get('Cache-Control'),
      cacheTag: response.headers.get('Cache-Tag'),
    });
  }
}, 120_000);

describe('what the assembled app lets a shared cache store', () => {
  it('measures a response for every route the policy map declares', () => {
    const measured = new Set(served.map((disposition) => disposition.key));
    const unmeasured = Object.keys(ROUTE_CACHE_POLICIES).filter((key) => !measured.has(key));
    expect(unmeasured).toEqual([]);
  });

  it('names a storage disposition on every response', () => {
    const silent = served
      .filter((disposition) => disposition.cacheControl === null)
      .map((disposition) => disposition.key);
    expect(silent).toEqual([]);
  });

  it('stores nothing beyond what the route serving it declared', () => {
    const violations = served
      .filter(
        (disposition) =>
          !permitted(disposition.key).includes(
            render(disposition.cacheControl, disposition.cacheTag)
          )
      )
      .map(
        (disposition) =>
          `${disposition.key} served ${render(disposition.cacheControl, disposition.cacheTag)}, ` +
          `declared ${permitted(disposition.key).join(' or ')}`
      );
    expect(violations).toEqual([]);
  });
});
