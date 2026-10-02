import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTimeBounds, WorkflowDefinition } from '@hushbox/shared';
import {
  CONVERSATION_ID_STORAGE_KEY,
  MAX_SOCKETS_PER_PRINCIPAL,
  RUN_HEARTBEAT_INTERVAL_MS,
  RoomCore,
  resolveConversationId,
} from './room-core.js';
import { runStartBodySchema } from './protocol.js';
import type {
  FlowAbortReason,
  FlowAdmissionOutcome,
  FlowExecutor,
  FlowHoldIdentity,
  FlowRunOutcome,
  FlowStartRequest,
  FlowStopReason,
  FlowStreamEvent,
  RunClaim,
  RunClaimRequest,
  RunContext,
  RunFence,
  SenderPrincipal,
  WorkflowDefinition as WorkflowDefinitionType,
} from '@hushbox/shared';
import type { RunStartBody, ServerFrame, SocketAttachment } from './protocol.js';
import type { MembershipDecision } from './revocation.js';
import type { RoomNotify, RoomPushNotification, RoomSocket } from './room-core.js';
import type { SessionDecision, SessionSnapshot, SessionVerifier } from './session-liveness.js';
import type { UserRoomTracker } from './user-rooms.js';

class FakeSocket implements RoomSocket {
  readonly sent: string[] = [];
  readonly closed: { code: number; reason: string }[] = [];
  constructor(private readonly socketAttachment: SocketAttachment | null) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }
  attachment(): SocketAttachment | null {
    return this.socketAttachment;
  }
}

function frames(socket: FakeSocket): ServerFrame[] {
  return socket.sent.map((data) => JSON.parse(data) as ServerFrame);
}

/**
 * The frames answering a socket's cursor declaration, less the `ready` and
 * presence frames connection setup writes to every socket.
 */
function replayed(socket: FakeSocket): ServerFrame[] {
  return frames(socket).filter((frame) => frame.type === 'stream' || frame.type === 'stream-gone');
}

/** The stream cursors a socket actually received, in the order they arrived. */
function streamCursors(socket: FakeSocket): number[] {
  return frames(socket)
    .filter((frame) => frame.type === 'stream')
    .map((frame) => frame.cursor);
}

function definition(): WorkflowDefinition {
  return WorkflowDefinition.parse({
    version: 1,
    deadlineClass: 'text',
    hooks: { admission: 'chat-admission', settlement: 'chat-settlement' },
    nodes: [
      {
        id: 'n1',
        version: 1,
        out: 'out',
        type: 'modelCall',
        model: 'test-model',
        params: {},
        in: { node: 'n1', port: 'in' },
      },
    ],
    edges: [],
  });
}

function runBody(runKey = 'key-1'): RunStartBody {
  return {
    mode: 'paid',
    runKey,
    bodyHash: 'body-hash-1',
    definition: definition(),
    inputs: {},
    history: [],
    userId: 'u1',
    sender: { kind: 'user', userId: 'sender-1' },
    walletId: 'w1',
    epochNumber: 3,
    userMessage: { id: 'um1', content: 'hi' },
  };
}

function guestRunBody(runKey = 'key-1'): RunStartBody {
  const base = runBody(runKey);
  if (base.mode !== 'paid') throw new Error('expected a paid run body');
  return {
    ...base,
    // The owner funds the guest send (userId = owner); the sender is the link
    // guest, keyed by its linkId.
    userId: 'owner-1',
    sender: { kind: 'linkGuest', linkId: 'link-1' },
  };
}

function trialRunBody(runKey = 'key-1'): RunStartBody {
  return {
    mode: 'trial',
    runKey,
    bodyHash: 'body-hash-1',
    definition: definition(),
    inputs: {},
    history: [],
    sessionId: 'session-1',
  };
}

const DEFAULT_FENCE = { id: 'fence-1', executorId: 'exec-1', claims: 1 };

interface TelemetryRecord {
  method: string;
  fields: Record<string, string | undefined>;
}

interface BindHookCall {
  context: RunContext;
  definition: WorkflowDefinitionType;
}

function makeHarness(
  options: {
    maxStreamBytes?: number;
    maxRunBytes?: number;
    doneRejects?: boolean;
    admitted?: FlowAdmissionOutcome;
    manualAdmit?: boolean;
    userRooms?: UserRoomTracker;
    sessionVerifier?: SessionVerifier;
    notify?: RoomNotify;
    waitUntil?: (promise: Promise<unknown>) => void;
    verifyThrows?: boolean;
    alarmSetRejects?: boolean;
    alarmDeleteRejects?: boolean;
  } = {}
): {
  core: RoomCore;
  addSocket(principalId: string, overrides?: Partial<SocketAttachment>): FakeSocket;
  addRawSocket(attachment: SocketAttachment | null): FakeSocket;
  removeSocket(socket: FakeSocket): void;
  decisions: Map<string, MembershipDecision>;
  verifyCalls: string[];
  /**
   * Suspends the next membership check, so a fan-out can be caught mid-flight;
   * `failNext` makes exactly one check reject, which is the only way a delivery
   * on the ordering chain can fail from outside the room.
   */
  verify: { holdNext(): void; release(): void; failNext(): void };
  telemetry: TelemetryRecord[];
  alarms: { set: number[]; deleted: number };
  claim: {
    calls: RunClaimRequest[];
    resolveWith(result: RunClaim): void;
    failNext(): void;
    /**
     * Suspends the next referee claim until the returned function runs, which
     * settles it with `result`, or rejects it when `result` is an error.
     */
    holdNext(result: RunClaim | Error): () => void;
  };
  bindHookCalls: BindHookCall[];
  executor: {
    starts: FlowStartRequest[];
    emit(event: FlowStreamEvent): void;
    finish(outcome: FlowRunOutcome): void;
    admit(outcome: FlowAdmissionOutcome): void;
    stops: FlowStopReason[];
    aborts: FlowAbortReason[];
    failNextStart(): void;
  };
  money: {
    released: FlowHoldIdentity[];
    failedFences: RunFence[];
    heartbeats: RunFence[];
    heartbeatState: { result: 'alive' | 'lost' };
  };
} {
  const sockets: FakeSocket[] = [];
  const decisions = new Map<string, MembershipDecision>();
  const verifyCalls: string[] = [];
  let heldVerify: Promise<void> | null = null;
  let releaseHeldVerify: (() => void) | null = null;
  let verifyFailsNext = false;
  const telemetry: TelemetryRecord[] = [];
  const alarms = { set: [] as number[], deleted: 0 };
  const starts: FlowStartRequest[] = [];
  const stops: FlowStopReason[] = [];
  const aborts: FlowAbortReason[] = [];
  const claimCalls: RunClaimRequest[] = [];
  const bindHookCalls: BindHookCall[] = [];
  let claimResult: RunClaim = { outcome: 'executor', fence: DEFAULT_FENCE };
  let claimShouldFail = false;
  let heldClaim: Promise<RunClaim> | null = null;
  let emitFunction: ((event: FlowStreamEvent) => void) | null = null;
  let finishFunction: ((outcome: FlowRunOutcome) => void) | null = null;
  let admitFunction: ((outcome: FlowAdmissionOutcome) => void) | null = null;
  let shouldFailStart = false;
  let runCounter = 0;
  const released: FlowHoldIdentity[] = [];
  const failedFences: RunFence[] = [];
  const heartbeats: RunFence[] = [];
  const heartbeatState = { result: 'alive' as 'alive' | 'lost' };

  const executor: FlowExecutor = {
    start(request) {
      if (shouldFailStart) {
        shouldFailStart = false;
        throw new Error('executor exploded');
      }
      starts.push(request);
      emitFunction = request.emit;
      let done: Promise<FlowRunOutcome>;
      if (options.doneRejects === true) {
        done = Promise.reject(new Error('executor defect'));
      } else {
        done = new Promise<FlowRunOutcome>((resolve) => {
          finishFunction = resolve;
        });
      }
      let admitted: Promise<FlowAdmissionOutcome>;
      if (options.manualAdmit === true) {
        admitted = new Promise<FlowAdmissionOutcome>((resolve) => {
          admitFunction = resolve;
        });
      } else {
        admitted = Promise.resolve(options.admitted ?? { admitted: true });
      }
      return {
        runKey: request.runKey,
        done,
        admitted,
        stop: (reason) => {
          stops.push(reason);
        },
        abort: (reason) => {
          aborts.push(reason);
        },
      };
    },
  };

  const record =
    (method: string) =>
    (fields: Record<string, string | undefined>): void => {
      telemetry.push({ method, fields });
    };

  const core = new RoomCore({
    conversationId: 'c1',
    executor,
    verifier: {
      verify: async (conversationId, principalId) => {
        verifyCalls.push(`${conversationId}:${principalId}`);
        if (options.verifyThrows === true) throw new Error('verifier down');
        if (verifyFailsNext) {
          verifyFailsNext = false;
          throw new Error('verifier down');
        }
        const held = heldVerify;
        heldVerify = null;
        if (held !== null) await held;
        return decisions.get(principalId) ?? 'member';
      },
    },
    telemetry: {
      runStarted: record('runStarted'),
      runFinished: record('runFinished'),
      runRejected: record('runRejected'),
      deadlineFired: record('deadlineFired'),
      principalEvicted: record('principalEvicted'),
      deliveryPaused: record('deliveryPaused'),
      deliveryFailed: record('deliveryFailed'),
      deliveryResumed: record('deliveryResumed'),
      clientMessageRejected: record('clientMessageRejected'),
      upgradeRejected: record('upgradeRejected'),
      billableGeneration: record('billableGeneration'),
    },
    scheduler: {
      setAlarm: (at) => {
        alarms.set.push(at);
        return options.alarmSetRejects === true
          ? Promise.reject(new Error('alarm write failed'))
          : Promise.resolve();
      },
      deleteAlarm: () => {
        alarms.deleted += 1;
        return options.alarmDeleteRejects === true
          ? Promise.reject(new Error('alarm delete failed'))
          : Promise.resolve();
      },
    },
    claimRun: (request) => {
      claimCalls.push(request);
      if (claimShouldFail) {
        claimShouldFail = false;
        return Promise.reject(new Error('referee unavailable'));
      }
      if (heldClaim !== null) {
        const held = heldClaim;
        heldClaim = null;
        return held;
      }
      return Promise.resolve(claimResult);
    },
    bindHooks: (context, definition) => {
      bindHookCalls.push({ context, definition });
      return {
        admission: () => Promise.resolve({ admitted: true, holdRef: 'hold-1' }),
        settlement: () => Promise.resolve(),
        // A paid binding mints one answer id; a trial binding mints none.
        assistantMessageIds: context.mode === 'paid' ? [`answer-of-${context.runId}`] : [],
      };
    },
    maxStreamBytes: options.maxStreamBytes ?? 1_000_000,
    maxRunBytes: options.maxRunBytes ?? Number.POSITIVE_INFINITY,
    now: () => 10_000,
    newRunId: () => {
      runCounter += 1;
      return `run-${String(runCounter)}`;
    },
    sockets: () => sockets,
    releaseHold: (hold) => {
      released.push(hold);
      return Promise.resolve();
    },
    heartbeat: (fence) => {
      heartbeats.push(fence);
      return Promise.resolve(heartbeatState.result);
    },
    failRun: (fence) => {
      failedFences.push(fence);
      return Promise.resolve();
    },
    ...(options.userRooms === undefined ? {} : { userRooms: options.userRooms }),
    ...(options.sessionVerifier === undefined ? {} : { sessionVerifier: options.sessionVerifier }),
    ...(options.notify === undefined ? {} : { notify: options.notify }),
    ...(options.waitUntil === undefined ? {} : { waitUntil: options.waitUntil }),
  });

  return {
    core,
    addSocket: (principalId, overrides = {}) => {
      const socket = new FakeSocket({
        principalId,
        conversationId: 'c1',
        isGuest: false,
        connectedAt: 100,
        ...overrides,
      });
      sockets.push(socket);
      return socket;
    },
    addRawSocket: (attachment) => {
      const socket = new FakeSocket(attachment);
      sockets.push(socket);
      return socket;
    },
    removeSocket: (socket) => {
      sockets.splice(sockets.indexOf(socket), 1);
    },
    decisions,
    verifyCalls,
    verify: {
      holdNext: () => {
        heldVerify = new Promise<void>((resolve) => {
          releaseHeldVerify = resolve;
        });
      },
      release: () => {
        releaseHeldVerify?.();
      },
      failNext: () => {
        verifyFailsNext = true;
      },
    },
    telemetry,
    alarms,
    claim: {
      calls: claimCalls,
      resolveWith: (result) => {
        claimResult = result;
      },
      failNext: () => {
        claimShouldFail = true;
      },
      holdNext: (result) => {
        let release!: () => void;
        heldClaim = new Promise<RunClaim>((resolve, reject) => {
          release = () => {
            if (result instanceof Error) reject(result);
            else resolve(result);
          };
        });
        return release;
      },
    },
    bindHookCalls,
    executor: {
      starts,
      emit: (event) => {
        if (emitFunction === null) throw new Error('no active run');
        emitFunction(event);
      },
      finish: (outcome) => {
        if (finishFunction === null) throw new Error('no active run');
        finishFunction(outcome);
      },
      admit: (outcome) => {
        if (admitFunction === null) throw new Error('no pending manual admit');
        admitFunction(outcome);
      },
      stops,
      aborts,
      failNextStart: () => {
        shouldFailStart = true;
      },
    },
    money: { released, failedFences, heartbeats, heartbeatState },
  };
}

describe('prepareOpen', () => {
  it('sends nothing to a socket the shell has not accepted yet', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.prepareOpen(socket);
    expect(frames(socket)).toEqual([]);
  });
});

describe('enforceSocketCap', () => {
  /** Fills a principal's roster to exactly the cap, oldest first. */
  function fillToCap(h: ReturnType<typeof makeHarness>, principalId: string): FakeSocket[] {
    return Array.from({ length: MAX_SOCKETS_PER_PRINCIPAL }, (_, index) =>
      h.addSocket(principalId, { connectedAt: 1000 + index })
    );
  }

  /** One short of the cap, so accepting one more lands exactly on it. */
  function fillBelowCap(h: ReturnType<typeof makeHarness>, principalId: string): FakeSocket[] {
    return Array.from({ length: MAX_SOCKETS_PER_PRINCIPAL - 1 }, (_, index) =>
      h.addSocket(principalId, { connectedAt: 1000 + index })
    );
  }

  it('closes nothing while the principal holds fewer sockets than the cap', () => {
    const h = makeHarness();
    const held = fillBelowCap(h, 'u1');
    h.core.enforceSocketCap('u1');
    expect(held.flatMap((socket) => socket.closed)).toEqual([]);
  });

  it('closes the principal\u2019s oldest socket when it already holds the cap', () => {
    const h = makeHarness();
    const held = fillToCap(h, 'u1');
    h.core.enforceSocketCap('u1');
    expect(held[0]?.closed).toHaveLength(1);
    expect(held.slice(1).flatMap((socket) => socket.closed)).toEqual([]);
  });

  it('picks the oldest by connection time rather than by roster position', () => {
    const h = makeHarness();
    // The oldest socket joins the roster last, so an implementation reading
    // roster order closes a live newer socket instead of the stale one.
    const newer = fillBelowCap(h, 'u1');
    const oldest = h.addSocket('u1', { connectedAt: 1 });
    h.core.enforceSocketCap('u1');
    expect(oldest.closed).toHaveLength(1);
    expect(newer.flatMap((socket) => socket.closed)).toEqual([]);
  });

  it('leaves another principal\u2019s sockets untouched while that principal is itself at the cap', () => {
    const h = makeHarness();
    const other = fillToCap(h, 'u2');
    fillToCap(h, 'u1');
    h.core.enforceSocketCap('u1');
    expect(other.flatMap((socket) => socket.closed)).toEqual([]);
  });

  it('counts only the named principal\u2019s sockets toward the cap', () => {
    const h = makeHarness();
    const held = fillBelowCap(h, 'u1');
    fillToCap(h, 'u2');
    h.core.enforceSocketCap('u1');
    expect(held.flatMap((socket) => socket.closed)).toEqual([]);
  });

  it('counts no socket whose attachment is unreadable toward the cap', () => {
    const h = makeHarness();
    const held = fillBelowCap(h, 'u1');
    h.addRawSocket(null);
    h.core.enforceSocketCap('u1');
    expect(held.flatMap((socket) => socket.closed)).toEqual([]);
  });

  it('closes the evicted socket with a code and reason the client reconnects from', () => {
    const h = makeHarness();
    const held = fillToCap(h, 'u1');
    h.core.enforceSocketCap('u1');
    expect(held[0]?.closed).toEqual([{ code: 1008, reason: 'socket cap' }]);
  });

  it('swallows a close failure so an already-closing socket cannot fail the upgrade', () => {
    const h = makeHarness();
    const held = fillToCap(h, 'u1');
    const oldest = held[0];
    if (oldest === undefined) throw new Error('expected a filled roster');
    oldest.close = (): never => {
      throw new Error('already closed');
    };
    expect(() => {
      h.core.enforceSocketCap('u1');
    }).not.toThrow();
  });
});

describe('completeOpen', () => {
  it('sends the ready frame to the opening socket', () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    h.core.completeOpen(socket);
    expect(frames(socket)[0]).toEqual({ type: 'ready' });
  });

  it('names the run the room is live in on the ready frame', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    const joiner = h.addSocket('u1');
    h.core.completeOpen(joiner);
    expect(frames(joiner)[0]).toEqual({ type: 'ready', runId: 'run-1' });
  });

  it('names no run on the ready frame once the live run has finished', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    const joiner = h.addSocket('u1');
    h.core.completeOpen(joiner);
    expect(frames(joiner)[0]).toEqual({ type: 'ready' });
  });

  it('broadcasts presence with the real conversationId', async () => {
    const duties: Promise<unknown>[] = [];
    const h = makeHarness({
      waitUntil: (promise) => {
        duties.push(promise);
      },
    });
    const socket = h.addSocket('u1');
    h.core.completeOpen(socket);
    await Promise.all(duties);
    const presence = frames(socket).find(
      (frame) => frame.type === 'event' && frame.event.type === 'presence:update'
    );
    expect(presence).toMatchObject({ event: { conversationId: 'c1' } });
  });

  it('swallows a presence-broadcast failure so nothing accepted is orphaned', async () => {
    const duties: Promise<unknown>[] = [];
    const h = makeHarness({
      waitUntil: (promise) => {
        duties.push(promise);
      },
      verifyThrows: true,
    });
    h.core.completeOpen(h.addSocket('u1'));
    await expect(Promise.all(duties)).resolves.toBeDefined();
  });
});

describe('handleClose', () => {
  it('broadcasts presence without the closing member to the remaining sockets', async () => {
    const h = makeHarness();
    const closing = h.addSocket('u1');
    const other = h.addSocket('u2');
    await h.core.handleClose(closing);
    const presence = frames(other).find(
      (frame) => frame.type === 'event' && frame.event.type === 'presence:update'
    );
    expect(presence).toMatchObject({
      event: { members: [{ userId: 'u2', isGuest: false, connectedAt: 100 }] },
    });
  });

  it('is a no-op when no sockets remain', async () => {
    const h = makeHarness();
    await h.core.handleClose(new FakeSocket(null));
    expect(h.verifyCalls).toEqual([]);
  });
});

describe('handleError', () => {
  it('closes the errored socket with 1011 "WebSocket error"', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.handleError(socket);
    expect(socket.closed).toEqual([{ code: 1011, reason: 'WebSocket error' }]);
  });

  it('broadcasts presence without the errored member to the remaining sockets', async () => {
    const h = makeHarness();
    const errored = h.addSocket('u1');
    const other = h.addSocket('u2');
    await h.core.handleError(errored);
    const presence = frames(other).find(
      (frame) => frame.type === 'event' && frame.event.type === 'presence:update'
    );
    expect(presence).toMatchObject({
      event: { members: [{ userId: 'u2', isGuest: false, connectedAt: 100 }] },
    });
  });

  it('swallows a close failure so an already-closing socket is hibernation-safe', async () => {
    const h = makeHarness();
    const throwing: RoomSocket = {
      send: () => {},
      close: () => {
        throw new Error('already closing');
      },
      attachment: () => ({
        principalId: 'u1',
        conversationId: 'c1',
        isGuest: false,
        connectedAt: 100,
      }),
    };
    await expect(h.core.handleError(throwing)).resolves.toBeUndefined();
  });
});

function recordingTracker(overrides: Partial<UserRoomTracker> = {}): UserRoomTracker & {
  readonly tracked: [string, string][];
  readonly untracked: [string, string][];
} {
  const tracked: [string, string][] = [];
  const untracked: [string, string][] = [];
  return {
    track: (userId, conversationId) => {
      tracked.push([userId, conversationId]);
      return Promise.resolve();
    },
    untrack: (userId, conversationId) => {
      untracked.push([userId, conversationId]);
      return Promise.resolve();
    },
    ...overrides,
    tracked,
    untracked,
  };
}

describe('active-room tracking', () => {
  it('tracks the conversation for a real authenticated user on open', async () => {
    const tracker = recordingTracker();
    const h = makeHarness({ userRooms: tracker });
    await h.core.prepareOpen(h.addSocket('u1'));
    expect(tracker.tracked).toEqual([['u1', 'c1']]);
  });

  it('does not track a link guest on open', async () => {
    const tracker = recordingTracker();
    const h = makeHarness({ userRooms: tracker });
    await h.core.prepareOpen(h.addSocket('link-1', { isGuest: true }));
    expect(tracker.tracked).toEqual([]);
  });

  it('does not track a trial-session principal on open', async () => {
    const tracker = recordingTracker();
    const h = makeHarness({ userRooms: tracker });
    await h.core.prepareOpen(h.addSocket('trial:session-1'));
    expect(tracker.tracked).toEqual([]);
  });

  it('does not track a socket with no readable attachment', async () => {
    const tracker = recordingTracker();
    const h = makeHarness({ userRooms: tracker });
    await h.core.prepareOpen(h.addRawSocket(null));
    expect(tracker.tracked).toEqual([]);
  });

  it('opens without tracking when no tracker is wired', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await expect(h.core.prepareOpen(socket)).resolves.toBeUndefined();
  });

  it('fails the open (fail-closed) when tracking cannot be recorded', async () => {
    const tracker = recordingTracker({
      track: () => Promise.reject(new Error('redis down')),
    });
    const h = makeHarness({ userRooms: tracker });
    await expect(h.core.prepareOpen(h.addSocket('u1'))).rejects.toThrow('redis down');
  });

  it('untracks the conversation when the user’s last socket closes', async () => {
    const tracker = recordingTracker();
    const h = makeHarness({ userRooms: tracker });
    const socket = h.addSocket('u1');
    await h.core.handleClose(socket);
    expect(tracker.untracked).toEqual([['u1', 'c1']]);
  });

  it('does not untrack while another socket of the same user remains', async () => {
    const tracker = recordingTracker();
    const h = makeHarness({ userRooms: tracker });
    const first = h.addSocket('u1');
    h.addSocket('u1');
    await h.core.handleClose(first);
    expect(tracker.untracked).toEqual([]);
  });

  it('does not untrack a guest or trial principal', async () => {
    const tracker = recordingTracker();
    const h = makeHarness({ userRooms: tracker });
    await h.core.handleClose(h.addSocket('link-1', { isGuest: true }));
    await h.core.handleClose(h.addSocket('trial:session-1'));
    expect(tracker.untracked).toEqual([]);
  });

  it('does not untrack a socket with no readable attachment', async () => {
    const tracker = recordingTracker();
    const h = makeHarness({ userRooms: tracker });
    await h.core.handleClose(h.addRawSocket(null));
    expect(tracker.untracked).toEqual([]);
  });

  it('closes without untracking when no tracker is wired', async () => {
    const h = makeHarness();
    await expect(h.core.handleClose(h.addSocket('u1'))).resolves.toBeUndefined();
  });

  it('swallows an untrack failure and still broadcasts presence', async () => {
    const tracker = recordingTracker({
      untrack: () => Promise.reject(new Error('redis down')),
    });
    const h = makeHarness({ userRooms: tracker });
    const socket = h.addSocket('u1');
    const other = h.addSocket('u2');
    await expect(h.core.handleClose(socket)).resolves.toBeUndefined();
    const presence = frames(other).find(
      (frame) => frame.type === 'event' && frame.event.type === 'presence:update'
    );
    expect(presence).toBeDefined();
  });
});

describe('broadcastEvent', () => {
  function event(): Parameters<RoomCore['broadcastEvent']>[0] {
    return { type: 'rotation:complete', timestamp: 1, conversationId: 'c1', newEpochNumber: 2 };
  }

  it('delivers the event to every member socket', async () => {
    const h = makeHarness();
    const a = h.addSocket('u1');
    const b = h.addSocket('u2');
    await h.core.broadcastEvent(event());
    expect(frames(a)).toEqual([{ type: 'event', event: event() }]);
    expect(frames(b)).toEqual([{ type: 'event', event: event() }]);
  });

  it('verifies each principal once per broadcast', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    h.addSocket('u1');
    await h.core.broadcastEvent(event());
    expect(h.verifyCalls).toEqual(['c1:u1']);
  });

  it('closes a revoked principal without delivering', async () => {
    const h = makeHarness();
    const revoked = h.addSocket('u2');
    h.decisions.set('u2', 'revoked');
    await h.core.broadcastEvent(event());
    expect(revoked.sent).toEqual([]);
    expect(revoked.closed).toEqual([{ code: 1008, reason: 'revoked' }]);
  });

  it('records telemetry when a principal is evicted at broadcast time', async () => {
    const h = makeHarness();
    h.addSocket('u2');
    h.decisions.set('u2', 'revoked');
    await h.core.broadcastEvent(event());
    expect(h.telemetry).toContainEqual({
      method: 'principalEvicted',
      fields: { conversationId: 'c1' },
    });
  });

  it('skips a paused principal but keeps the socket open', async () => {
    const h = makeHarness();
    const paused = h.addSocket('u3');
    h.decisions.set('u3', 'pause');
    await h.core.broadcastEvent(event());
    expect(paused.sent).toEqual([]);
    expect(paused.closed).toEqual([]);
  });

  it('records telemetry when delivery pauses', async () => {
    const h = makeHarness();
    h.addSocket('u3');
    h.decisions.set('u3', 'pause');
    await h.core.broadcastEvent(event());
    expect(h.telemetry).toContainEqual({
      method: 'deliveryPaused',
      fields: { conversationId: 'c1' },
    });
  });

  it('counts delivered sockets and paused and evicted principals', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    h.addSocket('u1');
    h.addSocket('u2');
    h.addSocket('u3');
    h.decisions.set('u2', 'revoked');
    h.decisions.set('u3', 'pause');
    await expect(h.core.broadcastEvent(event())).resolves.toEqual({
      delivered: 2,
      paused: 1,
      evicted: 1,
    });
  });

  it('closes a socket whose attachment is unreadable', async () => {
    const h = makeHarness();
    const broken = h.addRawSocket(null);
    await h.core.broadcastEvent(event());
    expect(broken.closed).toEqual([{ code: 1011, reason: 'invalid attachment' }]);
  });

  it('closes a socket whose send fails', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    socket.send = () => {
      throw new Error('socket gone');
    };
    await expect(h.core.broadcastEvent(event())).resolves.toMatchObject({ delivered: 0 });
    expect(socket.closed).toEqual([{ code: 1011, reason: 'send failed' }]);
  });
});

describe('handleClientMessage', () => {
  it('relays a typing event to other members only', async () => {
    const h = makeHarness();
    const sender = h.addSocket('u1');
    const other = h.addSocket('u2');
    const typing = { type: 'typing:start', timestamp: 1, conversationId: 'c1', userId: 'u1' };
    await h.core.handleClientMessage(sender, JSON.stringify(typing));
    expect(frames(other)).toEqual([{ type: 'event', event: typing }]);
    expect(sender.sent).toEqual([]);
  });

  it('relays a spoofed userId as the attachment principalId', async () => {
    const h = makeHarness();
    const sender = h.addSocket('u1');
    const other = h.addSocket('u2');
    const typing = { type: 'typing:start', timestamp: 1, conversationId: 'c1', userId: 'victim' };
    await h.core.handleClientMessage(sender, JSON.stringify(typing));
    expect(frames(other)).toEqual([{ type: 'event', event: { ...typing, userId: 'u1' } }]);
  });

  it('rejects a typing event for another conversation with telemetry and no delivery', async () => {
    const h = makeHarness();
    const sender = h.addSocket('u1');
    const other = h.addSocket('u2');
    const typing = { type: 'typing:stop', timestamp: 1, conversationId: 'c2', userId: 'u1' };
    await h.core.handleClientMessage(sender, JSON.stringify(typing));
    expect(other.sent).toEqual([]);
    expect(h.telemetry).toContainEqual({
      method: 'clientMessageRejected',
      fields: { conversationId: 'c1' },
    });
  });

  it('rejects a typing event from a socket without a readable attachment', async () => {
    const h = makeHarness();
    const sender = h.addRawSocket(null);
    const other = h.addSocket('u2');
    const typing = { type: 'typing:start', timestamp: 1, conversationId: 'c1', userId: 'u1' };
    await h.core.handleClientMessage(sender, JSON.stringify(typing));
    expect(other.sent).toEqual([]);
    expect(h.telemetry).toContainEqual({
      method: 'clientMessageRejected',
      fields: { conversationId: 'c1' },
    });
  });

  it('rejects malformed JSON with telemetry and no delivery', async () => {
    const h = makeHarness();
    const sender = h.addSocket('u1');
    const other = h.addSocket('u2');
    await h.core.handleClientMessage(sender, 'not json');
    expect(other.sent).toEqual([]);
    expect(h.telemetry).toContainEqual({
      method: 'clientMessageRejected',
      fields: { conversationId: 'c1' },
    });
  });

  it('rejects a message outside the client vocabulary', async () => {
    const h = makeHarness();
    const sender = h.addSocket('u1');
    const other = h.addSocket('u2');
    const forged = { type: 'message:new', timestamp: 1, messageId: 'm1', conversationId: 'c1' };
    await h.core.handleClientMessage(sender, JSON.stringify(forged));
    expect(other.sent).toEqual([]);
  });

  it('rejects a resume message', async () => {
    const h = makeHarness();
    const sender = h.addSocket('u1');
    await h.core.handleClientMessage(
      sender,
      JSON.stringify({ type: 'resume', streams: [{ streamId: 's1', lastEventId: 0 }] })
    );
    expect(frames(sender)).toEqual([]);
    expect(h.telemetry).toContainEqual({
      method: 'clientMessageRejected',
      fields: { conversationId: 'c1' },
    });
  });
});

describe('startRun', () => {
  it('returns the executor outcome with the run id, the hard stop as the deadline and the answer ids', async () => {
    const h = makeHarness();
    await expect(h.core.startRun(runBody())).resolves.toEqual({
      ok: true,
      outcome: 'executor',
      runId: 'run-1',
      deadlineAt: 10_000 + runTimeBounds('text').hardStopAfterMs,
      assistantMessageIds: ['answer-of-run-1'],
    });
  });

  it('gives a text run a deadline 15 minutes after its start', async () => {
    const h = makeHarness();
    await expect(h.core.startRun(runBody())).resolves.toMatchObject({
      deadlineAt: 10_000 + 15 * 60 * 1000,
    });
  });

  it('gives a media run a deadline 20 minutes after its start', async () => {
    const h = makeHarness();
    const media = {
      ...runBody(),
      definition: { ...definition(), deadlineClass: 'media' as const },
    };
    await expect(h.core.startRun(media)).resolves.toMatchObject({
      deadlineAt: 10_000 + 20 * 60 * 1000,
    });
  });

  it('returns no answer ids for a trial run, whose binding mints none', async () => {
    const h = makeHarness();
    await expect(h.core.startRun(trialRunBody())).resolves.toMatchObject({
      outcome: 'executor',
      assistantMessageIds: [],
    });
  });

  it('claims the run referee with the key, run id, and DO-filled identity', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    expect(h.claim.calls).toEqual([
      {
        runKey: 'key-1',
        runId: 'run-1',
        bodyHash: 'body-hash-1',
        identity: {
          mode: 'paid',
          payerUserId: 'u1',
          // The principal is the sender's sole carrier on body and identity
          // alike; every consumer derives the id from it.
          sender: { kind: 'user', userId: 'sender-1' },
          // conversationId comes from the DO's own id, never the body.
          conversationId: 'c1',
          walletId: 'w1',
          epochNumber: 3,
          userMessage: { id: 'um1', content: 'hi' },
        },
      },
    ]);
  });

  it('claims the run referee with a link-guest sender carrying its linkId', async () => {
    const h = makeHarness();
    await h.core.startRun(guestRunBody());
    expect(h.claim.calls[0]?.identity).toMatchObject({
      mode: 'paid',
      payerUserId: 'owner-1',
      sender: { kind: 'linkGuest', linkId: 'link-1' },
    });
  });

  // Parsed, unlike the sibling pins: the wire schema is what a user sender's
  // principal crosses on its way in, and Zod strips any field the schema stops
  // declaring — silently, with no type error at either end.
  it('carries a wire-parsed user sender onto the identity intact', async () => {
    const h = makeHarness();
    await h.core.startRun(runStartBodySchema.parse(runBody()));
    expect(h.claim.calls[0]?.identity).toMatchObject({
      mode: 'paid',
      sender: { kind: 'user', userId: 'sender-1' },
    });
  });

  it('always carries a sender onto the identity, never omitting it', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    expect(h.claim.calls[0]?.identity).toHaveProperty('sender');
  });

  it('claims the run referee with a trial identity carrying only the session id', async () => {
    const h = makeHarness();
    await h.core.startRun(trialRunBody());
    expect(h.claim.calls).toEqual([
      {
        runKey: 'key-1',
        runId: 'run-1',
        bodyHash: 'body-hash-1',
        identity: { mode: 'trial', sessionId: 'session-1' },
      },
    ]);
  });

  it('claims the run referee before starting the executor', async () => {
    const h = makeHarness();
    h.claim.resolveWith({ outcome: 'replay', response: { runId: 'earlier' } });
    await h.core.startRun(runBody());
    expect(h.claim.calls).toHaveLength(1);
    expect(h.executor.starts).toEqual([]);
  });

  it('arms exactly one alarm, at the 15-minute hard stop, for a text run', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    expect(h.alarms.set).toEqual([10_000 + 15 * 60 * 1000]);
  });

  it('forwards the run body history to the executor start request', async () => {
    const h = makeHarness();
    const history = [
      { role: 'user' as const, content: 'first question' },
      { role: 'assistant' as const, content: 'first answer' },
    ];
    await h.core.startRun({ ...runBody(), history });
    expect(h.executor.starts[0]?.history).toEqual(history);
  });

  it('forwards the DO-minted runId — never the client runKey — to the executor start request', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody('client-supplied-key'));
    // The executor tags this id on a cost-circuit Sentry event; it must be the
    // server-minted run id (`newRunId()` → 'run-1' here), never the
    // attacker-controllable Idempotency-Key.
    expect(h.executor.starts[0]?.runId).toBe('run-1');
    expect(h.executor.starts[0]?.runId).not.toBe('client-supplied-key');
    expect(h.executor.starts[0]?.runKey).toBe('client-supplied-key');
  });

  it('forwards a trial run body history to the executor start request', async () => {
    const h = makeHarness();
    const history = [{ role: 'user' as const, content: 'earlier' }];
    await h.core.startRun({ ...trialRunBody(), history });
    expect(h.executor.starts[0]?.history).toEqual(history);
  });

  it('forwards the run body custom instructions to the executor start request', async () => {
    const h = makeHarness();
    await h.core.startRun({ ...runBody(), customInstructions: 'answer only in French' });
    expect(h.executor.starts[0]?.customInstructions).toBe('answer only in French');
  });

  it('omits custom instructions from the executor start request when the body carries none', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    expect(h.executor.starts[0]?.customInstructions).toBeUndefined();
  });

  it('maps run body mockDirectives onto the run context and the executor start request', async () => {
    const h = makeHarness();
    const mockDirectives = { classifierResolution: 'a/model', failingModels: ['m1'] };
    await h.core.startRun({ ...runBody(), mockDirectives });
    expect(h.bindHookCalls[0]?.context.mockDirectives).toEqual(mockDirectives);
    expect(h.executor.starts[0]?.mockDirectives).toEqual(mockDirectives);
  });

  it('omits mockDirectives from the context and start request when the body carries none', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    expect(h.bindHookCalls[0]?.context.mockDirectives).toBeUndefined();
    expect(h.executor.starts[0]?.mockDirectives).toBeUndefined();
  });

  it('binds the hooks with the run context including the captured fence', async () => {
    const h = makeHarness();
    h.claim.resolveWith({
      outcome: 'executor',
      fence: { id: 'row-9', executorId: 'exec-9', claims: 2 },
    });
    const body = runBody();
    await h.core.startRun(body);
    expect(h.bindHookCalls).toEqual([
      {
        context: {
          mode: 'paid',
          payerUserId: 'u1',
          sender: { kind: 'user', userId: 'sender-1' },
          conversationId: 'c1',
          walletId: 'w1',
          epochNumber: 3,
          userMessage: { id: 'um1', content: 'hi' },
          // The DO-minted run id is threaded into the run context.
          runId: 'run-1',
          fence: { id: 'row-9', executorId: 'exec-9', claims: 2 },
        },
        definition: body.definition,
      },
    ]);
  });

  it('threads a paid run forkId into the bound run context', async () => {
    const h = makeHarness();
    h.claim.resolveWith({
      outcome: 'executor',
      fence: { id: 'row-9', executorId: 'exec-9', claims: 2 },
    });
    const base = runBody();
    if (base.mode !== 'paid') throw new Error('expected a paid run body');
    await h.core.startRun({ ...base, forkId: 'fork-1' });
    expect(h.bindHookCalls[0]?.context).toMatchObject({ mode: 'paid', forkId: 'fork-1' });
  });

  it('threads a paid run regenerate action into the bound run context', async () => {
    const h = makeHarness();
    h.claim.resolveWith({
      outcome: 'executor',
      fence: { id: 'row-9', executorId: 'exec-9', claims: 2 },
    });
    const base = runBody();
    if (base.mode !== 'paid') throw new Error('expected a paid run body');
    await h.core.startRun({
      ...base,
      regenerate: { action: 'retry', targetMessageId: 'anchor-1', replaceAssistantId: 'a1' },
    });
    expect(h.bindHookCalls[0]?.context).toMatchObject({
      mode: 'paid',
      regenerate: { action: 'retry', targetMessageId: 'anchor-1', replaceAssistantId: 'a1' },
    });
  });

  it('threads a paid regenerate observed fork tip into the bound run context', async () => {
    const h = makeHarness();
    h.claim.resolveWith({
      outcome: 'executor',
      fence: { id: 'row-9', executorId: 'exec-9', claims: 2 },
    });
    const base = runBody();
    if (base.mode !== 'paid') throw new Error('expected a paid run body');
    await h.core.startRun({
      ...base,
      regenerate: { action: 'retry', targetMessageId: 'anchor-1', observedForkTipId: 'tip-1' },
    });
    const context = h.bindHookCalls[0]?.context;
    if (context?.mode !== 'paid') throw new Error('expected a paid context');
    expect(context.regenerate?.observedForkTipId).toBe('tip-1');
  });

  it('threads a paid edit regenerate without a replaceAssistantId', async () => {
    const h = makeHarness();
    h.claim.resolveWith({
      outcome: 'executor',
      fence: { id: 'row-9', executorId: 'exec-9', claims: 2 },
    });
    const base = runBody();
    if (base.mode !== 'paid') throw new Error('expected a paid run body');
    await h.core.startRun({
      ...base,
      regenerate: { action: 'edit', targetMessageId: 'anchor-1' },
    });
    const context = h.bindHookCalls[0]?.context;
    expect(context).toMatchObject({
      mode: 'paid',
      regenerate: { action: 'edit', targetMessageId: 'anchor-1' },
    });
    if (context?.mode !== 'paid') throw new Error('expected a paid context');
    expect(context.regenerate?.replaceAssistantId).toBeUndefined();
  });

  it('hands the executor the definition, inputs, runKey, and bound hooks', async () => {
    const h = makeHarness();
    const body = runBody();
    await h.core.startRun(body);
    const request = h.executor.starts[0];
    expect(request).toMatchObject({ definition: body.definition, inputs: {}, runKey: 'key-1' });
    await expect(
      request?.hooks.admission({ definition: body.definition, estimate: '0' as never })
    ).resolves.toEqual({ admitted: true, holdRef: 'hold-1' });
  });

  it('replays the stored outcome without executing when the referee replays', async () => {
    const h = makeHarness();
    h.claim.resolveWith({ outcome: 'replay', response: { runId: 'settled-run' } });
    await expect(h.core.startRun(runBody())).resolves.toEqual({
      ok: true,
      outcome: 'replay',
      response: { runId: 'settled-run' },
    });
    expect(h.executor.starts).toEqual([]);
    expect(h.bindHookCalls).toEqual([]);
    expect(h.alarms.set).toEqual([]);
  });

  it('releases the in-memory claim after a replay so a new run can start', async () => {
    const h = makeHarness();
    h.claim.resolveWith({ outcome: 'replay', response: null });
    await h.core.startRun(runBody());
    h.claim.resolveWith({ outcome: 'executor', fence: DEFAULT_FENCE });
    await expect(h.core.startRun(runBody('key-2'))).resolves.toMatchObject({
      ok: true,
      outcome: 'executor',
    });
  });

  it('returns the attach outcome without executing when the referee attaches', async () => {
    const h = makeHarness();
    h.claim.resolveWith({ outcome: 'attach' });
    // No run is live in this room, so no message id can be named.
    await expect(h.core.startRun(runBody())).resolves.toEqual({
      ok: true,
      outcome: 'attach',
      userMessageId: null,
      assistantMessageIds: null,
    });
    expect(h.executor.starts).toEqual([]);
    expect(h.alarms.set).toEqual([]);
  });

  it('releases the in-memory claim after an attach so a new run can start', async () => {
    const h = makeHarness();
    h.claim.resolveWith({ outcome: 'attach' });
    await h.core.startRun(runBody());
    h.claim.resolveWith({ outcome: 'executor', fence: DEFAULT_FENCE });
    await expect(h.core.startRun(runBody('key-2'))).resolves.toMatchObject({
      ok: true,
      outcome: 'executor',
    });
  });

  it('returns a 409 conflict without executing when the referee reports a body mismatch', async () => {
    const h = makeHarness();
    h.claim.resolveWith({ outcome: 'conflict', code: 'IDEMPOTENCY_BODY_MISMATCH' });
    await expect(h.core.startRun(runBody())).resolves.toEqual({
      ok: false,
      code: 'IDEMPOTENCY_BODY_MISMATCH',
    });
    expect(h.executor.starts).toEqual([]);
    expect(h.bindHookCalls).toEqual([]);
    expect(h.alarms.set).toEqual([]);
  });

  it('releases the in-memory claim after a conflict so a new run can start', async () => {
    const h = makeHarness();
    h.claim.resolveWith({ outcome: 'conflict', code: 'IDEMPOTENCY_BODY_MISMATCH' });
    await h.core.startRun(runBody());
    h.claim.resolveWith({ outcome: 'executor', fence: DEFAULT_FENCE });
    await expect(h.core.startRun(runBody('key-2'))).resolves.toMatchObject({
      ok: true,
      outcome: 'executor',
    });
  });

  it('releases the in-memory claim and rethrows when the referee errors', async () => {
    const h = makeHarness();
    h.claim.failNext();
    await expect(h.core.startRun(runBody())).rejects.toThrow('referee unavailable');
    expect(h.executor.starts).toEqual([]);
    expect(h.alarms.set).toEqual([]);
    await expect(h.core.startRun(runBody('key-2'))).resolves.toMatchObject({ ok: true });
  });

  it('rejects a concurrent second run with the typed code without claiming again', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    await expect(h.core.startRun(runBody('key-2'))).resolves.toEqual({
      ok: false,
      code: 'CONCURRENT_RUN',
    });
    // The durable referee is never reached for the blocked second run.
    expect(h.claim.calls).toHaveLength(1);
  });

  it('records telemetry for the concurrent rejection', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    await h.core.startRun(runBody('key-2'));
    expect(h.telemetry).toContainEqual({
      method: 'runRejected',
      fields: { conversationId: 'c1', errorCode: 'CONCURRENT_RUN' },
    });
  });

  it('enqueues the run-started frame ahead of the first stream frame', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.emit({
      streamId: 's1',
      cursor: 1,
      event: { kind: 'text-delta', index: 0, content: 'hi' },
    });
    await h.core.settled();
    const kinds = frames(socket).map((frame) => frame.type);
    expect(kinds[0]).toBe('run-started');
    expect(kinds).toEqual(['run-started', 'stream']);
  });

  it('releases the claim and rethrows when the executor fails to start', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    h.executor.failNextStart();
    await expect(h.core.startRun(runBody())).rejects.toThrow('executor exploded');
    // A synchronous throw must leave no run-started frame with no matching
    // run-finished — nothing is enqueued for the doomed run.
    await h.core.settled();
    expect(socket.sent).toEqual([]);
    await expect(h.core.startRun(runBody('key-2'))).resolves.toMatchObject({ ok: true });
  });

  it('deletes the alarm when the executor fails to start', async () => {
    const h = makeHarness();
    h.executor.failNextStart();
    await expect(h.core.startRun(runBody())).rejects.toThrow('executor exploded');
    expect(h.alarms.deleted).toBe(1);
  });

  it('rejects the start when arming the deadline alarm fails', async () => {
    const h = makeHarness({ alarmSetRejects: true });
    await expect(h.core.startRun(runBody())).rejects.toThrow('alarm write failed');
  });

  it('starts no executor run when arming the deadline alarm fails', async () => {
    const h = makeHarness({ alarmSetRejects: true });
    await expect(h.core.startRun(runBody())).rejects.toThrow('alarm write failed');
    expect(h.executor.starts).toEqual([]);
  });

  it('frees the key row for retry when arming the deadline alarm fails', async () => {
    const h = makeHarness({ alarmSetRejects: true });
    await expect(h.core.startRun(runBody())).rejects.toThrow('alarm write failed');
    expect(h.money.failedFences).toEqual([DEFAULT_FENCE]);
  });
});

describe('stream delivery', () => {
  const delta: FlowStreamEvent = {
    streamId: 's1',
    cursor: 1,
    event: { kind: 'text-delta', index: 0, content: 'hi' },
  };

  it('fans emitted events out as stream frames', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    await h.core.settled();
    expect(frames(socket)).toContainEqual({
      type: 'stream',
      streamId: 's1',
      cursor: 1,
      event: { kind: 'text-delta', index: 0, content: 'hi' },
    });
  });

  it('replays buffered events to a socket declaring a gap', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    await h.core.settled();
    const reconnected = h.addSocket('u1');
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    await h.core.settled();
    expect(replayed(reconnected)).toEqual([
      {
        type: 'stream',
        streamId: 's1',
        cursor: 1,
        event: { kind: 'text-delta', index: 0, content: 'hi' },
      },
    ]);
  });

  it('replays nothing to a revoked principal', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    await h.core.settled();
    const reconnected = h.addSocket('u1');
    h.decisions.set('u1', 'revoked');
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    await h.core.settled();
    expect(replayed(reconnected)).toEqual([]);
  });

  it('closes a revoked principal declaring a gap', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    await h.core.settled();
    const reconnected = h.addSocket('u1');
    h.decisions.set('u1', 'revoked');
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    await h.core.settled();
    expect(reconnected.closed).toContainEqual({ code: 1008, reason: 'revoked' });
  });

  it('replays a reconnecting socket its declared gap ahead of the live frames queued behind it', async () => {
    const h = makeHarness();
    h.addSocket('u2');
    await h.core.startRun(runBody());
    await h.core.settled();
    // Park the first frame's fan-out so a second queues behind it: the state a
    // reconnecting socket arrives into, where the queued frame would otherwise
    // reach it before its catch-up and burn its cursor.
    h.verify.holdNext();
    h.executor.emit(delta);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.executor.emit({ ...delta, cursor: 2 });
    const reconnected = h.addSocket('u1');
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    h.verify.release();
    await h.core.settled();
    expect(streamCursors(reconnected)).toEqual([1, 2]);
  });

  it('resumes live fan-out to a reconnecting socket once its declared replay is written', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    await h.core.settled();
    const reconnected = h.addSocket('u1');
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    h.executor.emit({ ...delta, cursor: 2 });
    await h.core.settled();
    expect(streamCursors(reconnected)).toEqual([1, 2]);
  });

  it('withholds nothing from a socket that declares no cursors', async () => {
    const h = makeHarness();
    h.addSocket('u2');
    await h.core.startRun(runBody());
    await h.core.settled();
    h.verify.holdNext();
    h.executor.emit(delta);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.executor.emit({ ...delta, cursor: 2 });
    const joiner = h.addSocket('u1');
    h.core.completeOpen(joiner);
    h.verify.release();
    await h.core.settled();
    // The queued live frame still reaches a socket with no gap to catch up on,
    // which is what a fresh joiner and a reloaded client both are.
    expect(streamCursors(joiner)).toEqual([2]);
  });

  it("delivers a sibling stream's queued frame to a socket that declared only the other stream", async () => {
    const h = makeHarness();
    h.addSocket('u2');
    await h.core.startRun(runBody());
    await h.core.settled();
    // Park one stream's token so a sibling stream's token queues behind it —
    // the multi-model shape, where a stream that began while the client was
    // away cannot appear in the declaration, because the client builds that
    // list only from frames it received. Its opening frame is what binds the
    // stream, and no replay reproduces it.
    h.verify.holdNext();
    h.executor.emit(delta);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.executor.emit({ ...delta, streamId: 's2' });
    const reconnected = h.addSocket('u1');
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    h.verify.release();
    await h.core.settled();
    const streamIds = frames(reconnected)
      .filter((frame) => frame.type === 'stream')
      .map((frame) => frame.streamId);
    expect(streamIds).toEqual(['s2', 's1']);
  });

  it('delivers a live stream to a socket declaring a stream the room cannot replay', async () => {
    const h = makeHarness();
    h.addSocket('u2');
    await h.core.startRun(runBody());
    await h.core.settled();
    h.verify.holdNext();
    h.executor.emit(delta);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.executor.emit({ ...delta, cursor: 2 });
    const reconnected = h.addSocket('u1');
    h.core.completeOpen(reconnected, [{ streamId: 'gone', lastEventId: 0, runId: 'run-1' }]);
    h.verify.release();
    await h.core.settled();
    // Only the queued frame: the parked one captured its socket list before
    // this socket existed, so it was never addressed to it, filter or none.
    expect(streamCursors(reconnected)).toEqual([2]);
    expect(frames(reconnected)).toContainEqual({ type: 'stream-gone', streamId: 'gone' });
  });

  it("delivers the next run's opening frame to a socket still awaiting its declared replay", async () => {
    const h = makeHarness();
    h.addSocket('u2');
    await h.core.startRun(runBody());
    await h.core.settled();
    // Park a token's fan-out, then run the room past a terminal into the next
    // run: both lifecycle frames queue behind the parked link, where the socket
    // arriving mid-queue would be held out of them and no later write repeats.
    h.verify.holdNext();
    h.executor.emit(delta);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.executor.finish({ outcome: 'succeeded' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.core.startRun(runBody());
    const reconnected = h.addSocket('u1');
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 0, runId: 'run-2' }]);
    h.verify.release();
    await h.core.settled();
    expect(frames(reconnected).filter((frame) => frame.type === 'run-started')).toHaveLength(1);
  });

  it("delivers the run's terminal frame to a socket still awaiting its declared replay", async () => {
    const h = makeHarness();
    h.addSocket('u2');
    await h.core.startRun(runBody());
    await h.core.settled();
    h.verify.holdNext();
    h.executor.emit(delta);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.executor.finish({ outcome: 'succeeded' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reconnected = h.addSocket('u1');
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    h.verify.release();
    await h.core.settled();
    const terminal = frames(reconnected).filter((frame) => frame.type === 'run-finished');
    expect(terminal).toHaveLength(1);
  });

  it('answers stream-gone for a declared stream the room cannot replay', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    h.core.completeOpen(socket, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    await h.core.settled();
    expect(frames(socket)).toContainEqual({ type: 'stream-gone', streamId: 's1' });
  });

  it('replays a cursor declared against the run the room is live in', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    await h.core.settled();
    const reconnected = h.addSocket('u1');
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    await h.core.settled();
    expect(streamCursors(reconnected)).toEqual([1]);
  });

  it('answers stream-gone for a cursor declared against a run the room is not live in', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    h.executor.emit({ ...delta, cursor: 2 });
    await h.core.settled();
    const reconnected = h.addSocket('u1');
    // The client saw the first run's `s1` at cursor 1, slept through the
    // turnover, and declares that cursor against a run that reuses the id and
    // is already past it. Replaying from it would hand the client the tail of a
    // stream whose head it has never seen, with nothing saying so.
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 1, runId: 'run-1' }]);
    await h.core.settled();
    expect(replayed(reconnected)).toEqual([{ type: 'stream-gone', streamId: 's1' }]);
  });

  it("answers stream-gone for a cursor another run's stream has exactly reached", async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    await h.core.settled();
    const reconnected = h.addSocket('u1');
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 1, runId: 'run-1' }]);
    await h.core.settled();
    expect(replayed(reconnected)).toEqual([{ type: 'stream-gone', streamId: 's1' }]);
  });

  it('returns a socket to fan-out once a stale declaration is answered', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    await h.core.settled();
    const reconnected = h.addSocket('u1');
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 1, runId: 'run-1' }]);
    await h.core.settled();
    h.executor.emit({ ...delta, cursor: 2 });
    await h.core.settled();
    // The refusal is an answer like any other: the withhold ends with it, so
    // the live run reaches this socket from the frame after it.
    expect(streamCursors(reconnected)).toEqual([2]);
  });

  it("answers stream-gone for a cursor beyond another run's stream", async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    await h.core.settled();
    const reconnected = h.addSocket('u1');
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 5, runId: 'run-1' }]);
    await h.core.settled();
    expect(replayed(reconnected)).toEqual([{ type: 'stream-gone', streamId: 's1' }]);
  });

  it('answers stream-gone to a declaration after the stream overflows its budget', async () => {
    const h = makeHarness({ maxStreamBytes: 10 });
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    await h.core.settled();
    const reconnected = h.addSocket('u1');
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    await h.core.settled();
    expect(replayed(reconnected)).toEqual([{ type: 'stream-gone', streamId: 's1' }]);
  });

  it('answers stream-gone to a declaration for the stream the run budget evicted', async () => {
    // Neither stream comes near the per-stream cap, so the eviction here can
    // only be the run-total budget.
    const h = makeHarness({ maxRunBytes: 400 });
    await h.core.startRun(runBody());
    h.executor.emit({
      ...delta,
      event: { kind: 'text-delta', index: 0, content: 'a'.repeat(300) },
    });
    h.executor.emit({
      streamId: 's2',
      cursor: 1,
      event: { kind: 'text-delta', index: 0, content: 'b' },
    });
    await h.core.settled();
    const reconnected = h.addSocket('u1');
    h.core.completeOpen(reconnected, [
      { streamId: 's1', lastEventId: 0, runId: 'run-1' },
      { streamId: 's2', lastEventId: 0, runId: 'run-1' },
    ]);
    await h.core.settled();
    expect(replayed(reconnected)).toEqual([
      { type: 'stream-gone', streamId: 's1' },
      {
        type: 'stream',
        streamId: 's2',
        cursor: 1,
        event: { kind: 'text-delta', index: 0, content: 'b' },
      },
    ]);
  });

  it('preserves token order through to the finish frame', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.emit(delta);
    h.executor.emit({ ...delta, cursor: 2 });
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    const cursors = frames(socket)
      .filter((frame) => frame.type === 'stream' || frame.type === 'run-finished')
      .map((frame) => (frame.type === 'stream' ? frame.cursor : 'finished'));
    expect(cursors).toEqual([1, 2, 'finished']);
  });
});

describe('stream delivery of provider cost and usage', () => {
  function costBearingEvents(): FlowStreamEvent[] {
    return [
      {
        streamId: 's1',
        cursor: 1,
        event: { kind: 'step-finish', step: 0, generationId: 'gen-1', providerCostUsd: 0.002 },
      },
      {
        streamId: 's1',
        cursor: 2,
        event: {
          kind: 'finish',
          metadata: {
            generationId: 'gen-1',
            providerCostUsd: 0.0042,
            usage: { inputTokens: 120, outputTokens: 80, reasoningTokens: 30 },
            finishReason: 'stop',
            raw: { usage: { prompt_tokens: 120, completion_tokens: 80 }, cost: 0.0042 },
          },
          reasoningEffort: 'high',
        },
      },
    ];
  }

  const deliveredFrames: ServerFrame[] = [
    {
      type: 'stream',
      streamId: 's1',
      cursor: 1,
      event: { kind: 'step-finish', step: 0, generationId: 'gen-1' },
    },
    {
      type: 'stream',
      streamId: 's1',
      cursor: 2,
      event: {
        kind: 'finish',
        metadata: {
          generationId: 'gen-1',
          usage: { reasoningTokens: 30 },
          finishReason: 'stop',
        },
        reasoningEffort: 'high',
      },
    },
  ];

  it('delivers live frames without cost and with only the reasoning count to a member', async () => {
    const h = makeHarness();
    const member = h.addSocket('u1');
    await h.core.startRun(runBody());
    for (const event of costBearingEvents()) h.executor.emit(event);
    await h.core.settled();
    expect(replayed(member)).toStrictEqual(deliveredFrames);
  });

  it('delivers live frames without cost and with only the reasoning count to a link guest', async () => {
    const h = makeHarness();
    const guest = h.addSocket('link-1', { isGuest: true });
    await h.core.startRun(guestRunBody());
    for (const event of costBearingEvents()) h.executor.emit(event);
    await h.core.settled();
    expect(replayed(guest)).toStrictEqual(deliveredFrames);
  });

  it('replays frames without cost and with only the reasoning count to a member', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    for (const event of costBearingEvents()) h.executor.emit(event);
    await h.core.settled();
    const member = h.addSocket('u1');
    h.core.completeOpen(member, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    await h.core.settled();
    expect(replayed(member)).toStrictEqual(deliveredFrames);
  });

  it('replays frames without cost and with only the reasoning count to a link guest', async () => {
    const h = makeHarness();
    await h.core.startRun(guestRunBody());
    for (const event of costBearingEvents()) h.executor.emit(event);
    await h.core.settled();
    const guest = h.addSocket('link-1', { isGuest: true });
    h.core.completeOpen(guest, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    await h.core.settled();
    expect(replayed(guest)).toStrictEqual(deliveredFrames);
  });

  it('delivers no raw provider response to a member or a link guest, live or on replay', async () => {
    const h = makeHarness();
    const liveMember = h.addSocket('u1');
    const liveGuest = h.addSocket('link-1', { isGuest: true });
    await h.core.startRun(runBody());
    for (const event of costBearingEvents()) h.executor.emit(event);
    await h.core.settled();
    const replayMember = h.addSocket('u1');
    const replayGuest = h.addSocket('link-1', { isGuest: true });
    h.core.completeOpen(replayMember, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    h.core.completeOpen(replayGuest, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    await h.core.settled();
    const finishes = [liveMember, liveGuest, replayMember, replayGuest].flatMap((socket) =>
      replayed(socket).filter((frame) => frame.type === 'stream' && frame.event.kind === 'finish')
    );
    expect(finishes).toHaveLength(4);
    for (const frame of finishes) expect(frame).not.toHaveProperty('event.metadata.raw');
  });

  it('leaves the emitted events carrying their cost and usage for in-process readers', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    await h.core.startRun(runBody());
    const emitted = costBearingEvents();
    for (const event of emitted) h.executor.emit(event);
    await h.core.settled();
    const member = h.addSocket('u1');
    h.core.completeOpen(member, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    await h.core.settled();
    expect(emitted).toStrictEqual(costBearingEvents());
  });
});

describe('run completion', () => {
  it('broadcasts the run-finished frame with the outcome', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    expect(frames(socket)).toContainEqual({
      type: 'run-finished',
      runId: 'run-1',
      outcome: { outcome: 'succeeded' },
    });
  });

  it('answers stream-gone for a cursor declared against a run that has finished', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.emit({
      streamId: 's1',
      cursor: 1,
      event: { kind: 'text-delta', index: 0, content: 'x' },
    });
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    const reconnected = h.addSocket('u1');
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    await h.core.settled();
    expect(replayed(reconnected)).toEqual([{ type: 'stream-gone', streamId: 's1' }]);
  });

  it('releases the claim so a new run can start', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    await expect(h.core.startRun(runBody('key-2'))).resolves.toMatchObject({ ok: true });
  });

  it('deletes the deadline alarm', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    expect(h.alarms.deleted).toBe(1);
  });

  it('records telemetry with the failure code when the run fails', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'failed', code: 'TIMEOUT' });
    await h.core.settled();
    expect(h.telemetry).toContainEqual({
      method: 'runFinished',
      fields: { conversationId: 'c1', runId: 'run-1', errorCode: 'TIMEOUT' },
    });
  });

  it('contains a rejected done promise as a failed run', async () => {
    const h = makeHarness({ doneRejects: true });
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    await h.core.settled();
    expect(frames(socket)).toContainEqual({
      type: 'run-finished',
      runId: 'run-1',
      outcome: { outcome: 'failed', code: 'INTERNAL' },
    });
  });

  function recordingNotify(overrides: { throws?: boolean; rejects?: boolean } = {}): {
    notify: RoomNotify;
    calls: RoomPushNotification[];
  } {
    const calls: RoomPushNotification[] = [];
    return {
      calls,
      notify: (notification) => {
        calls.push(notification);
        if (overrides.throws === true) throw new Error('push blew up');
        if (overrides.rejects === true) return Promise.reject(new Error('push rejected'));
        return Promise.resolve();
      },
    };
  }

  it('fires push for a succeeded paid run, sourcing the sender from the principal', async () => {
    const recorder = recordingNotify();
    const h = makeHarness({ notify: recorder.notify });
    h.addSocket('watcher-1');
    const base = runBody();
    if (base.mode !== 'paid') throw new Error('expected a paid run body');
    // Two distinct ids, so the assertion below discriminates against the wrong
    // answer: the payer (`userId`, 'u1') rather than the sender principal the
    // push must read. The two diverge on every owner-funded turn.
    await h.core.startRun({
      ...base,
      sender: { kind: 'user', userId: 'principal-sender-1' },
    });
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    expect(recorder.calls).toEqual([
      { conversationId: 'c1', senderUserId: 'principal-sender-1', presentUserIds: ['watcher-1'] },
    ]);
  });

  it('fires push for a guest send with the linkId as the sender', async () => {
    const recorder = recordingNotify();
    const h = makeHarness({ notify: recorder.notify });
    h.addSocket('watcher-1');
    await h.core.startRun(guestRunBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    expect(recorder.calls).toEqual([
      { conversationId: 'c1', senderUserId: 'link-1', presentUserIds: ['watcher-1'] },
    ]);
  });

  it('does not fire push for a trial run', async () => {
    const recorder = recordingNotify();
    const h = makeHarness({ notify: recorder.notify });
    await h.core.startRun(trialRunBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    expect(recorder.calls).toEqual([]);
  });

  it('does not fire push for a failed run', async () => {
    const recorder = recordingNotify();
    const h = makeHarness({ notify: recorder.notify });
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'failed', code: 'TIMEOUT' });
    await h.core.settled();
    expect(recorder.calls).toEqual([]);
  });

  it('does not fire push for a stopped run', async () => {
    const recorder = recordingNotify();
    const h = makeHarness({ notify: recorder.notify });
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'stopped' });
    await h.core.settled();
    expect(recorder.calls).toEqual([]);
  });

  it('completes the run when the push capability throws', async () => {
    const recorder = recordingNotify({ throws: true });
    const h = makeHarness({ notify: recorder.notify });
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    expect(recorder.calls).toHaveLength(1);
    expect(frames(socket)).toContainEqual({
      type: 'run-finished',
      runId: 'run-1',
      outcome: { outcome: 'succeeded' },
    });
  });

  it('completes the run when the push capability rejects asynchronously', async () => {
    const recorder = recordingNotify({ rejects: true });
    const h = makeHarness({ notify: recorder.notify });
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    expect(recorder.calls).toHaveLength(1);
    expect(frames(socket)).toContainEqual({
      type: 'run-finished',
      runId: 'run-1',
      outcome: { outcome: 'succeeded' },
    });
  });

  it('finishes a succeeded paid run unchanged when no push is wired', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    expect(frames(socket)).toContainEqual({
      type: 'run-finished',
      runId: 'run-1',
      outcome: { outcome: 'succeeded' },
    });
  });

  it('drops a late emission after the run finished', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    socket.sent.length = 0;
    h.executor.emit({
      streamId: 's1',
      cursor: 1,
      event: { kind: 'text-delta', index: 0, content: 'late' },
    });
    await h.core.settled();
    expect(socket.sent).toEqual([]);
  });
});

// runBody: payer `u1`, sender `sender-1`. guestRunBody: payer `owner-1`,
// sender the link guest `link-1`.
const SENDER: SenderPrincipal = { kind: 'user', userId: 'sender-1' };
const PAYER: SenderPrincipal = { kind: 'user', userId: 'u1' };
const GUEST_SENDER: SenderPrincipal = { kind: 'linkGuest', linkId: 'link-1' };
const GUEST_PAYER: SenderPrincipal = { kind: 'user', userId: 'owner-1' };

describe('stopRun', () => {
  it("forwards the sender's stop to the executor handle", async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    expect(h.core.stopRun(SENDER)).toBe('stopped');
    expect(h.executor.stops).toEqual(['user-stop']);
  });

  it('stops a run the payer did not send', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    expect(h.core.stopRun(PAYER)).toBe('stopped');
    expect(h.executor.stops).toEqual(['user-stop']);
  });

  it('stops a guest-sent run for the link guest that sent it', async () => {
    const h = makeHarness();
    await h.core.startRun(guestRunBody());
    expect(h.core.stopRun(GUEST_SENDER)).toBe('stopped');
    expect(h.executor.stops).toEqual(['user-stop']);
  });

  it('stops a guest-sent run for the owner funding it', async () => {
    const h = makeHarness();
    await h.core.startRun(guestRunBody());
    expect(h.core.stopRun(GUEST_PAYER)).toBe('stopped');
    expect(h.executor.stops).toEqual(['user-stop']);
  });

  it('refuses a member who is neither the sender nor the payer', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    expect(h.core.stopRun({ kind: 'user', userId: 'bystander-1' })).toBe('refused');
    expect(h.executor.stops).toEqual([]);
  });

  it('refuses a link guest that did not send the run', async () => {
    const h = makeHarness();
    await h.core.startRun(guestRunBody());
    expect(h.core.stopRun({ kind: 'linkGuest', linkId: 'link-2' })).toBe('refused');
    expect(h.executor.stops).toEqual([]);
  });

  it("refuses a member whose userId spells the guest sender's linkId", async () => {
    const h = makeHarness();
    await h.core.startRun(guestRunBody());
    expect(h.core.stopRun({ kind: 'user', userId: 'link-1' })).toBe('refused');
    expect(h.executor.stops).toEqual([]);
  });

  it('refuses every caller on a trial run, which has no payer', async () => {
    const h = makeHarness();
    await h.core.startRun(trialRunBody());
    expect(h.core.stopRun({ kind: 'user', userId: 'session-1' })).toBe('refused');
    expect(h.executor.stops).toEqual([]);
  });

  it('reports no active run when nothing is running', () => {
    const h = makeHarness();
    expect(h.core.stopRun(SENDER)).toBe('no-run');
  });

  it('reports no active run on a repeat stop once the run has finished', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    expect(h.core.stopRun(SENDER)).toBe('stopped');
    h.executor.finish({ outcome: 'stopped' });
    await h.core.settled();
    expect(h.core.stopRun(SENDER)).toBe('no-run');
  });
});

describe('onAlarm', () => {
  it('aborts the active run with the hard-stop reason', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.core.onAlarm();
    expect(h.executor.aborts).toEqual(['deadline-hard']);
  });

  it('does not stop the active run', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.core.onAlarm();
    expect(h.executor.stops).toEqual([]);
  });

  it('records deadline telemetry for the aborted run', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.core.onAlarm();
    expect(h.telemetry).toContainEqual({
      method: 'deadlineFired',
      fields: { conversationId: 'c1', runId: 'run-1' },
    });
  });

  it('is a no-op without an active run', () => {
    const h = makeHarness();
    h.core.onAlarm();
    expect(h.telemetry).toEqual([]);
  });
});

describe('evict', () => {
  it('closes only the matching principal sockets', async () => {
    const h = makeHarness();
    const target = h.addSocket('u1');
    const targetSecond = h.addSocket('u1');
    const other = h.addSocket('u2');
    const closed = await h.core.evict('u1');
    expect(closed).toBe(2);
    expect(target.closed).toEqual([{ code: 1008, reason: 'evicted' }]);
    expect(targetSecond.closed).toEqual([{ code: 1008, reason: 'evicted' }]);
    expect(other.closed).toEqual([]);
  });

  it('closes only the named session’s socket when a session id is given', async () => {
    const h = makeHarness();
    const signedOut = h.addSocket('u1', { session: { id: 's1', createdAt: 100 } });
    const otherDevice = h.addSocket('u1', { session: { id: 's2', createdAt: 200 } });
    const closed = await h.core.evict('u1', 's1');
    expect(closed).toBe(1);
    expect(signedOut.closed).toEqual([{ code: 1008, reason: 'evicted' }]);
    expect(otherDevice.closed).toEqual([]);
  });

  it('closes a matching-principal socket carrying no session snapshot', async () => {
    // Fail-closed: a socket that cannot be attributed to a device is cut rather
    // than spared, which is the direction an authorization input must fail in.
    const h = makeHarness();
    const unattributable = h.addSocket('u1');
    const closed = await h.core.evict('u1', 's1');
    expect(closed).toBe(1);
    expect(unattributable.closed).toEqual([{ code: 1008, reason: 'evicted' }]);
  });

  it('closes every device of the principal when no session id is given', async () => {
    const h = makeHarness();
    const first = h.addSocket('u1', { session: { id: 's1', createdAt: 100 } });
    const second = h.addSocket('u1', { session: { id: 's2', createdAt: 200 } });
    const other = h.addSocket('u2', { session: { id: 's3', createdAt: 300 } });
    const closed = await h.core.evict('u1');
    expect(closed).toBe(2);
    expect(first.closed).toEqual([{ code: 1008, reason: 'evicted' }]);
    expect(second.closed).toEqual([{ code: 1008, reason: 'evicted' }]);
    expect(other.closed).toEqual([]);
  });

  it('keeps delivering to a spared device whose own session is live', async () => {
    const h = makeHarness({ sessionVerifier: sessionVerifierFor(new Map()) });
    const spared = h.addSocket('u1', { session: { id: 's2', createdAt: 200 } });
    const closed = await h.core.evict('u1', 's1');
    expect(closed).toBe(0);
    expect(spared.closed).toEqual([]);
    expect(
      frames(spared).some(
        (frame) => frame.type === 'event' && frame.event.type === 'presence:update'
      )
    ).toBe(true);
  });

  it('cuts a spared device whose own session was revoked, delivering nothing to it', async () => {
    // The narrowing's other direction, asserted rather than argued: scoping the
    // fan-out by session cannot leave a revoked session receiving frames,
    // because every delivery is still session-checked (session-liveness.ts).
    const decisions = new Map<string, SessionDecision>([['u1:s2:200', 'revoked']]);
    const h = makeHarness({ sessionVerifier: sessionVerifierFor(decisions) });
    const spared = h.addSocket('u1', { session: { id: 's2', createdAt: 200 } });
    const closed = await h.core.evict('u1', 's1');
    expect(closed).toBe(0);
    expect(spared.sent).toEqual([]);
    expect(spared.closed).toEqual([{ code: 1008, reason: 'session-revoked' }]);
  });

  it('broadcasts presence to the remaining members', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    const other = h.addSocket('u2');
    await h.core.evict('u1');
    const presence = frames(other).find(
      (frame) => frame.type === 'event' && frame.event.type === 'presence:update'
    );
    expect(presence).toMatchObject({
      event: { members: [{ userId: 'u2', isGuest: false, connectedAt: 100 }] },
    });
  });
});

describe('presenceSnapshot', () => {
  it('returns deduplicated authenticated user ids', () => {
    const h = makeHarness();
    h.addSocket('u1');
    h.addSocket('u1');
    h.addSocket('link-1', { isGuest: true, displayName: 'Guest' });
    expect(h.core.presenceSnapshot()).toEqual(['u1']);
  });
});

describe('billable-generation metric', () => {
  const stepFinish: FlowStreamEvent = {
    streamId: 's1',
    cursor: 1,
    event: { kind: 'step-finish', step: 0, generationId: 'gen-1' },
  };

  it('records one metric per step-finish, dimensioned by conversation, run, generation id', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.emit(stepFinish);
    await h.core.settled();
    // A killed run commits no usage_records row, so this line is the only place
    // that generation's id is recorded — but nothing reads the line, so the
    // spend it names is unreconcilable after the fact. The id is asserted here
    // because carrying it is what the line is for, not because a reader
    // consumes it.
    expect(h.telemetry).toContainEqual({
      method: 'billableGeneration',
      fields: { conversationId: 'c1', runId: 'run-1', generationId: 'gen-1' },
    });
  });

  it('does not record a generation metric for a token delta', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.emit({
      streamId: 's1',
      cursor: 1,
      event: { kind: 'text-delta', index: 0, content: 'hi' },
    });
    await h.core.settled();
    expect(h.telemetry.some((entry) => entry.method === 'billableGeneration')).toBe(false);
  });
});

describe('mid-stream revocation', () => {
  it('evicts a principal revoked mid-run and delivers no stream frame', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    // Membership is rechecked at broadcast: revoking after the run started must
    // cut the socket at the next stream frame, never leaking the token.
    h.decisions.set('u1', 'revoked');
    h.executor.emit({
      streamId: 's1',
      cursor: 1,
      event: { kind: 'text-delta', index: 0, content: 'secret-token' },
    });
    await h.core.settled();
    expect(frames(socket).some((frame) => frame.type === 'stream')).toBe(false);
    expect(socket.sent.some((data) => data.includes('secret-token'))).toBe(false);
    expect(socket.closed).toContainEqual({ code: 1008, reason: 'revoked' });
  });
});

describe('media stream delivery', () => {
  const mediaStart: FlowStreamEvent = {
    streamId: 's1',
    cursor: 1,
    event: { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
  };
  const mediaDone: FlowStreamEvent = {
    streamId: 's1',
    cursor: 2,
    event: {
      kind: 'media-done',
      index: 0,
      value: {
        ref: 'media/c1/m1/abc',
        mimeType: 'image/png',
        modality: 'image',
        byteLength: 3,
        metadata: {},
      },
    },
  };

  it('fans media events out through the generic stream frame', async () => {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.emit(mediaStart);
    h.executor.emit(mediaDone);
    await h.core.settled();
    expect(frames(socket)).toContainEqual({
      type: 'stream',
      streamId: 's1',
      cursor: 1,
      event: mediaStart.event,
    });
    expect(frames(socket)).toContainEqual({
      type: 'stream',
      streamId: 's1',
      cursor: 2,
      event: mediaDone.event,
    });
  });

  it('replays buffered media events to a socket declaring a gap', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.emit(mediaStart);
    h.executor.emit(mediaDone);
    await h.core.settled();
    const reconnected = h.addSocket('u1');
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    await h.core.settled();
    expect(replayed(reconnected)).toEqual([
      { type: 'stream', streamId: 's1', cursor: 1, event: mediaStart.event },
      { type: 'stream', streamId: 's1', cursor: 2, event: mediaDone.event },
    ]);
  });
});

describe('startRun — synchronous admission', () => {
  it('answers an admission refusal as a start failure with the refusal code', async () => {
    const h = makeHarness({
      admitted: { admitted: false, code: 'INSUFFICIENT_ADMISSION' },
    });
    const result = await h.core.startRun(runBody());
    expect(result).toEqual({ ok: false, code: 'INSUFFICIENT_ADMISSION' });
  });

  it('records the refusal in telemetry', async () => {
    const h = makeHarness({ admitted: { admitted: false, code: 'ADMISSION_UNAVAILABLE' } });
    await h.core.startRun(runBody());
    expect(h.telemetry).toContainEqual({
      method: 'runRejected',
      fields: { conversationId: 'c1', errorCode: 'ADMISSION_UNAVAILABLE' },
    });
  });

  it('still fails the key row when the refused run reaches the sink', async () => {
    const h = makeHarness({ admitted: { admitted: false, code: 'TRIAL_CAPACITY_REACHED' } });
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'failed', code: 'TRIAL_CAPACITY_REACHED' });
    await h.core.settled();
    expect(h.money.failedFences).toEqual([DEFAULT_FENCE]);
    expect(h.money.released).toEqual([]);
  });

  it('releases a hold granted only after the run already finished', async () => {
    const hold = { walletId: 'w1', holdId: 'run-1', scopeIds: [] };
    const h = makeHarness({ manualAdmit: true });
    const pending = h.core.startRun(runBody());
    // startRun awaits the referee before reaching the executor; yield a
    // macrotask so the run is actually started before finishing it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.executor.finish({ outcome: 'failed', code: 'INTERNAL' });
    await h.core.settled();
    h.executor.admit({ admitted: true, hold });
    await pending;
    expect(h.money.released).toEqual([hold]);
  });
});

describe('startRun — same-key attach (no false concurrent-run block)', () => {
  it('passes a same-key resubmit through to the referee and attaches', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody('key-1'));
    h.claim.resolveWith({ outcome: 'attach' });
    const again = await h.core.startRun(runBody('key-1'));
    expect(again).toEqual({
      ok: true,
      outcome: 'attach',
      userMessageId: 'um1',
      assistantMessageIds: ['answer-of-run-1'],
    });
    expect(h.claim.calls).toHaveLength(2);
    // The live run keeps streaming: its in-memory claim survived the resubmit.
    expect(h.core.stopRun({ kind: 'user', userId: 'sender-1' })).toBe('stopped');
  });

  it('blocks a different-key send with CONCURRENT_RUN before the referee', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody('key-1'));
    const blocked = await h.core.startRun(runBody('key-2'));
    expect(blocked).toEqual({ ok: false, code: 'CONCURRENT_RUN' });
    expect(h.claim.calls).toHaveLength(1);
  });

  it('answers attach when the referee hands a same-key resubmit an executor claim', async () => {
    const h = makeHarness();
    await h.core.startRun(runBody('key-1'));
    // A lapsed lease under a live in-memory run: the referee reclaims, but the
    // room must never start a second executor for the same key.
    const again = await h.core.startRun(runBody('key-1'));
    expect(again).toEqual({
      ok: true,
      outcome: 'attach',
      userMessageId: 'um1',
      assistantMessageIds: ['answer-of-run-1'],
    });
    expect(h.executor.starts).toHaveLength(1);
  });

  it("names the live run's user message id, not the resend's, on an attach", async () => {
    const h = makeHarness();
    await h.core.startRun(runBody('key-1'));
    h.claim.resolveWith({ outcome: 'attach' });
    const resend = runBody('key-1');
    if (resend.mode !== 'paid') throw new Error('expected a paid run body');
    const again = await h.core.startRun({
      ...resend,
      userMessage: { id: 'um-resend', content: 'hi' },
    });
    expect(again).toEqual({
      ok: true,
      outcome: 'attach',
      userMessageId: 'um1',
      assistantMessageIds: ['answer-of-run-1'],
    });
  });

  it('attaches a same-key trial resubmit with a null user message id', async () => {
    const h = makeHarness();
    await h.core.startRun(trialRunBody('key-1'));
    h.claim.resolveWith({ outcome: 'attach' });
    const again = await h.core.startRun(trialRunBody('key-1'));
    expect(again).toEqual({
      ok: true,
      outcome: 'attach',
      userMessageId: null,
      assistantMessageIds: [],
    });
  });

  it("names the live run's answer ids to a same-key resend that arrives before the run bound them", async () => {
    const h = makeHarness();
    const release = h.claim.holdNext({ outcome: 'executor', fence: DEFAULT_FENCE });
    const first = h.core.startRun(runBody('key-1'));
    h.claim.resolveWith({ outcome: 'attach' });
    const again = h.core.startRun(runBody('key-1'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await expect(again).resolves.toEqual({
      ok: true,
      outcome: 'attach',
      userMessageId: 'um1',
      assistantMessageIds: ['answer-of-run-1'],
    });
    await first;
  });

  it('names no answer ids to a same-key resend when the start it raced fails before binding', async () => {
    const h = makeHarness();
    const release = h.claim.holdNext(new Error('referee unavailable'));
    const first = h.core.startRun(runBody('key-1'));
    h.claim.resolveWith({ outcome: 'attach' });
    const again = h.core.startRun(runBody('key-1'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await expect(first).rejects.toThrow('referee unavailable');
    await expect(again).resolves.toMatchObject({ outcome: 'attach', assistantMessageIds: null });
  });
});

describe('finishRun — money duties at the terminal sink', () => {
  const HOLD: FlowHoldIdentity = { walletId: 'w1', holdId: 'run-1', scopeIds: ['s1'] };

  async function finishWith(outcome: FlowRunOutcome): Promise<ReturnType<typeof makeHarness>> {
    const h = makeHarness({ admitted: { admitted: true, hold: HOLD } });
    await h.core.startRun(runBody());
    h.executor.finish(outcome);
    await h.core.settled();
    return h;
  }

  it('releases the hold on success', async () => {
    const h = await finishWith({ outcome: 'succeeded' });
    expect(h.money.released).toEqual([HOLD]);
  });

  it('releases the hold on a stopped run', async () => {
    const h = await finishWith({ outcome: 'stopped' });
    expect(h.money.released).toEqual([HOLD]);
  });

  it('releases the hold on a failed run', async () => {
    const h = await finishWith({ outcome: 'failed', code: 'INTERNAL' });
    expect(h.money.released).toEqual([HOLD]);
  });

  it('never fails the key row on success (settlement already flipped it)', async () => {
    const h = await finishWith({ outcome: 'succeeded' });
    expect(h.money.failedFences).toEqual([]);
  });

  it('fails the key row on a failed run so a retry re-executes', async () => {
    const h = await finishWith({ outcome: 'failed', code: 'INTERNAL' });
    expect(h.money.failedFences).toEqual([DEFAULT_FENCE]);
  });

  it('fails the key row on a stopped run (fence no-ops when the partial settled)', async () => {
    const h = await finishWith({ outcome: 'stopped' });
    expect(h.money.failedFences).toEqual([DEFAULT_FENCE]);
  });

  it('performs the money duties when the executor done promise rejects', async () => {
    const h = makeHarness({ doneRejects: true, admitted: { admitted: true, hold: HOLD } });
    await h.core.startRun(runBody());
    await h.core.settled();
    expect(h.money.released).toEqual([HOLD]);
    expect(h.money.failedFences).toEqual([DEFAULT_FENCE]);
  });

  it('places no money duties on a trial run without a hold', async () => {
    const h = makeHarness();
    await h.core.startRun(trialRunBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    expect(h.money.released).toEqual([]);
    expect(h.money.failedFences).toEqual([]);
  });

  it('fails the key row when the executor start throws synchronously', async () => {
    const h = makeHarness();
    h.executor.failNextStart();
    await expect(h.core.startRun(runBody())).rejects.toThrow('executor exploded');
    expect(h.money.failedFences).toEqual([DEFAULT_FENCE]);
  });
});

describe('finishRun — waitUntil flush guarantee', () => {
  const HOLD: FlowHoldIdentity = { walletId: 'w1', holdId: 'run-1', scopeIds: ['s1'] };

  it('hands the watch continuation and terminal duties to waitUntil on a succeeded paid run', async () => {
    const registered: Promise<unknown>[] = [];
    const notified: RoomPushNotification[] = [];
    const h = makeHarness({
      admitted: { admitted: true, hold: HOLD },
      notify: (notification) => {
        notified.push(notification);
        return Promise.resolve();
      },
      waitUntil: (promise) => {
        registered.push(promise);
      },
    });
    h.addSocket('watcher-1');
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    await Promise.allSettled(registered);
    // watch continuation + releaseHold + notify (failRun is not fired on success).
    expect(registered).toHaveLength(3);
    expect(h.money.released).toEqual([HOLD]);
    expect(notified).toHaveLength(1);
  });

  it('hands the watch continuation and terminal duties to waitUntil on a failed paid run', async () => {
    const registered: Promise<unknown>[] = [];
    const h = makeHarness({
      admitted: { admitted: true, hold: HOLD },
      waitUntil: (promise) => {
        registered.push(promise);
      },
    });
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'failed', code: 'INTERNAL' });
    await h.core.settled();
    await Promise.allSettled(registered);
    // watch continuation + releaseHold + failRun.
    expect(registered).toHaveLength(3);
    expect(h.money.released).toEqual([HOLD]);
    expect(h.money.failedFences).toEqual([DEFAULT_FENCE]);
  });
});

describe('run lease heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('touches the fence on the heartbeat interval while the run lives', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    await h.core.startRun(runBody());
    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
    expect(h.money.heartbeats).toEqual([DEFAULT_FENCE]);
    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
    expect(h.money.heartbeats).toHaveLength(2);
  });

  it('aborts the run when the heartbeat reports the claim was superseded', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.money.heartbeatState.result = 'lost';
    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
    expect(h.executor.aborts).toEqual(['superseded']);
  });

  it('does not stop a superseded run', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.money.heartbeatState.result = 'lost';
    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
    expect(h.executor.stops).toEqual([]);
  });

  it('finishes the run when disarming the deadline alarm fails', async () => {
    const h = makeHarness({ alarmDeleteRejects: true });
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    // A failed disarm is contained: the run still finishes and the rejection
    // never escapes as an unhandled duty (the claim is already released, so a
    // leftover alarm stops nothing).
    expect(frames(socket).map((frame) => frame.type)).toEqual(['run-started', 'run-finished']);
  });

  it('clears the heartbeat at the terminal sink', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    await h.core.startRun(runBody());
    h.executor.finish({ outcome: 'succeeded' });
    await h.core.settled();
    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS * 3);
    expect(h.money.heartbeats).toEqual([]);
  });
});

function sessionVerifierFor(
  decisions: Map<string, SessionDecision>,
  calls?: SessionSnapshot[]
): SessionVerifier {
  return {
    verify: (snapshot) => {
      calls?.push(snapshot);
      const key = `${snapshot.userId}:${snapshot.sessionId}:${String(snapshot.sessionCreatedAt)}`;
      return Promise.resolve(decisions.get(snapshot.userId) ?? decisions.get(key) ?? 'live');
    },
  };
}

const SESSION_FIELDS = { session: { id: 's1', createdAt: 100 } } as const;

describe('broadcast-time session-liveness backstop', () => {
  it('closes a member socket whose session was revoked and delivers nothing', async () => {
    const decisions = new Map<string, SessionDecision>([['u1', 'revoked']]);
    const h = makeHarness({ sessionVerifier: sessionVerifierFor(decisions) });
    const socket = h.addSocket('u1', SESSION_FIELDS);
    const receipt = await h.core.broadcastEvent({
      type: 'rotation:complete',
      timestamp: 1,
      conversationId: 'c1',
      newEpochNumber: 2,
    });
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toEqual([{ code: 1008, reason: 'session-revoked' }]);
    expect(receipt).toMatchObject({ delivered: 0, evicted: 1 });
  });

  it('closes the socket even when the active-room set is empty (broadcast check alone)', async () => {
    // No userRooms tracker is wired, so the push-eviction fan-out has an empty
    // SMEMBERS and closes nothing — the broadcast session check must still cut
    // the socket, closing the under-inclusion window push eviction leaves open.
    const decisions = new Map<string, SessionDecision>([['u1', 'revoked']]);
    const h = makeHarness({ sessionVerifier: sessionVerifierFor(decisions) });
    expect(h.core).toBeDefined();
    const socket = h.addSocket('u1', SESSION_FIELDS);
    await h.core.broadcastEvent({
      type: 'rotation:complete',
      timestamp: 1,
      conversationId: 'c1',
      newEpochNumber: 2,
    });
    expect(socket.closed).toEqual([{ code: 1008, reason: 'session-revoked' }]);
  });

  it('records principalEvicted telemetry for a session-revoked socket', async () => {
    const decisions = new Map<string, SessionDecision>([['u1', 'revoked']]);
    const h = makeHarness({ sessionVerifier: sessionVerifierFor(decisions) });
    h.addSocket('u1', SESSION_FIELDS);
    await h.core.broadcastEvent({
      type: 'rotation:complete',
      timestamp: 1,
      conversationId: 'c1',
      newEpochNumber: 2,
    });
    expect(h.telemetry).toContainEqual({
      method: 'principalEvicted',
      fields: { conversationId: 'c1' },
    });
  });

  it('keeps delivering to a live (non-revoked) session — no false-positive eviction', async () => {
    const h = makeHarness({ sessionVerifier: sessionVerifierFor(new Map()) });
    const socket = h.addSocket('u1', SESSION_FIELDS);
    const receipt = await h.core.broadcastEvent({
      type: 'rotation:complete',
      timestamp: 1,
      conversationId: 'c1',
      newEpochNumber: 2,
    });
    expect(socket.sent).toHaveLength(1);
    expect(socket.closed).toEqual([]);
    expect(receipt).toMatchObject({ delivered: 1, evicted: 0 });
  });

  it('pauses delivery (fail-closed) when the session check pauses, keeping the socket', async () => {
    const decisions = new Map<string, SessionDecision>([['u1', 'pause']]);
    const h = makeHarness({ sessionVerifier: sessionVerifierFor(decisions) });
    const socket = h.addSocket('u1', SESSION_FIELDS);
    const receipt = await h.core.broadcastEvent({
      type: 'rotation:complete',
      timestamp: 1,
      conversationId: 'c1',
      newEpochNumber: 2,
    });
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toEqual([]);
    expect(receipt).toMatchObject({ delivered: 0, paused: 1 });
  });

  it('does not session-check a trial principal (no revocable session)', async () => {
    const calls: SessionSnapshot[] = [];
    const decisions = new Map<string, SessionDecision>();
    const h = makeHarness({ sessionVerifier: sessionVerifierFor(decisions, calls) });
    const socket = h.addSocket('trial:sess-9', { principalId: 'trial:sess-9', ...SESSION_FIELDS });
    await h.core.broadcastEvent({
      type: 'rotation:complete',
      timestamp: 1,
      conversationId: 'c1',
      newEpochNumber: 2,
    });
    expect(calls).toEqual([]);
    expect(socket.sent).toHaveLength(1);
  });

  it('cuts a real socket that carries no session snapshot instead of delivering to it', async () => {
    const h = makeHarness({ sessionVerifier: sessionVerifierFor(new Map()) });
    const socket = h.addSocket('u1');
    const receipt = await h.core.broadcastEvent({
      type: 'rotation:complete',
      timestamp: 1,
      conversationId: 'c1',
      newEpochNumber: 2,
    });
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toEqual([{ code: 1008, reason: 'session-unverifiable' }]);
    expect(receipt).toMatchObject({ delivered: 0, evicted: 1 });
  });

  it('never asks the verifier about a real socket that carries no session snapshot', async () => {
    const calls: SessionSnapshot[] = [];
    const h = makeHarness({ sessionVerifier: sessionVerifierFor(new Map(), calls) });
    h.addSocket('u1');
    await h.core.broadcastEvent({
      type: 'rotation:complete',
      timestamp: 1,
      conversationId: 'c1',
      newEpochNumber: 2,
    });
    expect(calls).toEqual([]);
  });

  it('still evicts a removed member by the membership check (unchanged)', async () => {
    const h = makeHarness({ sessionVerifier: sessionVerifierFor(new Map()) });
    h.decisions.set('u1', 'revoked');
    const socket = h.addSocket('u1', SESSION_FIELDS);
    await h.core.broadcastEvent({
      type: 'rotation:complete',
      timestamp: 1,
      conversationId: 'c1',
      newEpochNumber: 2,
    });
    expect(socket.closed).toEqual([{ code: 1008, reason: 'revoked' }]);
  });

  it('passes the socket session snapshot to the verifier', async () => {
    const calls: SessionSnapshot[] = [];
    const h = makeHarness({ sessionVerifier: sessionVerifierFor(new Map(), calls) });
    h.addSocket('u1', { session: { id: 'sX', createdAt: 777 } });
    await h.core.broadcastEvent({
      type: 'rotation:complete',
      timestamp: 1,
      conversationId: 'c1',
      newEpochNumber: 2,
    });
    expect(calls).toEqual([{ userId: 'u1', sessionId: 'sX', sessionCreatedAt: 777 }]);
  });
});

describe('delivery-chain failure', () => {
  function textDelta(cursor: number): FlowStreamEvent {
    return {
      streamId: 's1',
      cursor,
      event: { kind: 'text-delta', index: 0, content: `t${String(cursor)}` },
    };
  }

  /** Starts a run and drains its run-started frame, leaving the socket clean. */
  async function runningRoom(): Promise<{
    h: ReturnType<typeof makeHarness>;
    socket: FakeSocket;
  }> {
    const h = makeHarness();
    const socket = h.addSocket('u1');
    await h.core.startRun(runBody());
    await h.core.settled();
    socket.sent.length = 0;
    return { h, socket };
  }

  it('delivers later frames after one delivery on the chain rejects', async () => {
    const { h, socket } = await runningRoom();
    h.verify.failNext();
    h.executor.emit(textDelta(1));
    await h.core.settled();
    h.executor.emit(textDelta(2));
    await h.core.settled();
    expect(frames(socket)).toEqual([
      {
        type: 'stream',
        streamId: 's1',
        cursor: 2,
        event: { kind: 'text-delta', index: 0, content: 't2' },
      },
    ]);
  });

  it('records exactly one delivery-failure telemetry record for one rejection', async () => {
    const { h } = await runningRoom();
    h.verify.failNext();
    h.executor.emit(textDelta(1));
    await h.core.settled();
    h.executor.emit(textDelta(2));
    await h.core.settled();
    expect(h.telemetry.filter((entry) => entry.method === 'deliveryFailed')).toEqual([
      { method: 'deliveryFailed', fields: { conversationId: 'c1' } },
    ]);
  });

  it('reports nothing when every delivery succeeds', async () => {
    const { h } = await runningRoom();
    h.executor.emit(textDelta(1));
    await h.core.settled();
    expect(h.telemetry.some((entry) => entry.method === 'deliveryFailed')).toBe(false);
  });

  it('returns a socket to fan-out when its declared replay delivery rejects', async () => {
    const { h } = await runningRoom();
    h.executor.emit(textDelta(1));
    await h.core.settled();
    // The replay link resolves whatever its delivery did, which is what frees
    // the socket: a rejecting link would leave it withheld for the run's life.
    const reconnected = h.addSocket('u1');
    h.core.completeOpen(reconnected, [{ streamId: 's1', lastEventId: 0, runId: 'run-1' }]);
    h.verify.failNext();
    await h.core.settled();
    h.executor.emit(textDelta(2));
    await h.core.settled();
    expect(streamCursors(reconnected)).toEqual([2]);
  });
});

describe('delivery-state transitions', () => {
  function rotation(): Parameters<RoomCore['broadcastEvent']>[0] {
    return { type: 'rotation:complete', timestamp: 1, conversationId: 'c1', newEpochNumber: 2 };
  }

  function lines(h: ReturnType<typeof makeHarness>): string[] {
    return h.telemetry
      .filter((entry) =>
        ['deliveryPaused', 'deliveryResumed', 'principalEvicted'].includes(entry.method)
      )
      .map((entry) => entry.method);
  }

  it('reports a paused principal once however many frames it misses', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    h.decisions.set('u1', 'pause');
    await h.core.broadcastEvent(rotation());
    await h.core.broadcastEvent(rotation());
    await h.core.broadcastEvent(rotation());
    expect(lines(h)).toEqual(['deliveryPaused']);
  });

  it('reports the return to service when the principal delivers again', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    h.decisions.set('u1', 'pause');
    await h.core.broadcastEvent(rotation());
    h.decisions.set('u1', 'member');
    await h.core.broadcastEvent(rotation());
    await h.core.broadcastEvent(rotation());
    expect(lines(h)).toEqual(['deliveryPaused', 'deliveryResumed']);
  });

  it('produces one line per state flip', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    for (const decision of ['pause', 'member', 'pause', 'member'] as const) {
      h.decisions.set('u1', decision);
      await h.core.broadcastEvent(rotation());
    }
    expect(lines(h)).toEqual([
      'deliveryPaused',
      'deliveryResumed',
      'deliveryPaused',
      'deliveryResumed',
    ]);
  });

  it('reports an evicted principal once however many frames follow', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    h.decisions.set('u1', 'revoked');
    await h.core.broadcastEvent(rotation());
    await h.core.broadcastEvent(rotation());
    expect(lines(h)).toEqual(['principalEvicted']);
  });

  it('reports the move from paused to evicted as its own line', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    h.decisions.set('u1', 'pause');
    await h.core.broadcastEvent(rotation());
    h.decisions.set('u1', 'revoked');
    await h.core.broadcastEvent(rotation());
    expect(lines(h)).toEqual(['deliveryPaused', 'principalEvicted']);
  });

  it('reports nothing for a principal that was never degraded', async () => {
    const h = makeHarness();
    h.addSocket('u1');
    await h.core.broadcastEvent(rotation());
    await h.core.broadcastEvent(rotation());
    expect(lines(h)).toEqual([]);
  });

  it('reports a session-paused socket once across a stream of frames', async () => {
    const decisions = new Map<string, SessionDecision>([['u1', 'pause']]);
    const h = makeHarness({ sessionVerifier: sessionVerifierFor(decisions) });
    h.addSocket('u1', SESSION_FIELDS);
    await h.core.broadcastEvent(rotation());
    await h.core.broadcastEvent(rotation());
    expect(lines(h)).toEqual(['deliveryPaused']);
  });

  it('reports a principal paused on one device though its other device still receives', async () => {
    const decisions = new Map<string, SessionDecision>([['u1:s2:100', 'pause']]);
    const h = makeHarness({ sessionVerifier: sessionVerifierFor(decisions) });
    h.addSocket('u1', { session: { id: 's2', createdAt: 100 } });
    const live = h.addSocket('u1', SESSION_FIELDS);
    await h.core.broadcastEvent(rotation());
    expect(lines(h)).toEqual(['deliveryPaused']);
    expect(live.sent).toHaveLength(1);
  });

  it('remembers a state only while the principal has a live socket', async () => {
    const h = makeHarness();
    const first = h.addSocket('u1');
    const second = h.addSocket('u2');
    h.decisions.set('u1', 'pause');
    h.decisions.set('u2', 'pause');
    await h.core.broadcastEvent(rotation());
    expect(h.core.deliveryStateCount()).toBe(2);
    h.removeSocket(first);
    h.removeSocket(second);
    await h.core.broadcastEvent(rotation());
    expect(h.core.deliveryStateCount()).toBe(0);
  });

  it('reports the pause again after the principal reconnects still paused', async () => {
    const h = makeHarness();
    const first = h.addSocket('u1');
    h.decisions.set('u1', 'pause');
    await h.core.broadcastEvent(rotation());
    h.removeSocket(first);
    await h.core.broadcastEvent(rotation());
    h.addSocket('u1');
    await h.core.broadcastEvent(rotation());
    expect(lines(h)).toEqual(['deliveryPaused', 'deliveryPaused']);
  });
});

class FakeIdentityStore {
  stored: string | undefined;

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(key === CONVERSATION_ID_STORAGE_KEY ? this.stored : undefined);
  }

  put(key: string, value: string): Promise<void> {
    if (key === CONVERSATION_ID_STORAGE_KEY) this.stored = value;
    return Promise.resolve();
  }
}

describe('resolveConversationId', () => {
  it('persists a live id name and returns it', async () => {
    const store = new FakeIdentityStore();
    await expect(resolveConversationId('room-a', store)).resolves.toBe('room-a');
    expect(store.stored).toBe('room-a');
  });

  it('reads the persisted id back on a nameless reconstruction', async () => {
    const store = new FakeIdentityStore();
    store.stored = 'room-b';
    await expect(resolveConversationId(undefined, store)).resolves.toBe('room-b');
  });

  it('rejects a nameless reconstruction with nothing persisted', async () => {
    const store = new FakeIdentityStore();
    await expect(resolveConversationId(undefined, store)).rejects.toThrow(/conversation identity/);
  });
});
