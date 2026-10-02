import { describe, expect, expectTypeOf, it } from 'vitest';
import { clear, rateLimitKey } from '../../lib/rate-limit/index.js';
import { reachableFrom } from '../../test-support/rate-limit-reachability.js';
import { scriptedRateLimitRedis } from '../../test-support/rate-limit-double.js';
import { ADMIN_ROUTE_POSTURES } from './index.js';
import {
  adminAuditSearchRateLimit,
  adminCustomer360RateLimit,
  adminDashboardRateLimit,
  adminFeedbackRateLimit,
  adminJobQueueRateLimit,
  adminNewsletterSubscribersRateLimit,
  adminOpsRateLimit,
  adminSqlPanelRateLimit,
} from './domain/rate-limit.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { AdminRouteKey } from './rate-limit-posture.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { Hono } from 'hono';

const CAPPED_ROUTES = [
  '$get /admin/users/overview',
  '$get /admin/audit',
  '$get /admin/dashboard',
  '$get /admin/jobs',
  '$get /admin/feedback',
  '$get /admin/feedback/:id',
  '$get /admin/newsletter/subscribers',
  '$get /admin/sql',
  '$post /admin/ops/:name/preview',
  '$post /admin/ops/:name/execute',
] as const;

const ENTRIES = [
  adminAuditSearchRateLimit,
  adminCustomer360RateLimit,
  adminDashboardRateLimit,
  adminFeedbackRateLimit,
  adminJobQueueRateLimit,
  adminNewsletterSubscribersRateLimit,
  adminOpsRateLimit,
  adminSqlPanelRateLimit,
];

async function keyTouchedBy(posture: CarriedRoutePosture): Promise<string[]> {
  if (posture.kind !== 'named' || posture.countAtEdge === undefined) {
    throw new Error('the route declares no edge capability');
  }
  const { redis, keys } = scriptedRateLimitRedis();
  const decision = await posture.countAtEdge.count(redis, ['actor-hash']);
  expect(decision.isOk()).toBe(true);
  return keys;
}

describe('the admin posture fragment', () => {
  it('derives a non-empty route-key union from its own manifest', () => {
    expectTypeOf<AdminRouteKey>().not.toBeNever();
  });

  it('resolves that union to nothing when the sub-router has erased its schema', () => {
    // The matched control for the assertion above: an annotated sub-router
    // widens to `BlankSchema`, the key union collapses to `never`, and a
    // fragment then satisfies its target vacuously. The pair is what makes the
    // first assertion a discrimination rather than a formality.
    expectTypeOf<SliceRouteKey<{ basePath: '/admin'; routes: Hono<AppEnv> }>>().toBeNever();
  });

  it('declares at least one route', () => {
    expect(Object.keys(ADMIN_ROUTE_POSTURES).length).toBeGreaterThan(0);
  });

  it('names the admin actor on every volume-capped route, counted at the edge', () => {
    for (const key of CAPPED_ROUTES) {
      expect(ADMIN_ROUTE_POSTURES[key].keyedBy).toStrictEqual(['admin-actor']);
      expect(ADMIN_ROUTE_POSTURES[key].countAtEdge?.keyedBy).toStrictEqual(['admin-actor']);
    }
  });

  it('spends the customer-360 entry on the overview read', async () => {
    // The only way to say WHICH entry a capability closed over: the entries are
    // unreachable from the published value, so the key each `buildKey` derives
    // is what names it. Caps and windows repeat across the entries, so the key
    // is also the only thing telling them apart.
    expect(await keyTouchedBy(ADMIN_ROUTE_POSTURES['$get /admin/users/overview'])).toStrictEqual([
      rateLimitKey(adminCustomer360RateLimit, 'actor-hash')._unsafeUnwrap(),
    ]);
  });

  it('spends the audit-search entry on the audit read', async () => {
    expect(await keyTouchedBy(ADMIN_ROUTE_POSTURES['$get /admin/audit'])).toStrictEqual([
      rateLimitKey(adminAuditSearchRateLimit, 'actor-hash')._unsafeUnwrap(),
    ]);
  });

  it('spends the dashboard entry on the dashboard read', async () => {
    expect(await keyTouchedBy(ADMIN_ROUTE_POSTURES['$get /admin/dashboard'])).toStrictEqual([
      rateLimitKey(adminDashboardRateLimit, 'actor-hash')._unsafeUnwrap(),
    ]);
  });

  it('spends the job-queue entry on the job-queue read', async () => {
    expect(await keyTouchedBy(ADMIN_ROUTE_POSTURES['$get /admin/jobs'])).toStrictEqual([
      rateLimitKey(adminJobQueueRateLimit, 'actor-hash')._unsafeUnwrap(),
    ]);
  });

  it('spends the subscriber entry on the consent-evidence page', async () => {
    expect(
      await keyTouchedBy(ADMIN_ROUTE_POSTURES['$get /admin/newsletter/subscribers'])
    ).toStrictEqual([
      rateLimitKey(adminNewsletterSubscribersRateLimit, 'actor-hash')._unsafeUnwrap(),
    ]);
  });

  it('spends the SQL-panel entry on the panel read', async () => {
    expect(await keyTouchedBy(ADMIN_ROUTE_POSTURES['$get /admin/sql'])).toStrictEqual([
      rateLimitKey(adminSqlPanelRateLimit, 'actor-hash')._unsafeUnwrap(),
    ]);
  });

  it('spends one shared ops entry from preview and execute', async () => {
    // Two routes on ONE entry, as the feedback pair below: an actor's total op
    // activity is bounded across preview and execute together, so preview is
    // not the free half of the pair.
    const preview = await keyTouchedBy(ADMIN_ROUTE_POSTURES['$post /admin/ops/:name/preview']);
    const execute = await keyTouchedBy(ADMIN_ROUTE_POSTURES['$post /admin/ops/:name/execute']);
    expect(preview).toStrictEqual([rateLimitKey(adminOpsRateLimit, 'actor-hash')._unsafeUnwrap()]);
    expect(execute).toStrictEqual(preview);
  });

  it('spends one shared feedback entry from both triage reads', async () => {
    // The inbox page and the detail load are two routes on ONE entry, so both
    // capabilities derive the same key and an actor's triage volume is bounded
    // across the pair rather than per route.
    const inbox = await keyTouchedBy(ADMIN_ROUTE_POSTURES['$get /admin/feedback']);
    const detail = await keyTouchedBy(ADMIN_ROUTE_POSTURES['$get /admin/feedback/:id']);
    expect(inbox).toStrictEqual([
      rateLimitKey(adminFeedbackRateLimit, 'actor-hash')._unsafeUnwrap(),
    ]);
    expect(detail).toStrictEqual(inbox);
  });

  it('cites nothing in flow on any capped route, because this slice counts only at the edge', () => {
    for (const key of CAPPED_ROUTES) {
      expect(ADMIN_ROUTE_POSTURES[key].countedInFlow).toStrictEqual([]);
    }
  });

  it('leaves the uncapped console reads to their route class default', () => {
    const backstopped = new Set(
      Object.entries(ADMIN_ROUTE_POSTURES)
        .filter(([, posture]) => posture.kind === 'default')
        .map(([key]) => key)
    );
    expect(backstopped).toStrictEqual(
      new Set([
        '$get /admin/ops',
        '$get /admin/ops/:name/prefill',
        '$get /admin/newsletter/issues',
        '$post /admin/newsletter/render',
        '$get /admin/newsletter/subscribers/stats',
        '$get /admin/models',
      ])
    );
  });

  it('descends into what the fragment does publish', () => {
    // The positive control for the five assertions below: a walk that reached
    // nothing would report every leak absent and read exactly like a clean one.
    expect(reachableFrom(ADMIN_ROUTE_POSTURES)).toContain('admin-actor');
  });

  it('reaches no registry entry through the barrel', () => {
    const reachable = reachableFrom(ADMIN_ROUTE_POSTURES);
    for (const entry of ENTRIES) expect(reachable).not.toContain(entry);
  });

  it('reaches no key builder through the barrel', () => {
    const reachable = reachableFrom(ADMIN_ROUTE_POSTURES);
    for (const entry of ENTRIES) expect(reachable).not.toContain(entry.buildKey);
  });

  it('reaches no key prefix through the barrel', () => {
    const strings = reachableFrom(ADMIN_ROUTE_POSTURES).filter(
      (value) => typeof value === 'string'
    );
    expect(strings.filter((value) => value.includes('ratelimit:'))).toStrictEqual([]);
  });

  it('reaches neither cap nor window through the barrel', () => {
    const caps = new Set<number>(
      ENTRIES.flatMap((entry) => [entry.maxAttempts, entry.windowSeconds])
    );
    const numbers = reachableFrom(ADMIN_ROUTE_POSTURES).filter(
      (value) => typeof value === 'number'
    );
    expect(numbers.filter((value) => caps.has(value))).toStrictEqual([]);
  });

  it('reaches one callable per capped route, and none of them is the disarm', () => {
    const callables = reachableFrom(ADMIN_ROUTE_POSTURES).filter(
      (value) => typeof value === 'function'
    );
    expect(callables).toHaveLength(CAPPED_ROUTES.length);
    expect(callables).not.toContain(clear);
  });
});
