import { describe, expect, expectTypeOf, it } from 'vitest';
import { clear, rateLimitKey } from '../../lib/rate-limit/index.js';
import { reachableFrom } from '../../test-support/rate-limit-reachability.js';
import { scriptedRateLimitRedis } from '../../test-support/rate-limit-double.js';
import { MODEL_WEIGHTS_ROUTE_POSTURES } from './index.js';
import { modelArtifactDownloadIpRateLimit } from './domain/rate-limit.js';
import type { SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { ModelWeightsRouteKey } from './rate-limit-posture.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { Hono } from 'hono';

const DOWNLOAD = '$get /models/:model/:version/:file';

describe('the model-weights posture fragment', () => {
  it('derives a non-empty route-key union from its own manifest', () => {
    expectTypeOf<ModelWeightsRouteKey>().not.toBeNever();
  });

  it('resolves that union to nothing when the sub-router has erased its schema', () => {
    // The matched control for the assertion above: an annotated sub-router
    // widens to `BlankSchema`, the key union collapses to `never`, and a
    // fragment then satisfies its target vacuously. The pair is what makes the
    // first assertion a discrimination rather than a formality.
    expectTypeOf<SliceRouteKey<{ basePath: '/models'; routes: Hono<AppEnv> }>>().toBeNever();
  });

  it('declares at least one route', () => {
    expect(Object.keys(MODEL_WEIGHTS_ROUTE_POSTURES).length).toBeGreaterThan(0);
  });

  it('names one identity on the artifact download, counted at the edge', () => {
    expect(MODEL_WEIGHTS_ROUTE_POSTURES[DOWNLOAD].keyedBy).toStrictEqual(['ip']);
    expect(MODEL_WEIGHTS_ROUTE_POSTURES[DOWNLOAD].countAtEdge?.keyedBy).toStrictEqual(['ip']);
  });

  it('spends the artifact download entry, and no other, on the identity it is given', async () => {
    // The only way to say WHICH entry the capability closed over: the entry
    // itself is unreachable from the published value, so the key its own
    // `buildKey` derives is what names it.
    const { redis, keys } = scriptedRateLimitRedis();
    const edge = MODEL_WEIGHTS_ROUTE_POSTURES[DOWNLOAD].countAtEdge;
    if (edge === undefined) throw new Error('the artifact download declares no edge capability');
    const decision = await edge.count(redis, ['ip-hash']);
    expect(decision.isOk()).toBe(true);
    expect(keys).toStrictEqual([
      rateLimitKey(modelArtifactDownloadIpRateLimit, 'ip-hash')._unsafeUnwrap(),
    ]);
  });

  it('declares closed, so an unspendable counter refuses the download rather than admitting it', () => {
    expect(MODEL_WEIGHTS_ROUTE_POSTURES[DOWNLOAD].failure).toBe('closed');
  });

  it('cites nothing in flow, because this slice counts only at the edge', () => {
    expect(MODEL_WEIGHTS_ROUTE_POSTURES[DOWNLOAD].countedInFlow).toStrictEqual([]);
  });

  it('descends into what the fragment does publish', () => {
    // The positive control for the assertions below: a walk that reached
    // nothing would report every leak absent and read exactly like a clean one.
    expect(reachableFrom(MODEL_WEIGHTS_ROUTE_POSTURES)).toContain('ip');
  });

  it('reaches no registry entry, key builder or key prefix through the barrel', () => {
    const reachable = reachableFrom(MODEL_WEIGHTS_ROUTE_POSTURES);
    expect(reachable).not.toContain(modelArtifactDownloadIpRateLimit);
    expect(reachable).not.toContain(modelArtifactDownloadIpRateLimit.buildKey);
    expect(
      reachable.filter((value) => typeof value === 'string' && value.includes('ratelimit:'))
    ).toStrictEqual([]);
  });

  it('reaches neither cap nor window through the barrel', () => {
    const caps = new Set<number>([
      modelArtifactDownloadIpRateLimit.maxAttempts,
      modelArtifactDownloadIpRateLimit.windowSeconds,
    ]);
    const numbers = reachableFrom(MODEL_WEIGHTS_ROUTE_POSTURES).filter(
      (value) => typeof value === 'number'
    );
    expect(numbers.filter((value) => caps.has(value))).toStrictEqual([]);
  });

  it('reaches exactly one callable through the barrel, and it is not the disarm', () => {
    const callables = reachableFrom(MODEL_WEIGHTS_ROUTE_POSTURES).filter(
      (value) => typeof value === 'function'
    );
    expect(callables).toHaveLength(1);
    expect(callables).not.toContain(clear);
  });
});
