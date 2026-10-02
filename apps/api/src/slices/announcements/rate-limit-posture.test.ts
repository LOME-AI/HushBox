import { describe, expect, expectTypeOf, it } from 'vitest';
import { ANNOUNCEMENTS_ROUTE_POSTURES } from './index.js';
import { reachableFrom } from '../../test-support/rate-limit-reachability.js';
import type { SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { AnnouncementsRouteKey } from './rate-limit-posture.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { Hono } from 'hono';

describe('the announcements posture fragment', () => {
  it('derives a non-empty route-key union from its own manifest', () => {
    expectTypeOf<AnnouncementsRouteKey>().not.toBeNever();
  });

  it('resolves that union to nothing when the sub-router has erased its schema', () => {
    // The matched control for the assertion above: an annotated sub-router
    // widens to `BlankSchema`, the key union collapses to `never`, and a
    // fragment then satisfies its target vacuously. The pair is what makes the
    // first assertion a discrimination rather than a formality.
    expectTypeOf<SliceRouteKey<{ basePath: '/announcements'; routes: Hono<AppEnv> }>>().toBeNever();
  });

  it('declares at least one route', () => {
    expect(Object.keys(ANNOUNCEMENTS_ROUTE_POSTURES).length).toBeGreaterThan(0);
  });

  it('backstops every route by its route class, naming no counter and no exemption', () => {
    // The first fragment in the migration whose every route is `default`:
    // there is no exempt arm to carry an obligation and no entry to bind, so
    // the whole declaration is three keys and one kind.
    expect(ANNOUNCEMENTS_ROUTE_POSTURES).toStrictEqual({
      '$get /announcements/banner': { kind: 'default', failure: 'open' },
      '$get /announcements/banner/dismissal': { kind: 'default', failure: 'open' },
      '$put /announcements/banner/dismissal': { kind: 'default', failure: 'open' },
    });
  });

  it('descends into what the fragment does publish', () => {
    // The positive control for the three assertions below: a walk that reached
    // nothing would report every leak absent and read exactly like a clean one.
    expect(reachableFrom(ANNOUNCEMENTS_ROUTE_POSTURES)).toContain('default');
  });

  it('reaches no callable at all, so nothing on it can spend or clear a window', () => {
    const reachable = reachableFrom(ANNOUNCEMENTS_ROUTE_POSTURES);
    expect(reachable.filter((value) => typeof value === 'function')).toStrictEqual([]);
  });

  it('reaches no key prefix', () => {
    const strings = reachableFrom(ANNOUNCEMENTS_ROUTE_POSTURES).filter(
      (value) => typeof value === 'string'
    );
    expect(strings.filter((value) => value.includes('ratelimit:'))).toStrictEqual([]);
  });

  it('reaches no number, so it carries neither cap nor window', () => {
    const reachable = reachableFrom(ANNOUNCEMENTS_ROUTE_POSTURES);
    expect(reachable.filter((value) => typeof value === 'number')).toStrictEqual([]);
  });
});
