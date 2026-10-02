import { describe, expect, expectTypeOf, it } from 'vitest';
import { GROWTH_ROUTE_POSTURES } from './rate-limit-posture.js';
import type { GrowthRouteKey } from './rate-limit-posture.js';

describe('GROWTH_ROUTE_POSTURES', () => {
  // A sub-router annotated with a bare `Hono<AppEnv>` widens to `BlankSchema`
  // and erases this slice from `AppType`, which would leave the declaration
  // below satisfying an empty key union with every key it names intact.
  it('derives a non-empty route-key union from the manifest', () => {
    expectTypeOf<GrowthRouteKey>().not.toBeNever();
  });

  it('declares exactly the beacon route', () => {
    expect(Object.keys(GROWTH_ROUTE_POSTURES)).toEqual(['$post /e']);
  });

  it('bounds the beacon by address at the edge and admits it uncounted when the counter cannot answer', () => {
    const posture = GROWTH_ROUTE_POSTURES['$post /e'];
    expect(posture.keyedBy).toEqual(['ip']);
    expect(posture.failure).toBe('open');
    expect(posture.countAtEdge).toBeDefined();
    expect(posture.countedInFlow).toEqual([]);
  });
});
