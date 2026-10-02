import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { createEnvUtilities } from '@hushbox/shared';
import { createCachedSessionVerifier, isTrialRoomSelf } from '@hushbox/realtime';
import {
  configureRateLimitBound,
  configureRateLimitKeySecret,
  rateLimitBound,
} from '../../../lib/rate-limit/index.js';
import { createBoundedRedis } from '../../../lib/resilience/index.js';
import { REALTIME_REDIS_KEYS } from '../../../lib/redis/define-key.js';
import { createDurableObjectTelemetry } from '../../../lib/telemetry/index.js';
import { createDbMembershipSource, createRedisMembershipCache } from './membership.js';
import { composeMembershipVerifier } from './membership-verifier.js';
import { createEpochPublicKeyReader } from './epoch-reads.js';
import { createPushMembershipReader } from './push-membership-reader.js';
import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { SessionLiveness } from '../../../lib/context/index.js';
import type {
  ClaimRun,
  EnvUtilities,
  FlowExecutor,
  FlowHoldIdentity,
  RunFence,
} from '@hushbox/shared';
import type {
  MembershipSource,
  MembershipVerifier,
  RoomBindings,
  RoomNotify,
  RoomTelemetry,
  SessionSnapshot,
  SessionSource,
  SessionVerifier,
  UserRoomTracker,
} from '@hushbox/realtime';
import type { Bindings } from '../../../lib/context/index.js';
import type { DurableObjectTelemetryOptions, Telemetry } from '../../../lib/telemetry/index.js';
import type { PushMembershipReader } from './push-membership-reader.js';

/**
 * The worker-side dependency set for the ConversationRoom DO. This adapter is
 * an infra edge: it composes the membership verifier (Redis cache +
 * authoritative DB source — rationale in membership.ts), opens the DO's
 * connections, and supplies the `epochs` read the settlement wraps to. The DO
 * RUNTIME (executor + policy-hook binder + run referee) needs the
 * workflows/models/billing barrels, which the architecture permits only in a
 * domain layer, so it is INJECTED here as `createRuntime` — the chat slice's
 * conversation-runtime factory, wired by the composition root
 * (src/composition/conversation-room.ts). The adapter therefore imports no
 * chat/workflows/billing barrel and boundaries hold with no rule relaxation.
 */

/**
 * Per-stream replay budget. A stream's replay size follows its delta count,
 * not its duration: each text delta meters its serialized frame, an envelope
 * of about 110 bytes plus its content, so 2 MiB replays a text reply of
 * roughly 19,000 short deltas. It bounds what any ONE stream retains — the
 * total a run retains across its streams is bounded separately by
 * {@link REALTIME_MAX_RUN_BYTES}. Replay overflow answers the explicit
 * stream-gone signal and the client falls back to fetch-after-settlement.
 */
const REALTIME_MAX_STREAM_BYTES = 2_097_152;

/**
 * Run-total replay budget across every stream of one run — the axis the
 * per-stream cap cannot bound, because nothing limits how many streams a run
 * opens. Metered bytes, whose real cost is larger: frames are counted
 * serialized but retained as objects, so read this under the same ≥3×
 * real-memory multiplier `VALUE_STORE_BYTE_BUDGET_BYTES` assumes. The ceiling
 * follows from the isolate the room shares with the run: 128 MB, of which the
 * ValueStore already reserves ~60 MB real at that multiplier, leaving replay a
 * run-total in the low tens of MB real once the DO's own runtime and socket
 * state are covered. The floor is what shipped chat must never lose — a turn
 * opens one stream per source the wire admits (`MAX_SELECTED_MODELS`), each
 * bounded by {@link REALTIME_MAX_STREAM_BYTES} — and this affords all of them,
 * pinned by a test. Crossing the budget evicts whole streams to the same
 * stream-gone signal the per-stream cap answers with.
 */
const REALTIME_MAX_RUN_BYTES = 12_582_912;

/** The `epochs` read the injected runtime's settlement hook wraps content to. */
type RoomEpochPublicKeyReader = (
  tx: DbWriter,
  conversationId: string,
  epochNumber: number
) => Promise<Uint8Array | null>;

/**
 * The DO runtime the room binds. Structurally the chat slice's
 * `ConversationRuntime`; typed here from shared and room primitives only, so the
 * adapter never imports the chat barrel. Its binder is the room's own, so a
 * runtime whose bindings drop the answer ids the room returns does not compile.
 */
export interface RoomRuntime {
  readonly executor: FlowExecutor;
  readonly bindHooks: RoomBindings['bindHooks'];
  readonly claimRun: ClaimRun;
  /** Terminal-sink money/lease duties (chat runtime supplies them; all best-effort). */
  readonly releaseHold: (hold: FlowHoldIdentity) => Promise<void>;
  readonly heartbeat: (fence: RunFence) => Promise<'alive' | 'lost'>;
  readonly failRun: (fence: RunFence) => Promise<void>;
}

/** Infra the adapter builds and hands the injected runtime factory. */
export interface RoomRuntimeDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly telemetry: Telemetry;
  readonly env: Bindings;
  readonly readEpochPublicKey: RoomEpochPublicKeyReader;
}

export type CreateRoomRuntime = (deps: RoomRuntimeDeps) => RoomRuntime;

/** Maps the room's closed telemetry event set onto the typed Telemetry port. */
export function createRoomTelemetry(telemetry: Telemetry): RoomTelemetry {
  return {
    runStarted: (fields) => {
      telemetry.info('realtime run started', fields);
    },
    runFinished: (fields) => {
      telemetry.info('realtime run finished', fields);
    },
    runRejected: (fields) => {
      telemetry.warn('realtime run rejected', fields);
    },
    deadlineFired: (fields) => {
      telemetry.warn('realtime run deadline fired', fields);
    },
    principalEvicted: (fields) => {
      telemetry.warn('realtime principal evicted at broadcast', fields);
    },
    deliveryPaused: (fields) => {
      telemetry.warn('realtime delivery paused', fields);
    },
    deliveryFailed: (fields) => {
      telemetry.warn('realtime delivery failed', fields);
    },
    // Warn, like the pause it closes: the resume line is only worth anything
    // beside its pause, so a level filter that surfaces one surfaces both.
    deliveryResumed: (fields) => {
      telemetry.warn('realtime delivery resumed', fields);
    },
    clientMessageRejected: (fields) => {
      telemetry.warn('realtime client message rejected', fields);
    },
    // Neither line has a watcher and nothing reads either. The
    // upgrade-failure line fires on the room's own attachment parse rather
    // than on a client blocked upstream, so no upgrade-failure rate derives
    // from it; the per-generation line carries the generationId (plus runId to
    // group the run and conversationId to scope it) that a killed run's absent
    // usage_records row would have needed, which leaves that run's provider
    // spend unreconcilable after the fact.
    upgradeRejected: (fields) => {
      telemetry.warn('realtime ws upgrade rejected', fields);
    },
    billableGeneration: (fields) => {
      telemetry.info('realtime billable generation', fields);
    },
  };
}

/**
 * The default runtime factory: the room is unusable until the app root injects
 * the chat conversation-runtime. A fail-fast here names the missing wiring
 * rather than degrading (the executor/binder/referee cannot live in this
 * infra adapter — boundaries).
 */
function throwUnwiredRuntime(): RoomRuntime {
  throw new Error(
    'ConversationRoom runtime not injected — the app root must pass the chat ' +
      'conversation-runtime factory into createRoomBindings(env, createRuntime).'
  );
}

/** Fail-fast on the DO's own required bindings (dispatcher-bindings precedent). */
function requiredRoomBinding(env: Bindings, name: keyof Bindings): string {
  const value = env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `ConversationRoom: missing required binding ${name}. ` +
        'Set it in wrangler config / .dev.vars — the room fails fast instead of degrading.'
    );
  }
  return value;
}

/** Local dev routes through the Neon proxy; production connects directly. */
export function openRoomSourceDb(
  databaseUrl: string,
  envUtilities: Pick<EnvUtilities, 'isDev'>
): Database {
  return envUtilities.isDev
    ? createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })
    : createDb(databaseUrl);
}

/**
 * Authoritative membership over a fresh Neon connection per check, closed
 * when the read ends — a hibernating room must hold no idle sockets across
 * its lifetime, and the verifier only reaches this source on a cache miss.
 */
function createRoomMembershipSource(
  databaseUrl: string,
  envUtilities: EnvUtilities
): MembershipSource {
  return {
    isMember: async (conversationId: string, principalId: string): Promise<boolean> => {
      const db = openRoomSourceDb(databaseUrl, envUtilities);
      try {
        return await createDbMembershipSource(db).isMember(conversationId, principalId);
      } finally {
        await db.$client.end();
      }
    },
  };
}

/**
 * Wraps the authoritative membership verifier with the trial-room carve-out: a
 * trial session is authorized to stream ONLY its own trial room (the DO whose
 * id is the session's sentinel-prefixed principal id). Every other pair —
 * including a trial principal addressing a different room and every
 * conversation member — falls through to the DB-backed verifier, so no trial
 * principal can ever open a conversation room and no member's gating is
 * loosened. Scoped tightly by construction: `isTrialRoomSelf` matches only
 * prefix-equal ids, which a bare conversation/user uuid never satisfies.
 */
export function composeTrialAwareVerifier(inner: MembershipVerifier): MembershipVerifier {
  return {
    verify: (conversationId, principalId) =>
      isTrialRoomSelf(conversationId, principalId)
        ? Promise.resolve('member')
        : inner.verify(conversationId, principalId),
  };
}

/**
 * The Redis-backed per-user active-room set the DO SADDs on WS accept and SREMs
 * on a user's last-socket close (ARCHITECTURE §Streaming & realtime). `track` refreshes the 24h
 * crash-orphan backstop TTL on every add so a live connection's set never
 * expires out from under it; `untrack` removes only the one closed room. The
 * DO's RoomCore decides which sockets are trackable (real users only — guests
 * and trial principals are skipped before this ever runs).
 */
export function createRedisUserRoomTracker(redis: Redis): UserRoomTracker {
  const definition = REALTIME_REDIS_KEYS.userActiveRooms;
  return {
    track: async (userId: string, conversationId: string): Promise<void> => {
      const key = definition.buildKey(userId);
      await redis.sadd(key, conversationId);
      await redis.expire(key, definition.ttlSeconds);
    },
    untrack: async (userId: string, conversationId: string): Promise<void> => {
      await redis.srem(definition.buildKey(userId), conversationId);
    },
  };
}

/**
 * Identity's published session-liveness read (`checkSessionLiveness`), injected
 * so the conversations adapter reuses the revocation semantics without
 * importing the identity barrel (a boundary the composition root crosses). The
 * shape matches identity's export exactly.
 */
export type RoomSessionLivenessCheck = (
  redis: Redis,
  inputs: { readonly userId: string; readonly sessionId: string; readonly createdAt: number }
) => ResultAsync<SessionLiveness, DomainError>;

/**
 * Session-liveness window sizing (mirrors the membership verifier): a 2 s
 * in-memory reuse window bounds source reads to at most one per session per
 * window (never per token), and a 15 s last-known-good window fails delivery
 * closed — pausing rather than risking plaintext to a possibly-revoked socket.
 */
const SESSION_LIVENESS_FRESHNESS_MS = 2000;
const SESSION_LIVENESS_LAST_KNOWN_GOOD_MS = 15_000;

/**
 * Composes the broadcast-time session-liveness verifier from identity's
 * injected read. The source rejects (never resolves) on a store failure so the
 * verifier's fail-closed fallback engages — Redis down pauses delivery, exactly
 * like the membership verifier.
 */
export function composeSessionVerifier(
  redis: Redis,
  check: RoomSessionLivenessCheck,
  now: () => number = () => Date.now()
): SessionVerifier {
  const source: SessionSource = {
    liveness: (snapshot: SessionSnapshot) =>
      check(redis, {
        userId: snapshot.userId,
        sessionId: snapshot.sessionId,
        createdAt: snapshot.sessionCreatedAt,
      }).match(
        (state) => (state === 'active' ? 'live' : 'revoked'),
        (error) => {
          throw new Error(`session liveness unavailable: ${error.code}`, { cause: error });
        }
      ),
  };
  return createCachedSessionVerifier({
    source,
    freshnessMs: SESSION_LIVENESS_FRESHNESS_MS,
    lastKnownGoodMs: SESSION_LIVENESS_LAST_KNOWN_GOOD_MS,
    now,
  });
}

/** Infra the room composes and hands the injected push-notify factory. */
export interface PushNotifyCompositionDeps {
  readonly env: Bindings;
  readonly db: Database;
  readonly telemetry: Telemetry;
  readonly membership: PushMembershipReader;
}

/**
 * Builds the room's push capability from composed infra. Injected (like the
 * runtime factory) because the composition needs the notifications barrel,
 * which a conversations adapter may not import — the composition root supplies
 * it (`apps/api/src/composition/push-notify.ts`).
 */
export type PushNotifyFactory = (deps: PushNotifyCompositionDeps) => RoomNotify;

/**
 * The room's optional injections. Grouped rather than positional because the
 * composition root supplies some and not others, and a caller wanting only the
 * last one would otherwise pass a run of `undefined`s.
 */
interface RoomInjections {
  /** Identity's published session-liveness read — see {@link RoomSessionLivenessCheck}. */
  readonly sessionLiveness?: RoomSessionLivenessCheck;
  /** The notifications-barrel push composition — see {@link PushNotifyFactory}. */
  readonly createNotify?: PushNotifyFactory;
  /** Telemetry sink overrides; production composes every sink from `env`. */
  readonly telemetryOptions?: DurableObjectTelemetryOptions;
}

export function createRoomBindings(
  env: Bindings,
  createRuntime: CreateRoomRuntime = throwUnwiredRuntime,
  injections: RoomInjections = {}
): RoomBindings {
  const { sessionLiveness, createNotify, telemetryOptions = {} } = injections;
  const databaseUrl = requiredRoomBinding(env, 'DATABASE_URL');
  const redisUrl = requiredRoomBinding(env, 'UPSTASH_REDIS_REST_URL');
  const redisToken = requiredRoomBinding(env, 'UPSTASH_REDIS_REST_TOKEN');
  const envUtilities = createEnvUtilities(env);
  // The room isolate has no request pipeline, so the bound on one round trip
  // to this store is put in force here, from this env's registry entry, and
  // read back for the client that runs under it. Both readers need it: the
  // client bounds every command, and a counter check the room reaches would
  // otherwise throw instead of counting. The identifier key is put in force
  // beside it, for the same counter check.
  configureRateLimitBound(env);
  configureRateLimitKeySecret(env);
  const redis = createBoundedRedis(
    { url: redisUrl, token: redisToken },
    rateLimitBound().timeoutMs
  );
  const telemetry = createDurableObjectTelemetry(env, telemetryOptions);
  // One DO-scoped connection backs the executor, referee, and settlement (the
  // membership verifier keeps its own open-then-close-per-check connection).
  const runtimeDb = openRoomSourceDb(databaseUrl, envUtilities);
  const runtime = createRuntime({
    db: runtimeDb,
    redis,
    telemetry,
    env,
    readEpochPublicKey: createEpochPublicKeyReader(),
  });
  return {
    executor: runtime.executor,
    verifier: composeTrialAwareVerifier(
      composeMembershipVerifier({
        cache: createRedisMembershipCache(redis),
        source: createRoomMembershipSource(databaseUrl, envUtilities),
      })
    ),
    // The broadcast-time session-liveness backstop, composed exactly like the
    // membership verifier when the composition root injects identity's read.
    ...(sessionLiveness === undefined
      ? {}
      : { sessionVerifier: composeSessionVerifier(redis, sessionLiveness) }),
    telemetry: createRoomTelemetry(telemetry),
    claimRun: runtime.claimRun,
    bindHooks: runtime.bindHooks,
    maxStreamBytes: REALTIME_MAX_STREAM_BYTES,
    maxRunBytes: REALTIME_MAX_RUN_BYTES,
    now: () => Date.now(),
    newRunId: () => crypto.randomUUID(),
    releaseHold: runtime.releaseHold,
    heartbeat: runtime.heartbeat,
    failRun: runtime.failRun,
    // The DO records/removes a real user's live rooms here so a session
    // revocation can fan an eviction out to exactly them (ARCHITECTURE §Streaming & realtime).
    userRooms: createRedisUserRoomTracker(redis),
    // The post-settlement push side-band, composed exactly like the session
    // verifier when the composition root injects the notify factory. The
    // membership read is this slice's own table; the factory supplies the
    // notifications-barrel wiring the adapter may not import.
    ...(createNotify === undefined
      ? {}
      : {
          notify: createNotify({
            env,
            db: runtimeDb,
            telemetry,
            membership: createPushMembershipReader(runtimeDb),
          }),
        }),
  };
}
