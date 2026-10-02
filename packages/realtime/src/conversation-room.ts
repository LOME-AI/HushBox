// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- The Cloudflare Workers ambient runtime (the `cloudflare:workers` module + DO globals) has no importable module form; the published `@cloudflare/workers-types` is a global script whose DOM redefinitions break a browser-DOM consumer (apps/web type-checks this source through the typed API client). A path reference to a minimal local ambient shim is the only mechanism that carries the runtime into that consumer's program without polluting its DOM lib.
/// <reference path="./cloudflare-workers.d.ts" />
import { DurableObject } from 'cloudflare:workers';
import { ERROR_CODES, WS_HEARTBEAT_PING_MESSAGE, WS_HEARTBEAT_PONG_MESSAGE } from '@hushbox/shared';
import { realtimeEventSchema } from './events.js';
import { RoomCore, resolveConversationId } from './room-core.js';
import { SingleFlight } from './single-flight.js';
import {
  DECLARED_CURSORS_PARAM,
  evictBodySchema,
  parseStreamCursors,
  runStartBodySchema,
  runStopBodySchema,
  socketAttachmentSchema,
} from './protocol.js';
import type {
  ClaimRun,
  ErrorCode,
  FlowExecutor,
  FlowHoldIdentity,
  FlowStartRequest,
  RunContext,
  RunFence,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { RoomHookBindings, RoomNotify, RoomSocket } from './room-core.js';
import type { MembershipVerifier } from './revocation.js';
import type { SessionVerifier } from './session-liveness.js';
import type { RoomTelemetry } from './telemetry.js';
import type { UserRoomTracker } from './user-rooms.js';

/**
 * The composition seam: the worker binds the executor, the membership
 * verifier, telemetry, the hook binder, and the clock/rng — packages never
 * import apps. The factory below closes the DO class over these bindings;
 * the worker entry re-exports the bound class for the wrangler DO binding.
 */
export interface RoomBindings {
  readonly executor: FlowExecutor;
  readonly verifier: MembershipVerifier;
  /**
   * The broadcast-time session-liveness backstop: closes the
   * push-eviction under-inclusion window by cutting a socket whose authorizing
   * session was revoked, even while its principal remains a member. Optional
   * until the worker injects identity's session-liveness read (composed in
   * createRoomBindings, exactly like the membership verifier).
   */
  readonly sessionVerifier?: SessionVerifier;
  readonly telemetry: RoomTelemetry;
  /** Claims the durable run referee before start, capturing the settlement fence. */
  readonly claimRun: ClaimRun;
  /** Resolves a definition's named policy hooks, closing them over the run context. */
  readonly bindHooks: (context: RunContext, definition: WorkflowDefinition) => RoomHookBindings;
  readonly maxStreamBytes: number;
  readonly maxRunBytes: number;
  readonly now: () => number;
  readonly newRunId: () => string;
  /** Releases an admission hold at the run's terminal sink (best-effort). */
  readonly releaseHold: (hold: FlowHoldIdentity) => Promise<void>;
  /** Fenced key-row lease touch for the live run ('lost' = superseded by a retry). */
  readonly heartbeat: (fence: RunFence) => Promise<'alive' | 'lost'>;
  /** Fenced `claimed → failed` flip for a run that terminated without settling. */
  readonly failRun: (fence: RunFence) => Promise<void>;
  /**
   * The per-user active-room set writer (ARCHITECTURE §Streaming & realtime): the DO SADDs on WS
   * accept and SREMs when a user's last socket in the room closes, so a session
   * revocation can fan an eviction out to exactly the rooms the user occupies.
   * Optional until the worker wires the Redis-backed tracker.
   */
  readonly userRooms?: UserRoomTracker;
  /**
   * Best-effort push for a persisted new message, fired at the terminal sink of
   * a succeeded paid run. Optional until the composition root injects the push
   * capability (composed in createRoomBindings from the notifications barrel,
   * which slice adapters may not import — so the factory is injected).
   */
  readonly notify?: RoomNotify;
}

/**
 * DO-storage key under which requested held-stream releases are latched. The
 * value names the RUN KEY the releases were issued against and how many have
 * been granted (`<runKey>#<count>`), never a bare flag: the DO is one per
 * conversation but a conversation runs many turns, so a scope wider than the
 * run would silently stop parking every run after the first, and a scope that
 * forgot the count would free every park of a run that parks more than once.
 * Latching makes the dev/E2E release order- and instance-independent — a
 * release naming a run that has not started (or one whose resolver died with a
 * prior instance) persists here, and that run frees the moment it parks. A
 * value naming the run alone grants its first park, which is what an instance
 * that predates the count left behind. Only ever written in dev/E2E (no
 * production run carries `mockDirectives`).
 */
export const HELD_STREAM_RELEASE_STORAGE_KEY = 'heldStreamReleaseRequested';

/** The lazily-built pieces that require the DO's resolved identity. */
interface RoomShellState {
  readonly core: RoomCore;
  readonly conversationId: string;
}

type ConversationRoomClass<Env> = new (ctx: DurableObjectState, env: Env) => DurableObject<Env>;

/**
 * The in-memory-only held-stream release awaitable, declared once for both ends of
 * the seam: the DO attaches it and the chat runtime intersects this same type to
 * read it. Dev/E2E plumbing that rides the in-process executor wiring, NEVER the
 * wire protocol — the DO attaches it only for a `holdPrimaryStream` run. Never
 * present in production: no production run carries `mockDirectives`.
 */
export interface HeldStreamRelease {
  readonly awaitStreamRelease?: () => Promise<void>;
}

/** The executor start request as the DO hands it to the runtime. */
export type HeldStreamStartRequest = FlowStartRequest & HeldStreamRelease;

/** The live held-stream run: the parks it has reached and the gate freeing the current one. */
interface HeldStreamSlot {
  readonly runKey: string;
  parks: number;
  gate: Promise<void>;
  resolve: () => void;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Error bodies only carry registry codes — a non-registry literal fails to compile. */
function errorResponse(code: ErrorCode, status: number): Response {
  return jsonResponse({ code }, status);
}

/**
 * Thin-shell Durable Object (the arch pattern: a DO class contains only
 * platform glue). Every behavior — broadcast gating, replay, presence,
 * run control — lives in the plain RoomCore the node project covers; this
 * class only adapts platform WebSockets, storage alarms, and HTTP routing.
 */
export function createConversationRoomClass<Env>(
  createBindings: (env: Env) => RoomBindings
): ConversationRoomClass<Env> {
  return class ConversationRoom extends DurableObject<Env> {
    private readonly bindings: RoomBindings;
    // Single-flighted: `ctx.id.name` is absent when the platform reconstructs
    // this DO for an alarm fire or hibernation wake, so the core cannot be
    // built in the constructor — its conversation id is resolved (and
    // persisted) lazily on first use, exactly like the JobDispatcher. A build
    // that fails is not remembered, so a bad first attempt does not leave this
    // instance refusing everything until eviction.
    private readonly lazyRoom = new SingleFlight<RoomShellState>(this.buildRoom.bind(this));
    /** Stable per-WebSocket wrappers: RoomCore compares sockets by identity. */
    private readonly wrappers = new WeakMap<WebSocket, RoomSocket>();
    /**
     * The dev/E2E held-stream barrier: the currently-held primary stream's run
     * key, the parks it has reached and the gate freeing the park it is on, or
     * null when nothing is held. A single per-DO slot (one run per
     * conversation), set only for a `holdPrimaryStream` run — which only ever
     * exists in dev/E2E (no production run carries `mockDirectives`), so this
     * stays null in production by construction. Carrying the run key is what
     * lets the release route free exactly the run it names and lets a release
     * that names nothing free the run this instance actually holds.
     */
    private heldStreamRelease: HeldStreamSlot | null = null;
    /**
     * Every release waiting for the run it freed to reach its next park or end.
     * That wait is what makes the release route's return mean "the stream has
     * advanced", so a caller learns it from the response rather than from a
     * clock. A list rather than one slot because a retried release puts two of
     * them in flight against the same run, and a slot would leave the first
     * with nothing to answer it.
     */
    private heldStreamAdvance: {
      readonly runKey: string;
      readonly parks: number;
      readonly settle: () => void;
    }[] = [];

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      this.bindings = createBindings(env);
      // Idle-keepalive heartbeat: the client sends the ping on each heartbeat
      // tick; the Workers runtime auto-replies the pong WITHOUT invoking
      // webSocketMessage (no peer broadcast, no exit from hibernation), so an
      // idle-but-alive socket never trips the client's half-open timeout.
      // Registration is passive (no timers), so a zero-client room still hibernates.
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(WS_HEARTBEAT_PING_MESSAGE, WS_HEARTBEAT_PONG_MESSAGE)
      );
    }

    private ensureRoom(): Promise<RoomShellState> {
      return this.lazyRoom.get();
    }

    private async buildRoom(): Promise<RoomShellState> {
      const conversationId = await resolveConversationId(this.ctx.id.name, {
        get: (key) => this.ctx.storage.get<string>(key),
        put: (key, value) => this.ctx.storage.put(key, value),
      });
      // Wrap the injected executor so a `holdPrimaryStream` run gets the DO-owned
      // release barrier threaded into its start request (in-process only, never
      // the wire). Every other run passes through untouched.
      const baseExecutor = this.bindings.executor;
      const heldStreamExecutor: FlowExecutor = {
        start: (request) => {
          const held = this.attachHeldStreamRelease(request);
          const handle = baseExecutor.start(held);
          if (held.awaitStreamRelease !== undefined) {
            this.endHeldStreamWithRun(held.runKey, handle.done);
          }
          return handle;
        },
      };
      const core = new RoomCore({
        conversationId,
        executor: heldStreamExecutor,
        // Route RoomCore's terminal duties and run-continuation watcher through
        // the platform's post-response flush so a deploy/eviction cannot drop a
        // best-effort duty mid-flight; without this the core falls back to bare
        // `void` and the guarantee is inert.
        waitUntil: (promise) => {
          this.ctx.waitUntil(promise);
        },
        verifier: this.bindings.verifier,
        ...(this.bindings.sessionVerifier === undefined
          ? {}
          : { sessionVerifier: this.bindings.sessionVerifier }),
        telemetry: this.bindings.telemetry,
        scheduler: {
          setAlarm: (at) => this.ctx.storage.setAlarm(at),
          deleteAlarm: () => this.ctx.storage.deleteAlarm(),
        },
        claimRun: this.bindings.claimRun,
        bindHooks: this.bindings.bindHooks,
        maxStreamBytes: this.bindings.maxStreamBytes,
        maxRunBytes: this.bindings.maxRunBytes,
        now: this.bindings.now,
        newRunId: this.bindings.newRunId,
        sockets: () => this.ctx.getWebSockets().map((socket) => this.wrap(socket)),
        releaseHold: this.bindings.releaseHold,
        heartbeat: this.bindings.heartbeat,
        failRun: this.bindings.failRun,
        ...(this.bindings.userRooms === undefined ? {} : { userRooms: this.bindings.userRooms }),
        ...(this.bindings.notify === undefined ? {} : { notify: this.bindings.notify }),
      });
      return { core, conversationId };
    }

    override async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      switch (`${request.method} ${url.pathname}`) {
        case 'GET /websocket': {
          return this.upgrade(url);
        }
        case 'POST /broadcast': {
          return this.broadcastRoute(request);
        }
        case 'POST /evict': {
          return this.evictRoute(request);
        }
        case 'GET /presence': {
          const { core } = await this.ensureRoom();
          return jsonResponse({ userIds: core.presenceSnapshot() });
        }
        case 'POST /run/start': {
          return this.runStartRoute(request);
        }
        case 'POST /run/stop': {
          return this.runStopRoute(request);
        }
        case 'POST /mock/release-stream': {
          // The dev/E2E held-stream release. Inert in production by construction
          // (no run is ever held there, so the slot is always null); externally
          // reachable only through the product Worker's `dev-only` forward route,
          // which 404s in production.
          return await this.releaseHeldStreamRoute(url.searchParams.get('runKey'));
        }
        default: {
          return errorResponse(ERROR_CODES.NOT_FOUND, 404);
        }
      }
    }

    override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
      if (typeof message !== 'string') {
        return;
      }
      // A heartbeat ping arriving outside the auto-response fast path must not be
      // parsed as a chat/typing frame.
      if (message === WS_HEARTBEAT_PING_MESSAGE) {
        return;
      }
      const { core } = await this.ensureRoom();
      await core.handleClientMessage(this.wrap(ws), message);
    }

    override async webSocketClose(ws: WebSocket): Promise<void> {
      const { core } = await this.ensureRoom();
      await core.handleClose(this.wrap(ws));
    }

    override async webSocketError(ws: WebSocket): Promise<void> {
      const { core } = await this.ensureRoom();
      await core.handleError(this.wrap(ws));
    }

    override async alarm(): Promise<void> {
      const { core } = await this.ensureRoom();
      core.onAlarm();
    }

    private async broadcastRoute(request: Request): Promise<Response> {
      const event = realtimeEventSchema.safeParse(await request.json());
      if (!event.success) {
        return errorResponse(ERROR_CODES.VALIDATION, 400);
      }
      const { core } = await this.ensureRoom();
      return jsonResponse(await core.broadcastEvent(event.data));
    }

    private async evictRoute(request: Request): Promise<Response> {
      const body = evictBodySchema.safeParse(await request.json());
      if (!body.success) {
        return errorResponse(ERROR_CODES.VALIDATION, 400);
      }
      const { core } = await this.ensureRoom();
      return jsonResponse({
        closed: await core.evict(body.data.principalId, body.data.sessionId),
      });
    }

    private async runStartRoute(request: Request): Promise<Response> {
      const body = runStartBodySchema.safeParse(await request.json());
      if (!body.success) {
        return errorResponse(ERROR_CODES.VALIDATION, 400);
      }
      const { core } = await this.ensureRoom();
      const result = await core.startRun(body.data);
      if (!result.ok) {
        return errorResponse(result.code, 409);
      }
      // Replay returns the already-settled response; attach signals a live run
      // the client rejoins over the socket, naming that run's message ids.
      // Only the executor branch opens a fresh run.
      if (result.outcome === 'replay') {
        return jsonResponse({ outcome: 'replay', response: result.response }, 200);
      }
      if (result.outcome === 'attach') {
        return jsonResponse(
          {
            outcome: 'attach',
            userMessageId: result.userMessageId,
            assistantMessageIds: result.assistantMessageIds,
          },
          200
        );
      }
      return jsonResponse(
        {
          runId: result.runId,
          deadlineAt: result.deadlineAt,
          assistantMessageIds: result.assistantMessageIds,
        },
        201
      );
    }

    private async runStopRoute(request: Request): Promise<Response> {
      const body = runStopBodySchema.safeParse(await request.json());
      if (!body.success) {
        return errorResponse(ERROR_CODES.VALIDATION, 400);
      }
      const { core } = await this.ensureRoom();
      const outcome = core.stopRun(body.data.caller);
      // A refusal and an idle room are different answers: the caller may not
      // stop this run, versus there was nothing to stop.
      if (outcome === 'refused') {
        return errorResponse(ERROR_CODES.FORBIDDEN, 403);
      }
      return jsonResponse({ stopped: outcome === 'stopped' });
    }

    /**
     * Attaches the DO-owned release barrier to a `holdPrimaryStream` run's start
     * request so the paused mock provider can await it. The Promise executor runs
     * synchronously, so the resolver is captured into the single per-DO slot
     * before the (augmented) request returns. A non-held run passes through
     * unchanged — no barrier, no slot mutation.
     *
     * The barrier is awaited once per park, and a run parks as many times as its
     * stream is asked to: each park is freed by its own release, so one release
     * can never carry a run past the park after it.
     */
    private attachHeldStreamRelease(request: FlowStartRequest): HeldStreamStartRequest {
      if (request.mockDirectives?.holdPrimaryStream !== true) {
        return request;
      }
      // The run key, not the run id: it is the one identifier a release can name
      // BEFORE the run it belongs to exists, which is the case the durable latch
      // is for (the run id is minted at start, inside this same call).
      const runKey = request.runKey;
      const slot = this.armHeldStreamGate(runKey);
      return {
        ...request,
        awaitStreamRelease: async () => {
          const parkIndex = slot.parks;
          slot.parks += 1;
          // The gate this park belongs to, read before the latch await: a
          // release landing during that await swaps the next park's gate in,
          // and awaiting that one would be waiting for a release this park has
          // already been granted.
          const gate = slot.gate;
          this.settleHeldStreamAdvance(runKey, slot.parks);
          if ((await this.releasesGranted(runKey)) > parkIndex) {
            return;
          }
          await gate;
        },
      };
    }

    /**
     * Opens the gate the run's next park will wait on. The resolver is captured
     * synchronously so a release that arrives while this run is live finds it,
     * whether or not the run has parked yet (the Smart-Model classifier-stage
     * race). The gate also consults the persisted latch, so a release that named
     * this run before it started — or one whose resolver died with a prior
     * instance — still frees it.
     */
    private armHeldStreamGate(runKey: string): HeldStreamSlot {
      const slot: HeldStreamSlot = {
        runKey,
        parks: 0,
        gate: Promise.resolve(),
        resolve: () => undefined,
      };
      this.heldStreamRelease = slot;
      this.rearmHeldStreamGate(slot);
      return slot;
    }

    /** Replaces a freed gate with the one the run's next park waits on. */
    private rearmHeldStreamGate(slot: HeldStreamSlot): void {
      slot.gate = new Promise<void>((resolve) => {
        slot.resolve = resolve;
      });
    }

    /** How many releases this run has been granted, live or across instances. */
    private async releasesGranted(runKey: string): Promise<number> {
      const latched = await this.ctx.storage.get<string>(HELD_STREAM_RELEASE_STORAGE_KEY);
      if (latched === undefined) {
        return 0;
      }
      const separator = latched.lastIndexOf('#');
      const suffix = separator === -1 ? '' : latched.slice(separator + 1);
      const counted = /^\d+$/u.test(suffix);
      const key = counted ? latched.slice(0, separator) : latched;
      if (key !== runKey) {
        return 0;
      }
      return counted ? Number(suffix) : 1;
    }

    /** Frees every release waiting for the run to have parked past `parks`. */
    private settleHeldStreamAdvance(runKey: string, parks: number): void {
      const freed = this.heldStreamAdvance.filter(
        (waiting) => waiting.runKey === runKey && parks > waiting.parks
      );
      if (freed.length === 0) {
        return;
      }
      this.heldStreamAdvance = this.heldStreamAdvance.filter((waiting) => !freed.includes(waiting));
      for (const waiting of freed) {
        waiting.settle();
      }
    }

    /**
     * Ends the seam with the run it belongs to: a release waiting for the next
     * park returns when the run finishes instead of waiting for a park that will
     * never come, and no later release resolves a dead gate.
     */
    private endHeldStreamWithRun(runKey: string, done: Promise<unknown>): void {
      void (async (): Promise<void> => {
        try {
          await done;
        } catch {
          // However the run ended is the executor's to report; the seam only
          // has to end with it.
        }
        if (this.heldStreamRelease?.runKey === runKey) {
          this.heldStreamRelease = null;
        }
        this.settleHeldStreamAdvance(runKey, Number.POSITIVE_INFINITY);
      })();
    }

    /**
     * Latches one more held-stream release under the run it names and frees that
     * run's live park if it has one. A caller that names no run means the run
     * this instance currently holds — every release issued from a test issues it
     * after its send, so the run exists by then; naming one is what lets a
     * release land earlier than that. `released` reports whether a park was
     * freed right now, while the latch persists, so a run that parks afterwards
     * frees immediately. With nothing held and nothing named there is no run to
     * latch against, and the release is a no-op.
     *
     * A granted release answers only once the run has reached its next park or
     * ended, so the response itself is the evidence that the stream advanced —
     * the alternative is a caller timing the advance against a clock.
     */
    private async releaseHeldStreamRoute(runKey: string | null): Promise<Response> {
      const held = this.heldStreamRelease;
      const target = runKey ?? held?.runKey ?? null;
      if (target === null) {
        return jsonResponse({ released: false });
      }
      const granted = (await this.releasesGranted(target)) + 1;
      await this.ctx.storage.put(HELD_STREAM_RELEASE_STORAGE_KEY, `${target}#${String(granted)}`);
      if (held?.runKey !== target) {
        return jsonResponse({ released: false });
      }
      const advanced = new Promise<void>((resolve) => {
        this.heldStreamAdvance.push({ runKey: target, parks: held.parks, settle: resolve });
      });
      const free = held.resolve;
      this.rearmHeldStreamGate(held);
      free();
      await advanced;
      return jsonResponse({ released: true });
    }

    private async upgrade(url: URL): Promise<Response> {
      const { core, conversationId } = await this.ensureRoom();
      const displayName = url.searchParams.get('displayName');
      // The worker authorizes the session before proxying the upgrade and
      // forwards its snapshot (a real user only) so the broadcast-time
      // session-liveness check can validate the socket. Absent for guests and
      // trial principals — they hold no revocable session; a real user's socket
      // arriving without one is cut at the first broadcast (fail closed).
      const sessionId = url.searchParams.get('sessionId');
      const sessionCreatedAt = url.searchParams.get('sessionCreatedAt');
      // Either param present means a session was intended, so the pair is
      // built and the schema judges it: half a session fails the upgrade
      // rather than becoming a session-less socket.
      const session =
        sessionId === null && sessionCreatedAt === null
          ? {}
          : {
              session: {
                id: sessionId,
                createdAt: sessionCreatedAt === null ? null : Number(sessionCreatedAt),
              },
            };
      const attachment = socketAttachmentSchema.safeParse({
        principalId: url.searchParams.get('principalId'),
        conversationId: url.searchParams.get('conversationId'),
        ...(displayName === null ? {} : { displayName }),
        isGuest: url.searchParams.get('isGuest') === 'true',
        connectedAt: this.bindings.now(),
        ...session,
      });
      // What the client says it has already seen. The only client-supplied
      // value the worker forwards, so it is bounded here as well as at the
      // worker seam, and a malformed one fails the upgrade rather than
      // connecting a socket whose declaration was silently discarded.
      const declared = parseStreamCursors(url.searchParams.get(DECLARED_CURSORS_PARAM));
      if (
        !attachment.success ||
        attachment.data.conversationId !== conversationId ||
        !declared.ok
      ) {
        this.bindings.telemetry.upgradeRejected({ conversationId });
        return errorResponse(ERROR_CODES.VALIDATION, 400);
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      // The upgrade fails closed: setup that may reject runs while nothing is
      // accepted, so a rejection leaves no socket in `ctx.getWebSockets()`.
      // The attachment is written first because that setup reads it, and the
      // runtime carries it across acceptance. Nothing is awaited between
      // acceptance and the 101, so no run frame reaches the socket before the
      // client holds it — and `completeOpen` runs in that same synchronous
      // turn, which is what lets it withhold the socket from the streams it
      // declared before a queued frame for one of them can reach it.
      server.serializeAttachment(attachment.data);
      const socket = this.wrap(server);
      await core.prepareOpen(socket);
      // Nothing may be awaited between the cap enforcement and the acceptance
      // it frees a slot for. Acceptance is the only thing that puts a socket on
      // the roster the cap counts, so a yield here lets every upgrade of a
      // simultaneous burst count a roster none of the others has joined, and
      // the whole burst is admitted.
      core.enforceSocketCap(attachment.data.principalId);
      this.ctx.acceptWebSocket(server);
      core.completeOpen(socket, declared.cursors);
      return new Response(null, { status: 101, webSocket: client });
    }

    private wrap(socket: WebSocket): RoomSocket {
      const existing = this.wrappers.get(socket);
      if (existing !== undefined) {
        return existing;
      }
      const wrapped: RoomSocket = {
        send: (data) => {
          socket.send(data);
        },
        close: (code, reason) => {
          socket.close(code, reason);
        },
        attachment: () => {
          const parsed = socketAttachmentSchema.safeParse(socket.deserializeAttachment());
          return parsed.success ? parsed.data : null;
        },
      };
      this.wrappers.set(socket, wrapped);
      return wrapped;
    }
  };
}
