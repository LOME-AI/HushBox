import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from '@upstash/redis';
import { roadmapResponseSchema, type RoadmapResponse } from '@hushbox/shared';
import { RoadmapCache } from './cache.js';
import { getLayoutVersion } from './layout-version.js';

interface RedisCall {
  op: 'get' | 'set';
  key: string;
  value?: unknown;
  options?: unknown;
}

function makeStubRedis(): { redis: Redis; calls: RedisCall[]; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const calls: RedisCall[] = [];
  const redis = {
    get: async (key: string) => {
      calls.push({ op: 'get', key });
      return store.has(key) ? store.get(key) : null;
    },
    set: async (key: string, value: unknown, options: unknown) => {
      calls.push({ op: 'set', key, value, options });
      store.set(key, value);
      return 'OK';
    },
  } as unknown as Redis;
  return { redis, calls, store };
}

const validId = '0123456789ab';

function makeResponse(): RoadmapResponse {
  return roadmapResponseSchema.parse({
    graph: {
      nodes: [
        {
          id: validId,
          kind: 'project',
          parentId: null,
          title: 'P',
          status: 'in_progress',
          type: null,
          color: '#ec4755',
        },
      ],
      edges: [],
    },
    layouts: {
      wide: {
        viewBox: [0, 0, 100, 100],
        positions: { [validId]: { x: 50, y: 50, r: 10 } },
        bfsOrder: [[validId]],
      },
    },
  });
}

describe('RoadmapCache', () => {
  let stub: ReturnType<typeof makeStubRedis>;
  beforeEach(() => {
    stub = makeStubRedis();
  });

  it('returns null on a cold cache', async () => {
    const cache = new RoadmapCache(stub.redis, 'HUS');
    expect(await cache.get()).toBeNull();
  });

  it('writes the response under a key including the layout version', async () => {
    const cache = new RoadmapCache(stub.redis, 'HUS');
    const response = makeResponse();
    await cache.set(response);
    const version = await getLayoutVersion();
    expect(stub.store.has(`roadmap:hus:${version}`)).toBe(true);
  });

  it('lowercases the team key for consistency', async () => {
    const cache = new RoadmapCache(stub.redis, 'HUS');
    await cache.set(makeResponse());
    const lower = new RoadmapCache(stub.redis, 'hus');
    const value = await lower.get();
    expect(value).not.toBeNull();
  });

  it('round-trips a response through get/set', async () => {
    const cache = new RoadmapCache(stub.redis, 'HUS');
    const response = makeResponse();
    await cache.set(response);
    const retrieved = await cache.get();
    expect(retrieved).toEqual(response);
  });

  it('uses a 1h TTL on writes', async () => {
    const cache = new RoadmapCache(stub.redis, 'HUS');
    await cache.set(makeResponse());
    const setCall = stub.calls.find((c) => c.op === 'set');
    expect(setCall?.options).toEqual({ ex: 60 * 60 });
  });

  it('the cache key differs from other tenants', async () => {
    const a = new RoadmapCache(stub.redis, 'HUS');
    const b = new RoadmapCache(stub.redis, 'OTHER');
    await a.set(makeResponse());
    expect(await b.get()).toBeNull();
  });
});
