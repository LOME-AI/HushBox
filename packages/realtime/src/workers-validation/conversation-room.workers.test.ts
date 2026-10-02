import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { WS_HEARTBEAT_PING_MESSAGE } from '@hushbox/shared';
import { HELD_STREAM_RELEASE_STORAGE_KEY } from '../conversation-room.js';
import { CONVERSATION_ID_STORAGE_KEY, MAX_SOCKETS_PER_PRINCIPAL } from '../room-core.js';
import {
  WORKERS_VALIDATION_ANSWER_ID,
  roomRunControl,
  roomTelemetryControl,
  roomTrackerControl,
  roomVerifierControl,
} from './test-worker.js';

interface Frame {
  type: string;
  [key: string]: unknown;
}

interface Connection {
  socket: WebSocket;
  frames: Frame[];
  closes: { code: number; reason: string }[];
}

function roomStub(conversationId: string): DurableObjectStub {
  return env.CONVERSATION_ROOM.get(env.CONVERSATION_ROOM.idFromName(conversationId));
}

/**
 * A real user's socket, carrying the authorizing session the worker forwards
 * for every non-guest upgrade — without it the broadcast-time session check
 * cuts the socket, which is the fail-closed behavior the tests below pin.
 */
async function connect(
  stub: DurableObjectStub,
  conversationId: string,
  principalId: string,
  options: {
    sessionId?: string;
    /** What this client says it has already seen, declared on the upgrade itself. */
    declared?: { streamId: string; lastEventId: number; runId: string }[];
  } = {}
): Promise<Connection> {
  const sessionId = options.sessionId ?? `session-${principalId}`;
  const cursors =
    options.declared === undefined
      ? ''
      : `&cursors=${encodeURIComponent(JSON.stringify(options.declared))}`;
  const response = await stub.fetch(
    `https://room/websocket?principalId=${principalId}&conversationId=${conversationId}&isGuest=false&sessionId=${sessionId}&sessionCreatedAt=1${cursors}`,
    { headers: { Upgrade: 'websocket' } }
  );
  const socket = response.webSocket;
  if (socket === null) {
    throw new Error(`upgrade failed: ${String(response.status)}`);
  }
  const connection: Connection = { socket, frames: [], closes: [] };
  socket.accept();
  socket.addEventListener('message', (event) => {
    connection.frames.push(JSON.parse(event.data as string) as Frame);
  });
  socket.addEventListener('close', (event) => {
    connection.closes.push({ code: event.code, reason: event.reason });
  });
  return connection;
}

async function until<T>(get: () => T | undefined, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function frameOfType(connection: Connection, type: string): () => Frame | undefined {
  return () => connection.frames.find((frame) => frame.type === type);
}

function definitionInput(): unknown {
  return {
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
  };
}

describe('ConversationRoom under workerd', () => {
  beforeEach(() => {
    roomTelemetryControl.upgradeRejected.length = 0;
    roomTrackerControl.failNextTrack = false;
    roomTrackerControl.release();
    roomRunControl.emit = null;
    roomRunControl.parksPerRun = 1;
    roomRunControl.parks = 0;
    roomRunControl.advanced = 0;
    roomRunControl.freeStall();
    roomRunControl.stalled = false;
    roomVerifierControl.release();
  });

  /** The stream cursors a connection actually received, in arrival order. */
  function streamCursors(connection: Connection): number[] {
    return connection.frames
      .filter((frame) => frame.type === 'stream')
      .map((frame) => frame['cursor'] as number);
  }

  /**
   * Produces one live token on the run the room is currently executing. The
   * emit runs inside the DO's own context: a send issued from the test's
   * context is refused as I/O on behalf of another request, and the ordering
   * chain swallows that refusal, so the frames would simply never arrive.
   */
  async function emitToken(stub: DurableObjectStub, cursor: number): Promise<void> {
    await runInDurableObject(stub, () => {
      const emit = roomRunControl.emit;
      if (emit === null) throw new Error('no live run to emit into');
      emit({
        streamId: 's1',
        cursor,
        event: { kind: 'text-delta', index: 0, content: `t${String(cursor)}` },
      });
    });
  }

  it('leaves no accepted socket behind when connection setup rejects', async () => {
    const stub = roomStub('fail-closed');
    roomTrackerControl.failNextTrack = true;

    await expect(
      stub.fetch('https://room/websocket?principalId=u1&conversationId=fail-closed&isGuest=false', {
        headers: { Upgrade: 'websocket' },
      })
    ).rejects.toThrow('scripted track failure');

    const accepted = await runInDurableObject(
      stub,
      (_instance, state) => state.getWebSockets().length
    );
    expect(accepted).toBe(0);
  });

  it('holds one principal at the socket cap when a whole burst of upgrades is in flight', async () => {
    const conversationId = 'socket-cap-burst';
    const stub = roomStub(conversationId);
    const attempts = MAX_SOCKETS_PER_PRINCIPAL + 3;
    // Every upgrade parks inside connection setup, so the whole burst is in
    // flight against a roster none of it has joined yet. A count taken before
    // that await reads an empty roster for all of them and admits the burst
    // whole; a count taken in the turn that accepts reads what its
    // predecessors already accepted.
    roomTrackerControl.hold();
    const pending = Array.from({ length: attempts }, () => connect(stub, conversationId, 'u1'));
    await until(
      () => (roomTrackerControl.parked === attempts ? attempts : undefined),
      'the whole upgrade burst to park'
    );
    roomTrackerControl.release();
    const connections = await Promise.all(pending);

    await until(
      () =>
        connections.filter((connection) => connection.closes.length > 0).length === 3
          ? true
          : undefined,
      'the over-cap sockets to close'
    );
    expect(connections.filter((connection) => connection.closes.length === 0)).toHaveLength(
      MAX_SOCKETS_PER_PRINCIPAL
    );
    expect(
      connections.flatMap((connection) => connection.closes).map((close) => close.code)
    ).toEqual([1008, 1008, 1008]);
  });

  it('records the upgrade-failure metric when the DO rejects bad params', async () => {
    const stub = roomStub('upgrade-fail');
    // conversationId query param mismatches the DO's own id — the upgrade fails
    // its attachment check, and the failure branch calls `upgradeRejected`, which
    // the real binding turns into a warn line no watcher reads.
    const response = await stub.fetch(
      'https://room/websocket?principalId=u1&conversationId=wrong-room&isGuest=false',
      { headers: { Upgrade: 'websocket' } }
    );
    expect(response.status).toBe(400);
    expect(roomTelemetryControl.upgradeRejected).toEqual([{ conversationId: 'upgrade-fail' }]);
  });

  it('upgrades a WebSocket and relays a typing event between sockets', async () => {
    const stub = roomStub('relay');
    const alice = await connect(stub, 'relay', 'u1');
    const bob = await connect(stub, 'relay', 'u2');
    await until(frameOfType(alice, 'ready'), 'alice ready');
    await until(frameOfType(bob, 'ready'), 'bob ready');

    const typing = { type: 'typing:start', timestamp: 1, conversationId: 'relay', userId: 'u1' };
    alice.socket.send(JSON.stringify(typing));

    const relayed = await until(
      () =>
        bob.frames.find(
          (frame) => frame.type === 'event' && (frame['event'] as Frame).type === 'typing:start'
        ),
      'typing relay'
    );
    expect(relayed['event']).toEqual(typing);
    expect(
      alice.frames.some(
        (frame) => frame.type === 'event' && (frame['event'] as Frame).type === 'typing:start'
      )
    ).toBe(false);
  });

  it('delivers a presence update to an already-connected socket when a second joins', async () => {
    const stub = roomStub('presence-join');
    const alice = await connect(stub, 'presence-join', 'u1');
    await until(frameOfType(alice, 'ready'), 'alice ready');

    await connect(stub, 'presence-join', 'u2');

    // The on-open roster is a fire-and-forget duty: nothing awaits it, so the
    // only proof it reaches a socket is reading one off the wire. Alice's own
    // join broadcasts a roster of one, so the assertion is on the two-member
    // roster, which only the second join can produce.
    const presence = await until(
      () =>
        alice.frames.find(
          (frame) =>
            frame.type === 'event' &&
            (frame['event'] as Frame).type === 'presence:update' &&
            ((frame['event'] as Frame)['members'] as { userId?: string }[]).length === 2
        ),
      'presence update naming both members'
    );
    const members = (presence['event'] as Frame)['members'] as { userId?: string }[];
    expect(
      members.map((member) => member.userId).toSorted((a, b) => (a ?? '').localeCompare(b ?? ''))
    ).toEqual(['u1', 'u2']);
  });

  it('auto-responds to a heartbeat ping without relaying it to peers', async () => {
    const stub = roomStub('heartbeat');
    const alice = await connect(stub, 'heartbeat', 'u1');
    const bob = await connect(stub, 'heartbeat', 'u2');
    await until(frameOfType(alice, 'ready'), 'alice ready');
    await until(frameOfType(bob, 'ready'), 'bob ready');

    alice.socket.send(WS_HEARTBEAT_PING_MESSAGE);

    // The runtime auto-responds with the pong to the sender without invoking
    // webSocketMessage; the ping must never reach a peer as relayed traffic.
    await until(frameOfType(alice, 'pong'), 'alice heartbeat pong');
    expect(bob.frames.some((frame) => frame.type === 'ping' || frame.type === 'pong')).toBe(false);
  });

  it('reads back the attachment the upgrade serialized onto the socket', async () => {
    // The serialize/deserialize round trip is the mechanism hibernation rests
    // on, and is as far as this level reaches: the pool exposes no way to force
    // a Durable Object to hibernate, so an eviction is not what is exercised.
    const stub = roomStub('attachments');
    await connect(stub, 'attachments', 'u1');

    const attachment = await runInDurableObject(stub, (_instance, state) => {
      const [socket] = state.getWebSockets();
      return socket?.deserializeAttachment() as Record<string, unknown>;
    });

    expect(attachment).toMatchObject({
      principalId: 'u1',
      conversationId: 'attachments',
      isGuest: false,
    });
    expect(typeof attachment['connectedAt']).toBe('number');
  });

  it('refuses an upgrade carrying only half a session', async () => {
    const stub = roomStub('half-session');
    // A session id with no creation time is an authorization input arriving
    // incomplete: it must fail the upgrade, never become a session-less socket.
    const response = await stub.fetch(
      'https://room/websocket?principalId=u1&conversationId=half-session&isGuest=false&sessionId=s1',
      { headers: { Upgrade: 'websocket' } }
    );
    expect(response.status).toBe(400);
  });

  it('cuts a socket attached under the retired two-field session shape', async () => {
    const stub = roomStub('retired-shape');
    const alice = await connect(stub, 'retired-shape', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    // The bytes a socket hibernated under before the session pair became one
    // object. The runtime hands them back verbatim across a deploy, so the room
    // must treat the resulting session-less real-user socket as unverifiable.
    await runInDurableObject(stub, (_instance, state) => {
      const [socket] = state.getWebSockets();
      socket?.serializeAttachment({
        principalId: 'u1',
        conversationId: 'retired-shape',
        isGuest: false,
        connectedAt: 1,
        sessionId: 's1',
        sessionCreatedAt: 1,
      });
    });

    const response = await stub.fetch('https://room/broadcast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'rotation:complete',
        timestamp: 1,
        conversationId: 'retired-shape',
        newEpochNumber: 2,
      }),
    });
    expect(response.status).toBe(200);

    const closed = await until(() => alice.closes[0], 'alice close event');
    expect(closed).toEqual({ code: 1008, reason: 'session-unverifiable' });
  });

  it('fires run control when the deadline alarm runs', async () => {
    const stub = roomStub('deadline');
    const alice = await connect(stub, 'deadline', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    const started = await stub.fetch('https://room/run/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'paid',
        runKey: 'key-1',
        bodyHash: 'body-hash-1',
        definition: definitionInput(),
        inputs: {},
        userId: 'u1',
        sender: { kind: 'user', userId: 'u1' },
        walletId: 'w1',
        epochNumber: 1,
        userMessage: { id: crypto.randomUUID(), content: 'hi' },
      }),
    });
    expect(started.status).toBe(201);

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const finished = await until(frameOfType(alice, 'run-finished'), 'run-finished frame');
    expect(finished['outcome']).toEqual({ outcome: 'stopped' });
  });

  it('names the answer ids its binding minted on the run start', async () => {
    const stub = roomStub('start-answer-ids');
    const started = await startRun(stub, paidRunBody());
    expect(started.status).toBe(201);
    await expect(started.json()).resolves.toMatchObject({
      assistantMessageIds: [WORKERS_VALIDATION_ANSWER_ID],
    });
  });

  it('replays the declared gap to a socket accepted into a live run', async () => {
    const stub = roomStub('declared-gap');
    const started = await startRun(stub, paidRunBody());
    expect(started.status).toBe(201);
    const { runId } = await started.json<{ runId: string }>();
    await emitToken(stub, 1);
    await emitToken(stub, 2);

    // The client saw the first token before it dropped; it declares that on the
    // upgrade, so the room owes it the second one before anything newer.
    const reconnected = await connect(stub, 'declared-gap', 'u1', {
      declared: [{ streamId: 's1', lastEventId: 1, runId }],
    });
    await emitToken(stub, 3);

    const cursors = await until(
      () => (streamCursors(reconnected).length === 2 ? streamCursors(reconnected) : undefined),
      'the declared gap and the live token'
    );
    expect(cursors).toEqual([2, 3]);
  });

  it('withholds a queued live token from the socket whose declared replay covers it', async () => {
    const stub = roomStub('withheld-token');
    await connect(stub, 'withheld-token', 'u2');
    const started = await startRun(stub, paidRunBody());
    expect(started.status).toBe(201);
    const { runId } = await started.json<{ runId: string }>();
    // Park one token's fan-out so the next queues behind it: the frame that
    // would otherwise reach the reconnecting socket ahead of its catch-up and
    // burn the cursor its replay is measured against.
    roomVerifierControl.holdNext();
    await emitToken(stub, 1);
    await emitToken(stub, 2);

    const reconnected = await connect(stub, 'withheld-token', 'u1', {
      declared: [{ streamId: 's1', lastEventId: 1, runId }],
    });
    await runInDurableObject(stub, () => {
      roomVerifierControl.release();
    });
    await emitToken(stub, 3);

    const cursors = await until(
      () => (streamCursors(reconnected).includes(3) ? streamCursors(reconnected) : undefined),
      'the declared gap and the token after it'
    );
    // The queued token reaches this socket once, out of its replay — never
    // live first and replayed second.
    expect(cursors).toEqual([2, 3]);
  });

  it('delivers only live frames to a socket accepted into a live run declaring nothing', async () => {
    const stub = roomStub('declared-nothing');
    const started = await startRun(stub, paidRunBody());
    expect(started.status).toBe(201);
    await emitToken(stub, 1);

    const joiner = await connect(stub, 'declared-nothing', 'u1');
    await emitToken(stub, 2);

    const cursors = await until(
      () => (streamCursors(joiner).length === 1 ? streamCursors(joiner) : undefined),
      'the live token'
    );
    expect(cursors).toEqual([2]);
  });

  it('fails the upgrade on a malformed cursor declaration', async () => {
    const stub = roomStub('bad-cursors');
    const response = await stub.fetch(
      'https://room/websocket?principalId=u1&conversationId=bad-cursors&isGuest=false&cursors=not-json',
      { headers: { Upgrade: 'websocket' } }
    );
    expect(response.status).toBe(400);
    expect(roomTelemetryControl.upgradeRejected).toEqual([{ conversationId: 'bad-cursors' }]);
  });

  it('accepts no socket when the cursor declaration is malformed', async () => {
    const stub = roomStub('bad-cursors-accepted');
    await stub.fetch(
      'https://room/websocket?principalId=u1&conversationId=bad-cursors-accepted&isGuest=false&cursors=' +
        encodeURIComponent('[{"streamId":"s1","lastEventId":-1}]'),
      { headers: { Upgrade: 'websocket' } }
    );
    const accepted = await runInDurableObject(
      stub,
      (_instance, state) => state.getWebSockets().length
    );
    expect(accepted).toBe(0);
  });

  function paidRunBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      mode: 'paid',
      runKey: `key-${crypto.randomUUID()}`,
      bodyHash: `hash-${crypto.randomUUID()}`,
      definition: definitionInput(),
      inputs: {},
      userId: 'u1',
      sender: { kind: 'user', userId: 'u1' },
      walletId: 'w1',
      epochNumber: 1,
      userMessage: { id: crypto.randomUUID(), content: 'hi' },
      ...overrides,
    });
  }

  async function startRun(stub: DurableObjectStub, body: string): Promise<Response> {
    return stub.fetch('https://room/run/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
  }

  async function stopRun(stub: DurableObjectStub, caller: unknown): Promise<Response> {
    return stub.fetch('https://room/run/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'user-stop', caller }),
    });
  }

  /** Naming a run is what lets a release land before that run has started. */
  function releaseHeldStream(stub: DurableObjectStub, runKey?: string): Promise<Response> {
    const query = runKey === undefined ? '' : `?runKey=${encodeURIComponent(runKey)}`;
    return stub.fetch(`https://room/mock/release-stream${query}`, { method: 'POST' });
  }

  /** Waits for the held-stream latch to carry `suffix`, the grant a release persists. */
  async function untilLatched(stub: DurableObjectStub, suffix: string): Promise<void> {
    const start = Date.now();
    for (;;) {
      const latched = await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get<string>(HELD_STREAM_RELEASE_STORAGE_KEY)
      );
      if (latched?.endsWith(suffix) === true) return;
      if (Date.now() - start > 5000) throw new Error(`timed out waiting for latch ${suffix}`);
    }
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  function runFinishedFrames(connection: Connection): Frame[] {
    return connection.frames.filter((frame) => frame.type === 'run-finished');
  }

  it('refuses a stop from a principal that neither sent nor pays for the live run', async () => {
    const stub = roomStub('stop-bystander');
    const alice = await connect(stub, 'stop-bystander', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    const started = await startRun(
      stub,
      paidRunBody({ mockDirectives: { holdPrimaryStream: true } })
    );
    expect(started.status).toBe(201);

    const refused = await stopRun(stub, { kind: 'user', userId: 'bystander-1' });
    expect(refused.status).toBe(403);

    // The refusal left the run running: nothing settled, nothing billed.
    await settle();
    expect(runFinishedFrames(alice)).toHaveLength(0);

    await releaseHeldStream(stub);
    await until(frameOfType(alice, 'run-finished'), 'run-finished after release');
  });

  it('stops the live run for the principal that sent it', async () => {
    const stub = roomStub('stop-sender');
    const alice = await connect(stub, 'stop-sender', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    const started = await startRun(
      stub,
      paidRunBody({ mockDirectives: { holdPrimaryStream: true } })
    );
    expect(started.status).toBe(201);

    const stopped = await stopRun(stub, { kind: 'user', userId: 'u1' });
    expect(stopped.status).toBe(200);
    await expect(stopped.json()).resolves.toEqual({ stopped: true });

    await releaseHeldStream(stub);
    await until(frameOfType(alice, 'run-finished'), 'run-finished after release');
  });

  it('attaches a same-key resend of a live run with the user message id that run started with', async () => {
    const stub = roomStub('attach-user-message');
    const alice = await connect(stub, 'attach-user-message', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');
    const runKey = `key-${crypto.randomUUID()}`;
    const userMessageId = crypto.randomUUID();

    const started = await startRun(
      stub,
      paidRunBody({
        runKey,
        userMessage: { id: userMessageId, content: 'hi' },
        mockDirectives: { holdPrimaryStream: true },
      })
    );
    expect(started.status).toBe(201);
    // The resend carries the id the worker minted for it, which the live run never used.
    const resent = await startRun(
      stub,
      paidRunBody({ runKey, userMessage: { id: crypto.randomUUID(), content: 'hi' } })
    );
    expect(resent.status).toBe(200);
    await expect(resent.json()).resolves.toEqual({
      outcome: 'attach',
      userMessageId,
      assistantMessageIds: [WORKERS_VALIDATION_ANSWER_ID],
    });

    await releaseHeldStream(stub);
    await until(frameOfType(alice, 'run-finished'), 'run-finished after release');
  });

  it('answers a stop with no run running as a benign no-op', async () => {
    const stub = roomStub('stop-idle');
    const idle = await stopRun(stub, { kind: 'user', userId: 'u1' });
    expect(idle.status).toBe(200);
    await expect(idle.json()).resolves.toEqual({ stopped: false });
  });

  it('holds a holdPrimaryStream run open until the release route fires', async () => {
    const stub = roomStub('held-run');
    const alice = await connect(stub, 'held-run', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    const started = await startRun(
      stub,
      paidRunBody({ mockDirectives: { holdPrimaryStream: true } })
    );
    expect(started.status).toBe(201);

    // The run is parked at the barrier — no run-finished frame appears.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alice.frames.find((frame) => frame.type === 'run-finished')).toBeUndefined();

    const released = await releaseHeldStream(stub);
    expect(released.status).toBe(200);
    await expect(released.json()).resolves.toEqual({ released: true });

    const finished = await until(frameOfType(alice, 'run-finished'), 'run-finished after release');
    expect(finished['outcome']).toEqual({ outcome: 'succeeded' });
  });

  it('is a harmless no-op when the release route fires with nothing held', async () => {
    const stub = roomStub('held-none');
    const released = await releaseHeldStream(stub);
    expect(released.status).toBe(200);
    await expect(released.json()).resolves.toEqual({ released: false });
  });

  it('creates no barrier for a run without holdPrimaryStream (release is a no-op)', async () => {
    const stub = roomStub('held-gate');
    const alice = await connect(stub, 'held-gate', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    const started = await startRun(stub, paidRunBody());
    expect(started.status).toBe(201);

    const released = await releaseHeldStream(stub);
    await expect(released.json()).resolves.toEqual({ released: false });
  });

  it('drains a held run whose release named it before the run existed', async () => {
    const stub = roomStub('held-latch-early');
    const alice = await connect(stub, 'held-latch-early', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    // The release fires before the run it names exists at all: no live resolver
    // exists, so `released` is false, but the request must LATCH under that run
    // key so the run frees the moment it parks.
    const runKey = `key-${crypto.randomUUID()}`;
    const early = await releaseHeldStream(stub, runKey);
    expect(early.status).toBe(200);
    await expect(early.json()).resolves.toEqual({ released: false });

    const started = await startRun(
      stub,
      paidRunBody({ runKey, mockDirectives: { holdPrimaryStream: true } })
    );
    expect(started.status).toBe(201);

    // The persisted latch resolves the park immediately: exactly one settle.
    const finished = await until(frameOfType(alice, 'run-finished'), 'run-finished after latch');
    expect(finished['outcome']).toEqual({ outcome: 'succeeded' });
    expect(runFinishedFrames(alice)).toHaveLength(1);
  });

  it('parks a held run whose key no standing latch names', async () => {
    const stub = roomStub('held-latch-other');
    const alice = await connect(stub, 'held-latch-other', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    // A latch standing for a different run frees nothing here: the barrier is
    // keyed to the run, so this one parks until its own release arrives.
    const early = await releaseHeldStream(stub, `key-${crypto.randomUUID()}`);
    await expect(early.json()).resolves.toEqual({ released: false });

    const runKey = `key-${crypto.randomUUID()}`;
    const started = await startRun(
      stub,
      paidRunBody({ runKey, mockDirectives: { holdPrimaryStream: true } })
    );
    expect(started.status).toBe(201);

    await settle();
    expect(runFinishedFrames(alice)).toHaveLength(0);

    await expect(releaseHeldStream(stub, runKey).then(async (r) => r.json())).resolves.toEqual({
      released: true,
    });
    const finished = await until(
      frameOfType(alice, 'run-finished'),
      'run-finished after its own release'
    );
    expect(finished['outcome']).toEqual({ outcome: 'succeeded' });
  });

  it('parks the second held run in a conversation until its own release', async () => {
    const stub = roomStub('held-twice');
    const alice = await connect(stub, 'held-twice', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    const first = await startRun(
      stub,
      paidRunBody({ mockDirectives: { holdPrimaryStream: true } })
    );
    expect(first.status).toBe(201);
    await expect(releaseHeldStream(stub).then(async (r) => r.json())).resolves.toEqual({
      released: true,
    });
    await until(() => runFinishedFrames(alice)[0], 'first run finished');

    const second = await startRun(
      stub,
      paidRunBody({ mockDirectives: { holdPrimaryStream: true } })
    );
    expect(second.status).toBe(201);

    // The first run's release must not carry over to the second: a latch that
    // outlives the run it freed silently stops parking every run after it.
    await settle();
    expect(runFinishedFrames(alice)).toHaveLength(1);

    await expect(releaseHeldStream(stub).then(async (r) => r.json())).resolves.toEqual({
      released: true,
    });
    await until(() => runFinishedFrames(alice)[1], 'second run finished');
  });

  it('drains a held run when the release latch was persisted before this instance existed', async () => {
    // A DO reconstructed AFTER a release was requested: the in-memory resolver
    // died with the prior instance, but the persisted latch survives. Seed both
    // the conversation id and the release latch directly, exactly as a prior
    // live instance would have left them, then start and park a held run.
    const named = env.CONVERSATION_ROOM.idFromName('held-latch-revived');
    const revived = env.CONVERSATION_ROOM.get(env.CONVERSATION_ROOM.idFromString(named.toString()));
    const runKey = `key-${crypto.randomUUID()}`;
    await runInDurableObject(revived, async (_instance, state) => {
      await state.storage.put(CONVERSATION_ID_STORAGE_KEY, 'held-latch-revived');
      await state.storage.put(HELD_STREAM_RELEASE_STORAGE_KEY, runKey);
    });
    const alice = await connect(revived, 'held-latch-revived', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    const started = await startRun(
      revived,
      paidRunBody({ runKey, mockDirectives: { holdPrimaryStream: true } })
    );
    expect(started.status).toBe(201);

    const finished = await until(
      frameOfType(alice, 'run-finished'),
      'run-finished from persisted latch'
    );
    expect(finished['outcome']).toEqual({ outcome: 'succeeded' });
    expect(runFinishedFrames(alice)).toHaveLength(1);
  });

  it('parks a run again after each release until its stream is done', async () => {
    const stub = roomStub('held-multi-park');
    const alice = await connect(stub, 'held-multi-park', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    roomRunControl.parksPerRun = 3;
    const started = await startRun(
      stub,
      paidRunBody({ mockDirectives: { holdPrimaryStream: true } })
    );
    expect(started.status).toBe(201);

    // Two releases, each freeing one park and leaving the run parked on the next
    // one: the run is still live, so nothing has settled.
    for (const release of [1, 2]) {
      await expect(releaseHeldStream(stub).then(async (r) => r.json())).resolves.toEqual({
        released: true,
      });
      // The release returned only after the run advanced past it and parked
      // again — no clock involved in learning that.
      expect(roomRunControl.advanced).toBe(release);
      expect(roomRunControl.parks).toBe(release + 1);
      expect(runFinishedFrames(alice)).toHaveLength(0);
    }

    // The last park has nothing behind it: this release carries the run to its end.
    await expect(releaseHeldStream(stub).then(async (r) => r.json())).resolves.toEqual({
      released: true,
    });
    expect(roomRunControl.advanced).toBe(3);
    const finished = await until(
      frameOfType(alice, 'run-finished'),
      'run-finished after the parks'
    );
    expect(finished['outcome']).toEqual({ outcome: 'succeeded' });
  });

  it('answers both of two releases issued against the same run', async () => {
    const stub = roomStub('held-two-in-flight');
    const alice = await connect(stub, 'held-two-in-flight', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    roomRunControl.parksPerRun = 3;
    const started = await startRun(
      stub,
      paidRunBody({ mockDirectives: { holdPrimaryStream: true } })
    );
    expect(started.status).toBe(201);

    // Hold the run in the window between its release and its next park, which
    // is the only window where a second release for the same run can land while
    // the first is still waiting to be answered — what a retried release does.
    roomRunControl.stallNextResume();
    const first = releaseHeldStream(stub);
    await until(() => (roomRunControl.stalled ? true : undefined), 'the run to stall mid-advance');
    const second = releaseHeldStream(stub);
    // The second release has registered once its own grant is latched: the
    // route writes the latch and then registers, with nothing awaited between.
    // Freeing the run before that would let it park — and answer the first
    // release — before the second one ever arrived, which is the race this test
    // exists to rule out.
    await untilLatched(stub, '#2');
    roomRunControl.freeStall();

    // The FIRST one is the one at risk: a release nothing ever answers hangs
    // until the caller's own timeout, which surfaces as an unexplained stall.
    const answers = await Promise.all([
      first.then(async (response) => response.json()),
      second.then(async (response) => response.json()),
    ]);
    expect(answers).toEqual([{ released: true }, { released: true }]);
  });

  it('grants one park per release, so a second park outlives the first release', async () => {
    const stub = roomStub('held-one-grant');
    const alice = await connect(stub, 'held-one-grant', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    roomRunControl.parksPerRun = 2;
    const started = await startRun(
      stub,
      paidRunBody({ mockDirectives: { holdPrimaryStream: true } })
    );
    expect(started.status).toBe(201);

    await releaseHeldStream(stub);
    // A latch that freed every park of the run would finish it here.
    await settle();
    expect(runFinishedFrames(alice)).toHaveLength(0);
    expect(roomRunControl.parks).toBe(2);

    await releaseHeldStream(stub);
    await until(frameOfType(alice, 'run-finished'), 'run-finished after the second release');
  });

  it('evicts only the requested principal sockets', async () => {
    const stub = roomStub('evict');
    const alice = await connect(stub, 'evict', 'u1');
    const bob = await connect(stub, 'evict', 'u2');
    await until(frameOfType(bob, 'ready'), 'bob ready');

    const response = await stub.fetch('https://room/evict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ principalId: 'u1' }),
    });
    await expect(response.json()).resolves.toEqual({ closed: 1 });

    const closed = await until(() => alice.closes[0], 'alice close event');
    expect(closed.code).toBe(1008);
    expect(bob.closes).toEqual([]);
  });

  it('evicts one device by session id and leaves the user’s other device connected', async () => {
    const stub = roomStub('evict-session');
    const phone = await connect(stub, 'evict-session', 'u1', { sessionId: 'session-phone' });
    const laptop = await connect(stub, 'evict-session', 'u1', { sessionId: 'session-laptop' });
    await until(frameOfType(laptop, 'ready'), 'laptop ready');

    const response = await stub.fetch('https://room/evict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ principalId: 'u1', sessionId: 'session-phone' }),
    });
    await expect(response.json()).resolves.toEqual({ closed: 1 });

    const closed = await until(() => phone.closes[0], 'phone close event');
    expect(closed.code).toBe(1008);
    expect(laptop.closes).toEqual([]);
  });

  it('persists its conversation id to storage on a live construction', async () => {
    const stub = roomStub('persist-room');
    const response = await stub.fetch('https://room/presence');
    expect(response.status).toBe(200);
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<string>(CONVERSATION_ID_STORAGE_KEY)
    );
    expect(stored).toBe('persist-room');
  });

  it('serves a route when the platform revives it without a named id', async () => {
    // The platform reconstructs an alarm-firing (or hibernation-woken) DO from
    // the stored id alone, which carries no name (`idFromString` reproduces
    // that nameless id). The conversation id, persisted by an earlier live
    // construction, must survive that revival — pre-seeded here directly so
    // this is the object's first construction.
    const named = env.CONVERSATION_ROOM.idFromName('revived-room');
    const nameless = env.CONVERSATION_ROOM.get(
      env.CONVERSATION_ROOM.idFromString(named.toString())
    );
    await runInDurableObject(nameless, (_instance, state) =>
      state.storage.put(CONVERSATION_ID_STORAGE_KEY, 'revived-room')
    );
    const response = await nameless.fetch('https://room/presence');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ userIds: [] });
  });

  it('builds again after a first initialization failed, instead of replaying it', async () => {
    // A DO revived with no name and nothing persisted cannot resolve its
    // conversation id, so its very first build rejects. Persisting the id makes
    // the next request buildable: the instance must retry rather than stay
    // poisoned until the platform happens to evict it.
    const named = env.CONVERSATION_ROOM.idFromName('rebuilds-after-failure');
    const nameless = env.CONVERSATION_ROOM.get(
      env.CONVERSATION_ROOM.idFromString(named.toString())
    );

    await expect(nameless.fetch('https://room/presence')).rejects.toThrow(
      /no conversation identity/
    );

    await runInDurableObject(nameless, (_instance, state) =>
      state.storage.put(CONVERSATION_ID_STORAGE_KEY, 'rebuilds-after-failure')
    );

    const response = await nameless.fetch('https://room/presence');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ userIds: [] });
  });

  it('runs its deadline alarm when the platform revives it without a named id', async () => {
    const named = env.CONVERSATION_ROOM.idFromName('revived-alarm');
    const nameless = env.CONVERSATION_ROOM.get(
      env.CONVERSATION_ROOM.idFromString(named.toString())
    );
    await runInDurableObject(nameless, async (_instance, state) => {
      await state.storage.put(CONVERSATION_ID_STORAGE_KEY, 'revived-alarm');
      await state.storage.setAlarm(Date.now() + 600_000);
    });
    expect(await runDurableObjectAlarm(nameless)).toBe(true);
  });

  it('routes RoomCore duties through the DO ctx.waitUntil', async () => {
    const stub = roomStub('wait-until');
    const alice = await connect(stub, 'wait-until', 'u1');
    await until(frameOfType(alice, 'ready'), 'ready');

    // Spy on the live DO's own ctx.waitUntil. The shell must pass a
    // `waitUntil: (p) => this.ctx.waitUntil(p)` option into RoomCore; without
    // it RoomCore falls back to bare `void` and this spy is never invoked, so
    // the run-continuation watcher's flush is never registered as pending work.
    const waited: Promise<unknown>[] = [];
    await runInDurableObject(stub, (_instance, state) => {
      const original = state.waitUntil.bind(state);
      state.waitUntil = (promise: Promise<unknown>): void => {
        waited.push(promise);
        original(promise);
      };
    });

    const started = await startRun(stub, paidRunBody());
    expect(started.status).toBe(201);

    expect(waited.length).toBeGreaterThan(0);
  });
});
