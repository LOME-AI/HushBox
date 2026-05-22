import type { Redis } from '@upstash/redis';
import type { RoadmapResponse } from '@hushbox/shared';
import { redisGet, redisSet } from '../../lib/redis-registry.js';
import { getLayoutVersion } from './layout-version.js';

/**
 * Read-through cache for the public roadmap response. Backed by Upstash
 * Redis with a 1 h TTL. Cache key incorporates the runtime layout-version
 * hash so a layout-code change produces a different key on the next
 * worker isolate boot — no manual invalidation needed.
 *
 * If Linear is unreachable, callers receive an error; this cache layer
 * never returns stale data on upstream failure (the design decision was
 * "if it's down, it doesn't work" — keep it simple).
 */
export class RoadmapCache {
  constructor(
    private readonly redis: Redis,
    private readonly teamKey: string
  ) {}

  async get(): Promise<RoadmapResponse | null> {
    const version = await getLayoutVersion();
    return redisGet(this.redis, 'roadmapCache', this.teamKey, version);
  }

  async set(value: RoadmapResponse): Promise<void> {
    const version = await getLayoutVersion();
    await redisSet(this.redis, 'roadmapCache', value, this.teamKey, version);
  }
}
