import { evictUserFromRooms } from '@hushbox/realtime/user-rooms';
import { REALTIME_REDIS_KEYS } from '../../lib/redis/define-key.js';
import { createConversationRoomRealtime } from '../../slices/conversations/index.js';
import type { EvictUserPort } from '../../slices/identity/index.js';
import type { ConversationRoomEnv } from '../../slices/conversations/index.js';
import type { Bindings } from '../../lib/context/app-env.js';
import type { Redis } from '@upstash/redis';

/**
 * Session-revocation eviction (ARCHITECTURE §Streaming & realtime): the PROMPTNESS layer that
 * closes a revoked user's live sockets by fanning out over their Redis
 * active-room set — SMEMBERS of the DO-maintained set, then the ConversationRoom
 * DO client's `evict` per room. Built per caller because both are caller-scoped.
 * Best-effort and total: neither a set-read failure nor a per-room evict failure
 * ever throws or aborts the others, so eviction never fails or blocks the
 * revoke — a socket this fan-out misses (an expired set entry, a failed evict)
 * is cut at its next broadcast by the fail-closed broadcast-time
 * session-liveness check.
 *
 * ONE factory for both revocation paths — the HTTP auth routes and the
 * `session.revoke.v1` handler in the dispatcher DO. They must evict identically:
 * a fan-out that fires from one and not the other leaves live sockets open on
 * whichever path is missed, and the paths are two halves of the same security
 * response.
 *
 * The pure fan-out is `@hushbox/realtime`'s `evictUserFromRooms`, imported from
 * the barrel-free `./user-rooms` subpath: the realtime BARREL value-imports the
 * `cloudflare:workers` DO runtime (unloadable in the node-environment test
 * project), but the `user-rooms` module is pure, so the composition root stays
 * loadable.
 */
export function createEvictUserPort(redis: Redis, env: Bindings): EvictUserPort {
  // Realtime is a BEST-EFFORT subsystem (docs/DECISIONS.md §Deliberate limits): push-eviction is
  // only the PROMPTNESS layer; the guarantee is the fail-closed broadcast-time
  // session-liveness check. A missing CONVERSATION_ROOM binding must therefore
  // degrade to a no-op port here rather than throw. This port is constructed as
  // a handler argument on critical auth routes (logout, 2FA-enable,
  // password-change, recovery, deletion) OUTSIDE their best-effort swallow, so
  // eagerly calling the throwing `createConversationRoomRealtime` would 500 a
  // route that must always be able to revoke a session. `evictUserBestEffort`
  // treats an unreachable fan-out identically, so revocation (the security-
  // critical sessionActive delete + passwordChangedAt watermark) still runs;
  // only the socket-close promptness is lost. The throw stays fatal for chat
  // broadcast — realtime's PRIMARY consumer — where a missing binding is a
  // genuine misconfiguration that must fail loud.
  // `Bindings` is structurally assignable to `ConversationRoomEnv` (the same
  // widening the `createConversationRoomRealtime(env)` call below relies on),
  // which is where the optional binding is declared.
  const realtimeEnv: ConversationRoomEnv = env;
  if (realtimeEnv.CONVERSATION_ROOM === undefined) {
    return { evictUser: (): Promise<void> => Promise.resolve() };
  }
  const realtime = createConversationRoomRealtime(env);
  return {
    evictUser: (userId: string, sessionId?: string): Promise<void> =>
      evictUserFromRooms(
        userId,
        {
          // The set only ever holds conversationId strings (the DO SADDs them).
          listRooms: async (id) => {
            const rooms = await redis.smembers(REALTIME_REDIS_KEYS.userActiveRooms.buildKey(id));
            return rooms.map(String);
          },
          // `evict` returns a Result (never throws for a domain error); the
          // fan-out's per-room try/catch guards only an unexpected throw, keeping
          // each room's eviction independent of the others. Both arms of that
          // Result are dropped deliberately: eviction is the promptness layer, and
          // a room it misses is cut at the next broadcast by the session-liveness
          // check.
          evictRoom: async (conversationId, id, session) => {
            await realtime.evict(conversationId, id, session).match(
              () => undefined,
              () => undefined
            );
          },
        },
        sessionId
      ),
  };
}
