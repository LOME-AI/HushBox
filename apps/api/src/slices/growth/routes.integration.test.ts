import { Hono } from 'hono';
import { Redis } from '@upstash/redis';
import { describe, expect, it, vi } from 'vitest';
import {
  GROWTH_BEACON_MAX_BODY_BYTES,
  GROWTH_UNKNOWN_CAMPAIGN,
  MARKETING_ROUTES,
} from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { ROUTE_CACHE_POLICIES } from '../../composition/route-cache-policy.js';
import {
  GROWTH_REDIS_KEYS,
  callerIpIdForAddress,
  growthDayBucket,
  growthHourBucket,
} from '../../lib/redis/index.js';
import { bindRequestValue } from '../../lib/context/index.js';
import { okAsync } from '../../lib/result/index.js';
import { BEACON_STATUS } from './domain/beacon-script.js';
import { dailyAddressId } from './domain/visitor-hash.js';
import { createGrowthManifest } from './routes.js';
import { GROWTH_ROUTE_POSTURES } from './rate-limit-posture.js';
import type { GrowthEventIndex } from '@hushbox/shared';
import type { GrowthPlace } from '../../lib/redis/index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { GrowthStores } from './ports/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for growth beacon route integration tests`);
  }
  return value;
}

/**
 * The marketing origin this mode defines — the value the route tells an
 * internal referrer from. Read through the same required-variable helper as
 * every other binding here: a fallback default would let the suite assert the
 * internal-referrer rule against a host no mode actually uses, which is the
 * failure this whole case exists to catch, one level down.
 */
const MARKETING_URL = requiredEnv('MARKETING_URL');

const SECRET = 'a-growth-hash-secret-of-at-least-32-chars';

const testEnv: Bindings & TelemetryEnv & { MARKETING_URL: string } = {
  NODE_ENV: 'development',
  DATABASE_URL: requiredEnv('DATABASE_URL'),
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  GROWTH_HASH_SECRET: SECRET,
  MARKETING_URL,
  TELEMETRY_SINKS: 'console',
};

const redis = new Redis({
  url: requiredEnv('UPSTASH_REDIS_REST_URL'),
  token: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
});

/** The first static marketing route: a page the site builds whatever the index carries. */
const KNOWN_PAGE = MARKETING_ROUTES[0];

/**
 * Our own hostname FOR THIS MODE, taken from the binding the route reads —
 * never a production literal, or this suite would assert the rule against a
 * host the route never sees outside production.
 */
const MARKETING_HOSTNAME = new URL(MARKETING_URL).hostname;

const KNOWN_EVENT = 'link:/signup';

const EVENT_INDEX: GrowthEventIndex = { [KNOWN_PAGE]: [KNOWN_EVENT] };

/** A campaign store that answers no active tags, so every tag folds to `unknown`. */
function stores(tags: readonly string[] = []): GrowthStores {
  return { listActiveCampaignTags: () => okAsync(tags) };
}

function buildApp(growthStores: GrowthStores = stores()): Hono<AppEnv> {
  const manifest = createGrowthManifest({ stores: growthStores, eventIndex: EVENT_INDEX });
  const app = applyPipeline(new Hono<AppEnv>(), {
    cache: { policies: ROUTE_CACHE_POLICIES },
    rateLimit: { postures: GROWTH_ROUTE_POSTURES },
  });
  app.route(manifest.basePath, manifest.routes);
  return app;
}

/**
 * A fresh address per call. The per-address throttle counts in the shared local
 * Redis, and the visitor hash is derived from the address too — so a reused one
 * would couple these cases to each other in both directions.
 */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'cf-connecting-ip': `203.0.113.9-${crypto.randomUUID()}`,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36',
    'content-type': 'text/plain',
    ...extra,
  };
}

/** The same headers with no user agent at all — a client that sends none. */
function headersWithoutUserAgent(): Record<string, string> {
  const rest = headers();
  delete rest['user-agent'];
  return rest;
}

async function beacon(
  app: Hono<AppEnv>,
  body: string,
  extra: Record<string, string> = {}
): Promise<Response> {
  return app.request('/e', { method: 'POST', headers: headers(extra), body }, testEnv);
}

/**
 * A request carrying the edge's own geography properties.
 *
 * Nothing else in this suite supplies them, so without this the read that takes
 * a country and a state from the request is never executed and every case
 * records blank geography — which is also exactly what a wrong property name
 * would produce, silently and forever.
 */
async function beaconFrom(
  app: Hono<AppEnv>,
  body: string,
  cf: Record<string, unknown>
): Promise<Response> {
  const request = new Request('http://localhost/e', {
    method: 'POST',
    headers: headers(),
    body,
  });
  Object.defineProperty(request, 'cf', { value: cf });
  return app.request(request, undefined, testEnv);
}

/** How many visitors that hour were counted in one country, state and device family. */
async function geoVisitors(at: Date, place: GrowthPlace): Promise<number> {
  const key = GROWTH_REDIS_KEYS.geo.buildKey('h', growthHourBucket(at), place);
  return redis.scard(key);
}

/**
 * Every key below is built into a named value before it reaches Redis.
 *
 * These cases address the live bucket and the page set the site really builds,
 * so their keys are the production ones rather than identities this run
 * minted — which is what lets them assert that the ROUTE wrote what the route
 * writes.
 */

/**
 * The instant a case reads its keys under, captured ONCE and passed to every
 * read.
 *
 * Deriving the bucket per call would let a before-read, the route's own clock
 * read and an after-read straddle an hour or a day boundary — three reads of
 * three different keys, compared as though they were one. That is a flake
 * whose window opens twice a day on a suite that runs on every push, so the
 * instant is a value a case holds rather than one each helper re-derives.
 */
function nowForKeys(): Date {
  return new Date();
}

/** The count of a bucket's visitor set, at the instant the case captured. */
async function visitorsThisHour(at: Date): Promise<number> {
  const key = GROWTH_REDIS_KEYS.visitors.buildKey('h', growthHourBucket(at));
  return redis.scard(key);
}

/** How many visitors that hour were counted under one campaign tag on one page. */
async function campaignVisitors(at: Date, campaign: string): Promise<number> {
  const key = GROWTH_REDIS_KEYS.campaignPaths.buildKey(
    'h',
    growthHourBucket(at),
    campaign,
    KNOWN_PAGE
  );
  return redis.scard(key);
}

/** How many visitors that hour were counted as viewing one page. */
async function pageVisitors(at: Date, path: string): Promise<number> {
  const key = GROWTH_REDIS_KEYS.views.buildKey('h', growthHourBucket(at), path);
  return redis.scard(key);
}

/** How many visitors that hour reached the page from one referrer host. */
async function referrerVisitors(at: Date, host: string): Promise<number> {
  const key = GROWTH_REDIS_KEYS.referrers.buildKey('h', growthHourBucket(at), KNOWN_PAGE, host);
  return redis.scard(key);
}

/** The visitor hashes written into that day's set — what a log line must never carry. */
async function visitorsToday(at: Date): Promise<string[]> {
  const key = GROWTH_REDIS_KEYS.visitors.buildKey('d', growthDayBucket(at));
  return redis.smembers(key);
}

describe('POST /e', () => {
  it('accepts a page view and answers no content', async () => {
    const at = nowForKeys();
    const before = await visitorsThisHour(at);
    const res = await beacon(buildApp(), JSON.stringify({ t: 'v', p: KNOWN_PAGE }));
    expect(res.status).toBe(204);
    expect(await visitorsThisHour(at)).toBe(before + 1);
  });

  it('declares itself unstorable so no shared cache answers a later beacon', async () => {
    const res = await beacon(buildApp(), JSON.stringify({ t: 'v', p: KNOWN_PAGE }));
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('accepts a named event the built index carries for that page', async () => {
    const at = nowForKeys();
    const before = await visitorsThisHour(at);
    const res = await beacon(buildApp(), JSON.stringify({ t: 'e', p: KNOWN_PAGE, n: KNOWN_EVENT }));
    expect(res.status).toBe(204);
    expect(await visitorsThisHour(at)).toBe(before + 1);
  });

  // A crawler that announces itself is not a visitor, and a beacon fires only
  // where JavaScript ran, so what reaches here is the honest half of the gate.
  it('writes nothing for a user agent a bot list names', async () => {
    const at = nowForKeys();
    const before = await visitorsThisHour(at);
    const res = await beacon(buildApp(), JSON.stringify({ t: 'v', p: KNOWN_PAGE }), {
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    });
    expect(res.status).toBe(204);
    expect(await visitorsThisHour(at)).toBe(before);
  });

  // Dropped, never refused: a 4xx would tell a sender which names exist, and
  // every name it could mint would be a row kept forever.
  it('drops a page the site does not build without saying so', async () => {
    const at = nowForKeys();
    const before = await visitorsThisHour(at);
    const res = await beacon(buildApp(), JSON.stringify({ t: 'v', p: '/not-a-built-page' }));
    expect(res.status).toBe(204);
    expect(await visitorsThisHour(at)).toBe(before);
  });

  it('drops an event name the built index does not carry for that page', async () => {
    const at = nowForKeys();
    const before = await visitorsThisHour(at);
    const res = await beacon(
      buildApp(),
      JSON.stringify({ t: 'e', p: KNOWN_PAGE, n: 'link:/invented' })
    );
    expect(res.status).toBe(204);
    expect(await visitorsThisHour(at)).toBe(before);
  });

  it('drops an event carrying no name at all', async () => {
    const at = nowForKeys();
    const before = await visitorsThisHour(at);
    const res = await beacon(buildApp(), JSON.stringify({ t: 'e', p: KNOWN_PAGE }));
    expect(res.status).toBe(204);
    expect(await visitorsThisHour(at)).toBe(before);
  });

  const malformed: readonly (readonly [string, string])[] = [
    ['a body that is not JSON', 'not json at all'],
    ['a body missing the type', JSON.stringify({ p: KNOWN_PAGE })],
    ['a type outside the two', JSON.stringify({ t: 'x', p: KNOWN_PAGE })],
    ['a path that is not a path', JSON.stringify({ t: 'v', p: 'welcome' })],
    [
      'a referrer carrying a whole url',
      JSON.stringify({ t: 'v', p: KNOWN_PAGE, r: 'https://a.b' }),
    ],
    [
      'a campaign tag of the wrong shape',
      JSON.stringify({ t: 'v', p: KNOWN_PAGE, c: 'Spring 25' }),
    ],
  ];
  it.each(malformed)('refuses %s', async (_label, body) => {
    const res = await beacon(buildApp(), body);
    expect(res.status).toBe(400);
  });

  it('refuses a body past the size the sender is obliged to stay under', async () => {
    const filler = 'a'.repeat(GROWTH_BEACON_MAX_BODY_BYTES);
    const res = await beacon(buildApp(), JSON.stringify({ t: 'v', p: KNOWN_PAGE, n: filler }));
    expect(res.status).toBe(400);
  });

  it('counts a tag no campaign carries under the unknown tag, never as a refusal', async () => {
    const at = nowForKeys();
    const res = await beacon(
      buildApp(stores()),
      JSON.stringify({ t: 'v', p: KNOWN_PAGE, c: `c-${crypto.randomUUID().slice(0, 8)}` })
    );
    expect(res.status).toBe(204);
    expect(await campaignVisitors(at, 'unknown')).toBeGreaterThan(0);
  });

  // The active tags are read from the campaigns table once per registry
  // lifetime and answered from Redis in between, so the route's own read of
  // that table runs only for a beacon meeting an expired registry. Every other
  // case here meets a warm one — whichever suite warmed it — so the expiry is
  // supplied at the Redis seam rather than by clearing the shared registry key,
  // which another file could refill between the clear and the request.
  it('counts a tag the campaigns table lists under that tag when the registry has expired', async () => {
    const active = `c-${crypto.randomUUID().slice(0, 8)}`;
    const manifest = createGrowthManifest({ stores: stores([active]), eventIndex: EVENT_INDEX });
    const written: string[] = [];
    const app = applyPipeline(new Hono<AppEnv>(), { cache: { policies: ROUTE_CACHE_POLICIES } });
    app.use('*', async (c, next) => {
      bindRequestValue(c, 'redis', expiredRegistryRedis(written));
      await next();
    });
    app.route(manifest.basePath, manifest.routes);

    const res = await app.request(
      '/e',
      {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ t: 'v', p: KNOWN_PAGE, c: active }),
      },
      testEnv
    );

    expect(res.status).toBe(204);
    expect(written.some((key) => key.includes(active))).toBe(true);
    expect(written.some((key) => key.includes(GROWTH_UNKNOWN_CAMPAIGN))).toBe(false);
  });

  it('counts a beacon carrying no tag under the direct tag', async () => {
    const at = nowForKeys();
    const res = await beacon(buildApp(), JSON.stringify({ t: 'v', p: KNOWN_PAGE }));
    expect(res.status).toBe(204);
    expect(await campaignVisitors(at, 'direct')).toBeGreaterThan(0);
  });

  // The browser reports `/welcome/` for the page the build emitted as
  // `/welcome`. Both spellings are admitted by the payload schema, so counting
  // under the submitted one would split a page's counts across two keys and,
  // an hour later, two permanently-retained rows nothing could recognise as
  // one page.
  it('counts a trailing-slash spelling under the page the site built', async () => {
    const at = nowForKeys();
    const before = await pageVisitors(at, KNOWN_PAGE);

    const res = await beacon(buildApp(), JSON.stringify({ t: 'v', p: `${KNOWN_PAGE}/` }));

    expect(res.status).toBe(204);
    expect(await pageVisitors(at, KNOWN_PAGE)).toBe(before + 1);
    expect(await pageVisitors(at, `${KNOWN_PAGE}/`)).toBe(0);
  });

  // Our own hostname is what an internal navigation reports, and it is not a
  // source of traffic — counted, it becomes the top referrer and buries every
  // real one.
  it('counts no referrer for a visitor arriving from our own pages', async () => {
    const at = nowForKeys();

    const res = await beacon(
      buildApp(),
      JSON.stringify({ t: 'v', p: KNOWN_PAGE, r: MARKETING_HOSTNAME })
    );

    expect(res.status).toBe(204);
    expect(await referrerVisitors(at, MARKETING_HOSTNAME)).toBe(0);
  });

  it('counts a referrer host that is not ours', async () => {
    const at = nowForKeys();
    const host = `h${crypto.randomUUID().slice(0, 8)}.example.com`;

    const res = await beacon(buildApp(), JSON.stringify({ t: 'v', p: KNOWN_PAGE, r: host }));

    expect(res.status).toBe(204);
    expect(await referrerVisitors(at, host)).toBe(1);
  });

  // The geography a row carries comes from these two properties and from
  // nowhere else. The edge hands over a full region NAME as well as a region
  // CODE, and reading the wrong one leaves every state column blank forever,
  // with no error anywhere — so the case supplies both and pins which is read.
  it('counts the country and the US state the edge reported', async () => {
    const at = nowForKeys();
    const place = { country: 'US', region: 'CA', device: 'desktop' };
    const stateless = { country: 'US', region: '', device: 'desktop' };
    const before = await geoVisitors(at, place);
    const beforeStateless = await geoVisitors(at, stateless);

    const res = await beaconFrom(buildApp(), JSON.stringify({ t: 'v', p: KNOWN_PAGE }), {
      country: 'US',
      region: 'California',
      regionCode: 'CA',
    });

    expect(res.status).toBe(204);
    expect(await geoVisitors(at, place)).toBe(before + 1);
    // Reading the region NAME instead of the code lands the member here: the
    // name is not two letters, so it normalises to no state at all. Both
    // assertions are needed — the first catches the member missing from the
    // state it belongs to, this one catches where it went instead.
    expect(await geoVisitors(at, stateless)).toBe(beforeStateless);
  });

  // A client that sends no user agent is not a bot — the bot check answers
  // false for an empty string — so this is a real visitor whose device simply
  // cannot be told apart. It is counted, under the catch-all device family
  // rather than dropped or guessed at.
  it('counts a visitor that sends no user agent, under the unknown device family', async () => {
    const at = nowForKeys();
    const unknownDevice = { country: '', region: '', device: 'other' };
    const beforeVisitors = await visitorsThisHour(at);
    const beforeDevice = await geoVisitors(at, unknownDevice);

    const res = await buildApp().request(
      '/e',
      {
        method: 'POST',
        headers: headersWithoutUserAgent(),
        body: JSON.stringify({ t: 'v', p: KNOWN_PAGE }),
      },
      testEnv
    );

    expect(res.status).toBe(204);
    expect(await visitorsThisHour(at)).toBe(beforeVisitors + 1);
    expect(await geoVisitors(at, unknownDevice)).toBe(beforeDevice + 1);
  });

  // Nothing finer than a US state exists anywhere in this design, so a
  // subdivision reported for any other country is dropped at the beacon.
  it('counts the country but no state for a visitor outside the United States', async () => {
    const at = nowForKeys();
    const country = { country: 'DE', region: '', device: 'desktop' };
    const before = await geoVisitors(at, country);

    const res = await beaconFrom(buildApp(), JSON.stringify({ t: 'v', p: KNOWN_PAGE }), {
      country: 'DE',
      region: 'Bavaria',
      regionCode: 'BY',
    });

    expect(res.status).toBe(204);
    expect(await geoVisitors(at, country)).toBe(before + 1);
    expect(await geoVisitors(at, { country: 'DE', region: 'BY', device: 'desktop' })).toBe(0);
  });

  // A missing key is a deployment defect rather than a runtime condition, and
  // nothing on the page is waiting for the answer — so it is loud.
  it('refuses to count at all when the marketing origin is absent', async () => {
    const app = buildApp();
    const res = await app.request(
      '/e',
      { method: 'POST', headers: headers(), body: JSON.stringify({ t: 'v', p: KNOWN_PAGE }) },
      { ...testEnv, MARKETING_URL: undefined }
    );
    expect(res.status).toBe(500);
  });

  it('refuses to count at all when the hash key is absent', async () => {
    const app = buildApp();
    const res = await app.request(
      '/e',
      { method: 'POST', headers: headers(), body: JSON.stringify({ t: 'v', p: KNOWN_PAGE }) },
      { ...testEnv, GROWTH_HASH_SECRET: undefined }
    );
    expect(res.status).toBe(500);
  });

  // The script proves it returns the latched
  // fields, and this proves the route reports them.
  it('reports every set the write latched as overflowed', async () => {
    const manifest = createGrowthManifest({ stores: stores(), eventIndex: EVENT_INDEX });
    const captureError = vi.fn();
    const app = applyPipeline(new Hono<AppEnv>(), { cache: { policies: ROUTE_CACHE_POLICIES } });
    app.use('*', async (c, next) => {
      bindRequestValue(c, 'redis', overflowingRedis());
      bindRequestValue(c, 'logger', { ...c.var.logger, captureError });
      await next();
    });
    app.route(manifest.basePath, manifest.routes);

    const res = await app.request(
      '/e',
      { method: 'POST', headers: headers(), body: JSON.stringify({ t: 'v', p: KNOWN_PAGE }) },
      testEnv
    );

    expect(res.status).toBe(204);
    expect(captureError).toHaveBeenCalledTimes(2);
    expect(captureError).toHaveBeenCalledWith(expect.any(Error), 'growth_set_overflowed');
    const reported = captureError.mock.calls.map((call) => (call[0] as Error).message);
    expect(reported).toEqual(LATCHED_SETS.map((set) => `growth set reached its ceiling: ${set}`));
  });

  // A counter outage must never break a marketing page: the page gets the same
  // answer, and the loss surfaces on the error channel instead.
  it('answers no content when the counter cannot be reached, and reports it', async () => {
    const manifest = createGrowthManifest({ stores: stores(), eventIndex: EVENT_INDEX });
    const captureError = vi.fn();
    const app = applyPipeline(new Hono<AppEnv>(), { cache: { policies: ROUTE_CACHE_POLICIES } });
    app.use('*', async (c, next) => {
      bindRequestValue(c, 'redis', DEAD_REDIS);
      bindRequestValue(c, 'logger', { ...c.var.logger, captureError });
      await next();
    });
    app.route(manifest.basePath, manifest.routes);

    const res = await app.request(
      '/e',
      { method: 'POST', headers: headers(), body: JSON.stringify({ t: 'v', p: KNOWN_PAGE }) },
      testEnv
    );

    expect(res.status).toBe(204);
    expect(captureError).toHaveBeenCalledWith(expect.any(Error), 'growth_counter_unavailable');
  });

  // The beacon that FILLS the budget is COUNTED, so a report raised only on a
  // refusal never sees a sender sized at exactly the budget: it is refused
  // nothing at all. This is the reply that says the budget just filled.
  it('reports the beacon that filled an address identity budget', async () => {
    const manifest = createGrowthManifest({ stores: stores(), eventIndex: EVENT_INDEX });
    const captureError = vi.fn();
    const app = applyPipeline(new Hono<AppEnv>(), { cache: { policies: ROUTE_CACHE_POLICIES } });
    app.use('*', async (c, next) => {
      bindRequestValue(c, 'redis', scriptedRedis(BEACON_STATUS.countedFull));
      bindRequestValue(c, 'logger', { ...c.var.logger, captureError });
      await next();
    });
    app.route(manifest.basePath, manifest.routes);

    const res = await app.request(
      '/e',
      { method: 'POST', headers: headers(), body: JSON.stringify({ t: 'v', p: KNOWN_PAGE }) },
      testEnv
    );

    expect(res.status).toBe(204);
    expect(captureError).toHaveBeenCalledWith(expect.any(Error), 'growth_visitor_mint_capped');
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  // A counted beacon under a budget that is not full is the ordinary case, and
  // the report must not fire for it.
  it('reports nothing for a beacon counted below the address identity budget', async () => {
    const manifest = createGrowthManifest({ stores: stores(), eventIndex: EVENT_INDEX });
    const captureError = vi.fn();
    const app = applyPipeline(new Hono<AppEnv>(), { cache: { policies: ROUTE_CACHE_POLICIES } });
    app.use('*', async (c, next) => {
      bindRequestValue(c, 'redis', scriptedRedis(BEACON_STATUS.counted));
      bindRequestValue(c, 'logger', { ...c.var.logger, captureError });
      await next();
    });
    app.route(manifest.basePath, manifest.routes);

    const res = await app.request(
      '/e',
      { method: 'POST', headers: headers(), body: JSON.stringify({ t: 'v', p: KNOWN_PAGE }) },
      testEnv
    );

    expect(res.status).toBe(204);
    expect(captureError).not.toHaveBeenCalled();
  });

  // Past the ceiling the address counts nobody it had not already minted, and
  // a drop nothing can see is indistinguishable from a bug — the page's answer
  // is a 204 either way, so this event is the only thing that says one address
  // has taken the whole day's identity budget. Whether that is a sender minting
  // identities or a large shared egress is the operator's call to make, not
  // something this event has decided.
  it('reports the first beacon an address had dropped at its identity ceiling', async () => {
    const manifest = createGrowthManifest({ stores: stores(), eventIndex: EVENT_INDEX });
    const captureError = vi.fn();
    const app = applyPipeline(new Hono<AppEnv>(), { cache: { policies: ROUTE_CACHE_POLICIES } });
    app.use('*', async (c, next) => {
      bindRequestValue(c, 'redis', scriptedRedis(BEACON_STATUS.cappedFirst));
      bindRequestValue(c, 'logger', { ...c.var.logger, captureError });
      await next();
    });
    app.route(manifest.basePath, manifest.routes);

    const res = await app.request(
      '/e',
      { method: 'POST', headers: headers(), body: JSON.stringify({ t: 'v', p: KNOWN_PAGE }) },
      testEnv
    );

    expect(res.status).toBe(204);
    expect(captureError).toHaveBeenCalledWith(expect.any(Error), 'growth_visitor_mint_capped');
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  // The store latches the report, so every later drop that day is silent — an
  // address the throttle admits two beacons a second for is otherwise two
  // Sentry events a second.
  it('reports nothing for a drop the address already reported today', async () => {
    const manifest = createGrowthManifest({ stores: stores(), eventIndex: EVENT_INDEX });
    const captureError = vi.fn();
    const app = applyPipeline(new Hono<AppEnv>(), { cache: { policies: ROUTE_CACHE_POLICIES } });
    app.use('*', async (c, next) => {
      bindRequestValue(c, 'redis', scriptedRedis(BEACON_STATUS.capped));
      bindRequestValue(c, 'logger', { ...c.var.logger, captureError });
      await next();
    });
    app.route(manifest.basePath, manifest.routes);

    const res = await app.request(
      '/e',
      { method: 'POST', headers: headers(), body: JSON.stringify({ t: 'v', p: KNOWN_PAGE }) },
      testEnv
    );

    expect(res.status).toBe(204);
    expect(captureError).not.toHaveBeenCalled();
  });

  // The ceiling is per address, so the identities one address mints have to
  // land under that address rather than under each identity of its own.
  it('files every identity one address mints under that one address', async () => {
    const app = buildApp();
    const address = `203.0.113.9-${crypto.randomUUID()}`;
    const day = growthDayBucket(nowForKeys());

    for (const agent of ['Mozilla/5.0 (One) Chrome/120', 'Mozilla/5.0 (Two) Chrome/121']) {
      const res = await app.request(
        '/e',
        {
          method: 'POST',
          headers: { ...headers(), 'cf-connecting-ip': address, 'user-agent': agent },
          body: JSON.stringify({ t: 'v', p: KNOWN_PAGE }),
        },
        testEnv
      );
      expect(res.status).toBe(204);
    }

    const minted = GROWTH_REDIS_KEYS.mint.buildKey(
      day,
      await dailyAddressId({ secret: SECRET, address, day, set: 'mint' })
    );
    expect(await redis.scard(minted)).toBe(2);
    await redis.del(minted);
  });

  // An unkeyed digest of an address reverses by enumerating IPv4, so a key
  // named by one would file a visitor's codes under its recoverable address.
  it('names no mint key by the unkeyed address digest', async () => {
    const app = buildApp();
    const address = `203.0.113.10-${crypto.randomUUID()}`;
    const day = growthDayBucket(nowForKeys());

    const res = await app.request(
      '/e',
      {
        method: 'POST',
        headers: { ...headers(), 'cf-connecting-ip': address },
        body: JSON.stringify({ t: 'v', p: KNOWN_PAGE }),
      },
      testEnv
    );

    expect(res.status).toBe(204);
    const unkeyed = GROWTH_REDIS_KEYS.mint.buildKey(day, await callerIpIdForAddress(address));
    expect(await redis.exists(unkeyed)).toBe(0);
    await redis.del(
      unkeyed,
      GROWTH_REDIS_KEYS.mint.buildKey(
        day,
        await dailyAddressId({ secret: SECRET, address, day, set: 'mint' })
      )
    );
  });

  // The hash is the one value in this design that must never be written down
  // anywhere but a Redis set member.
  it('writes no log line carrying the visitor hash', async () => {
    const at = nowForKeys();
    const manifest = createGrowthManifest({ stores: stores(), eventIndex: EVENT_INDEX });
    const written: string[] = [];
    const record =
      (level: string) =>
      (msg: string, fields?: unknown): void => {
        written.push(`${level} ${msg} ${JSON.stringify(fields ?? {})}`);
      };
    const app = applyPipeline(new Hono<AppEnv>(), { cache: { policies: ROUTE_CACHE_POLICIES } });
    app.use('*', async (c, next) => {
      bindRequestValue(c, 'logger', {
        ...c.var.logger,
        debug: record('debug'),
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
        captureError: (error: Error) => written.push(`capture ${error.message}`),
      });
      await next();
    });
    app.route(manifest.basePath, manifest.routes);
    const address = `203.0.113.9-${crypto.randomUUID()}`;

    const res = await app.request(
      '/e',
      {
        method: 'POST',
        headers: { ...headers(), 'cf-connecting-ip': address },
        body: JSON.stringify({ t: 'v', p: KNOWN_PAGE }),
      },
      testEnv
    );
    expect(res.status).toBe(204);

    const members = await visitorsToday(at);
    const transcript = written.join('\n');
    expect(members.length).toBeGreaterThan(0);
    for (const hash of members) expect(transcript).not.toContain(hash);
    expect(transcript).not.toContain(address);
  });
});

/**
 * A Redis whose write script answers that two sets latched their overflow flag
 * for the first time. It stands at the same `c.var.redis` seam as the dead
 * client below, and it answers the script's own reply format — the delimited
 * field list — so what this exercises is the route's reading of that reply.
 */
const LATCHED_SETS = ['h:views:/a-full-set', 'd:views:/a-full-set'] as const;

function overflowingRedis(): Redis {
  return scriptedRedis([BEACON_STATUS.counted, ...LATCHED_SETS].join('\u001F'));
}

/**
 * A Redis that holds no cached tag registry and records the keys the write
 * script was handed. The absent registry is what sends the route to the
 * campaigns table for the live tags, and the recorded keys are what say which
 * tag the beacon was filed under.
 */
function expiredRegistryRedis(written: string[]): Redis {
  return {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve('OK'),
    createScript: () => ({
      exec: (keys: readonly string[]) => {
        written.push(...keys);
        return Promise.resolve(BEACON_STATUS.counted);
      },
    }),
  } as unknown as Redis;
}

/**
 * A Redis whose write script answers one fixed reply. It stands at the same
 * `c.var.redis` seam as the dead client below, and it answers the script's own
 * reply format — the delimited field list — so what these cases exercise is the
 * route's reading of that reply.
 */
function scriptedRedis(reply: string): Redis {
  return {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve('OK'),
    createScript: () => ({ exec: () => Promise.resolve(reply) }),
  } as unknown as Redis;
}

/**
 * Every Redis operation rejects, injected at the `c.var.redis` seam rather than
 * by pointing the client at an unreachable host: Upstash's connect, retry and
 * backoff are vendor behaviour and cost seconds per call.
 */
const DEAD_REDIS = new Proxy(
  {},
  {
    get: (_target, property) =>
      property === 'createScript'
        ? () => ({ exec: (): Promise<never> => Promise.reject(new Error('redis unavailable')) })
        : (): Promise<never> => Promise.reject(new Error('redis unavailable')),
  }
) as unknown as Redis;
