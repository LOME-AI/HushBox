import { describe, expect, it, vi } from 'vitest';
import { expectExposes } from '@hushbox/shared/test-assertions';
import { trialRoomName } from '@hushbox/realtime';
import { MAX_SELECTED_MODELS } from '@hushbox/shared';
import { createChatConversationRuntime } from '../../chat/index.js';
import { FINGERPRINT_CODES } from '../../../lib/telemetry/index.js';
import { checkSessionLiveness } from '../../identity/index.js';
import { rateLimitBound } from '../../../lib/rate-limit/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import {
  composeSessionVerifier,
  composeTrialAwareVerifier,
  createRoomBindings,
  createRoomTelemetry,
} from './realtime-room-bindings.js';
import type {
  CreateRoomRuntime,
  PushNotifyCompositionDeps,
  RoomSessionLivenessCheck,
} from './realtime-room-bindings.js';
import type {
  MembershipDecision,
  MembershipVerifier,
  RoomNotify,
  RoomTelemetry,
  SessionSnapshot,
} from '@hushbox/realtime';
import type { Bindings } from '../../../lib/context/index.js';
import type {
  ConsoleSink,
  DurableObjectTelemetryOptions,
  SentryTransportFactory,
  Telemetry,
} from '../../../lib/telemetry/index.js';

/** A runtime factory double — the room's infra wiring is what these tests exercise. */
const fakeRuntime: CreateRoomRuntime = () => ({
  executor: {
    start: () => {
      throw new Error('unused in binding tests');
    },
  },
  bindHooks: () => ({
    admission: () => Promise.resolve({ admitted: false, code: 'INTERNAL' }),
    settlement: () => Promise.resolve(),
    assistantMessageIds: [],
  }),
  claimRun: () => Promise.resolve({ outcome: 'attach' }),
  releaseHold: () => Promise.resolve(),
  heartbeat: () => Promise.resolve('alive'),
  failRun: () => Promise.resolve(),
});

// The verifier composition value-imports the realtime barrel, which
// transitively imports the workerd-only platform module; stubbed in node.
vi.mock('cloudflare:workers', () => ({
  // Never instantiated here — the stub only satisfies `extends` at load time.
  DurableObject: class {
    constructor(protected readonly ctx: unknown) {}
  },
}));

const ENV: Bindings = {
  NODE_ENV: 'development',
  TELEMETRY_SINKS: 'console',
  DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/unused',
  UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:9',
  UPSTASH_REDIS_REST_TOKEN: 'unused',
  OPENROUTER_API_KEY: 'test-openrouter-key',
  // The chat runtime factory constructs (never exercises) the R2 storage
  // adapter, which fail-fasts on absent bindings; unused placeholder values.
  R2_S3_ENDPOINT: 'http://127.0.0.1:9',
  R2_BUCKET_MEDIA: 'unused',
  R2_ACCESS_KEY_ID: 'unused',
  R2_SECRET_ACCESS_KEY: 'unused',
} as Bindings;

interface Entry {
  level: string;
  msg: string;
  fields: unknown;
}

function recordingTelemetry(): { telemetry: Telemetry; entries: Entry[] } {
  const entries: Entry[] = [];
  const record =
    (level: string) =>
    (msg: string, fields?: unknown): void => {
      entries.push({ level, msg, fields });
    };
  const telemetry = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    captureError: (error: Error, errorCode: string): void => {
      entries.push({ level: 'capture', msg: errorCode, fields: error });
    },
  } as Telemetry;
  return { telemetry, entries };
}

describe('createRoomTelemetry', () => {
  const cases: {
    event: keyof RoomTelemetry;
    level: string;
    msg: string;
    fields: Record<string, string>;
  }[] = [
    {
      event: 'runStarted',
      level: 'info',
      msg: 'realtime run started',
      fields: { conversationId: 'c1', runId: 'r1' },
    },
    {
      event: 'runFinished',
      level: 'info',
      msg: 'realtime run finished',
      fields: { conversationId: 'c1', runId: 'r1', errorCode: 'TIMEOUT' },
    },
    {
      event: 'runRejected',
      level: 'warn',
      msg: 'realtime run rejected',
      fields: { conversationId: 'c1', errorCode: 'CONCURRENT_RUN' },
    },
    {
      event: 'deadlineFired',
      level: 'warn',
      msg: 'realtime run deadline fired',
      fields: { conversationId: 'c1', runId: 'r1' },
    },
    {
      event: 'principalEvicted',
      level: 'warn',
      msg: 'realtime principal evicted at broadcast',
      fields: { conversationId: 'c1' },
    },
    {
      event: 'deliveryPaused',
      level: 'warn',
      msg: 'realtime delivery paused',
      fields: { conversationId: 'c1' },
    },
    {
      event: 'clientMessageRejected',
      level: 'warn',
      msg: 'realtime client message rejected',
      fields: { conversationId: 'c1' },
    },
  ];

  it.each(cases)('maps $event to a $level log with allowlisted fields', (testCase) => {
    const { telemetry, entries } = recordingTelemetry();
    const roomTelemetry = createRoomTelemetry(telemetry);
    (roomTelemetry[testCase.event] as (fields: Record<string, string>) => void)(testCase.fields);
    expect(entries).toEqual([
      { level: testCase.level, msg: testCase.msg, fields: testCase.fields },
    ]);
  });

  it('maps deliveryFailed to a warn log line', () => {
    const { telemetry, entries } = recordingTelemetry();
    createRoomTelemetry(telemetry).deliveryFailed({ conversationId: 'c1' });
    expect(entries).toEqual([
      { level: 'warn', msg: 'realtime delivery failed', fields: { conversationId: 'c1' } },
    ]);
  });

  it('maps deliveryResumed to a warn log line, matching the pause it closes', () => {
    const { telemetry, entries } = recordingTelemetry();
    createRoomTelemetry(telemetry).deliveryResumed({ conversationId: 'c1' });
    expect(entries).toEqual([
      { level: 'warn', msg: 'realtime delivery resumed', fields: { conversationId: 'c1' } },
    ]);
  });

  it('maps upgradeRejected to a warn log line', () => {
    const { telemetry, entries } = recordingTelemetry();
    createRoomTelemetry(telemetry).upgradeRejected({ conversationId: 'c1' });
    expect(entries).toEqual([
      { level: 'warn', msg: 'realtime ws upgrade rejected', fields: { conversationId: 'c1' } },
    ]);
  });

  it('maps billableGeneration to an info log line dimensioned by run and generation id', () => {
    const { telemetry, entries } = recordingTelemetry();
    createRoomTelemetry(telemetry).billableGeneration({
      conversationId: 'c1',
      runId: 'r1',
      generationId: 'gen-1',
    });
    expect(entries).toEqual([
      {
        level: 'info',
        msg: 'realtime billable generation',
        fields: { conversationId: 'c1', runId: 'r1', generationId: 'gen-1' },
      },
    ]);
  });
});

describe('composeTrialAwareVerifier', () => {
  const SESSION = '11111111-1111-4111-8111-111111111111';

  /** An inner verifier that records its calls and answers a fixed decision. */
  function inner(decision: MembershipDecision): {
    verifier: MembershipVerifier;
    calls: [string, string][];
  } {
    const calls: [string, string][] = [];
    return {
      verifier: {
        verify: (conversationId, principalId) => {
          calls.push([conversationId, principalId]);
          return Promise.resolve(decision);
        },
      },
      calls,
    };
  }

  it('authorizes a trial session for its own room without consulting the DB verifier', async () => {
    const room = trialRoomName(SESSION);
    const { verifier, calls } = inner('revoked');
    await expect(composeTrialAwareVerifier(verifier).verify(room, room)).resolves.toBe('member');
    expect(calls).toEqual([]);
  });

  it('delegates a conversation member to the authoritative verifier', async () => {
    const { verifier, calls } = inner('member');
    await expect(composeTrialAwareVerifier(verifier).verify('conv-1', 'user-1')).resolves.toBe(
      'member'
    );
    expect(calls).toEqual([['conv-1', 'user-1']]);
  });

  it('delegates a trial principal addressing another trial room (never self-authorized)', async () => {
    const { verifier, calls } = inner('revoked');
    const decision = await composeTrialAwareVerifier(verifier).verify(
      trialRoomName('other'),
      trialRoomName(SESSION)
    );
    expect(decision).toBe('revoked');
    expect(calls).toEqual([[trialRoomName('other'), trialRoomName(SESSION)]]);
  });
});

describe('createRoomBindings', () => {
  it('binds a complete runtime from the injected chat factory', () => {
    // The real chat conversation-runtime factory, wrapped so the runtime it
    // returns is reachable: identity against that object is what shows the
    // bindings carry the injected factory's runtime and not one assembled some
    // other way (the app root wires this factory at assembly).
    let produced: ReturnType<CreateRoomRuntime> | undefined;
    const bindings = createRoomBindings(ENV, (deps) => {
      produced = createChatConversationRuntime(deps);
      return produced;
    });
    expectExposes(bindings, 'bindHooks', 'claimRun', 'releaseHold', 'heartbeat', 'failRun');
    expectExposes(bindings.executor, 'start');
    expect(bindings.executor).toBe(produced?.executor);
  });

  it('answers a failed round trip with a typed domain error, not the raw client error', async () => {
    // The store answers, and its answer is a failure. An unbounded client
    // throws its own `UpstashError`, which carries no taxonomy code; only a
    // client built through the policy factory translates it, so this is what
    // distinguishes the two without waiting out a deadline.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (): Promise<Response> =>
          Promise.resolve(Response.json({ error: 'store refused' }, { status: 500 }))
      )
    );
    try {
      const { userRooms } = createRoomBindings(ENV, fakeRuntime);
      if (userRooms === undefined) throw new Error('bindings expose no user-room tracker');
      await expect(userRooms.track('user-id', 'conversation-id')).rejects.toMatchObject({
        code: 'unavailable',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails fast when no runtime factory is injected', () => {
    expect(() => createRoomBindings(ENV)).toThrow(/runtime not injected/);
  });

  it('mints unique run ids', () => {
    const bindings = createRoomBindings(ENV, fakeRuntime);
    expect(bindings.newRunId()).not.toBe(bindings.newRunId());
  });

  /** Length of the longest leading run of characters every value shares. */
  function longestSharedPrefix(values: readonly string[]): number {
    const [first = '', ...rest] = values;
    let length = first.length;
    for (const value of rest) {
      while (length > 0 && !value.startsWith(first.slice(0, length))) {
        length -= 1;
      }
    }
    return length;
  }

  it('mints run ids that carry no embedded clock reading', () => {
    const bindings = createRoomBindings(ENV, fakeRuntime);
    // An identifier that leads with a clock reading gives a burst of mints a
    // long shared prefix — the reading itself, unchanged across the burst — and
    // makes them ascend whenever the clock ticks under them. The prefix is the
    // half that carries: below the reading such an identifier may be pure
    // randomness, so inside a single millisecond it orders randomly and the
    // ordering check alone clears it. Eight characters sits above the longest
    // prefix a fixed literal gives a random minter and below the prefix a
    // millisecond reading leaves across a burst that stays inside one tick — a
    // bound by probability, not by construction: a burst crossing a tick whose
    // low four hex digits roll over (one crossing in 16⁴) shares fewer than
    // eight, leaving the ordering half to catch a monotonic minter and nothing
    // to catch a random-tailed one. This is what makes a run id safe to emit as
    // a Sentry tag under this repo's privacy rules, where a time-ordered UUID
    // is treated as a timestamp.
    const minted = Array.from({ length: 24 }, () => bindings.newRunId());
    const belowItsPredecessor = minted.filter((id, index) => index > 0 && id < minted[index - 1]!);
    expect(belowItsPredecessor).not.toHaveLength(0);
    expect(longestSharedPrefix(minted)).toBeLessThan(8);
  });

  it('reads the wall clock', () => {
    const bindings = createRoomBindings(ENV, fakeRuntime);
    const before = Date.now();
    const now = bindings.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('caps the replay buffer with a positive byte budget', () => {
    expect(createRoomBindings(ENV, fakeRuntime).maxStreamBytes).toBeGreaterThan(0);
  });

  it('affords the widest turn the wire admits before the run budget can evict', () => {
    const bindings = createRoomBindings(ENV, fakeRuntime);
    expect(bindings.maxRunBytes).toBeGreaterThanOrEqual(
      MAX_SELECTED_MODELS * bindings.maxStreamBytes
    );
  });

  it('fails fast on a missing DATABASE_URL naming the binding', () => {
    expect(() => createRoomBindings({ ...ENV, DATABASE_URL: '' }, fakeRuntime)).toThrow(
      /DATABASE_URL/
    );
  });

  it('fails fast on a missing UPSTASH_REDIS_REST_URL naming the binding', () => {
    expect(() => createRoomBindings({ ...ENV, UPSTASH_REDIS_REST_URL: '' }, fakeRuntime)).toThrow(
      /UPSTASH_REDIS_REST_URL/
    );
  });

  it('fails fast on a missing UPSTASH_REDIS_REST_TOKEN naming the binding', () => {
    expect(() => createRoomBindings({ ...ENV, UPSTASH_REDIS_REST_TOKEN: '' }, fakeRuntime)).toThrow(
      /UPSTASH_REDIS_REST_TOKEN/
    );
  });

  // The room holds a Redis client, so anything it runs that ever reaches a
  // counter must find the bound already in force rather than an unbounded wait.
  // Reading the entry is what proves the wiring: an env whose value disagrees
  // with the one the process already settled can only be refused by a root that
  // read it.
  it('puts the counter bound in force from the room env', () => {
    expect(() =>
      createRoomBindings(
        {
          ...ENV,
          RATE_LIMIT_REDIS_TIMEOUT_MS: String(rateLimitBound().timeoutMs + 1),
        },
        fakeRuntime
      )
    ).toThrow(/RATE_LIMIT_REDIS_TIMEOUT_MS/);
  });

  it('puts the counter identifier key in force from the room env', () => {
    expect(() =>
      createRoomBindings(
        {
          ...ENV,
          RATE_LIMIT_KEY_SECRET: `${String(process.env['RATE_LIMIT_KEY_SECRET'])}-disagreeing`,
        },
        fakeRuntime
      )
    ).toThrow(/RATE_LIMIT_KEY_SECRET/);
  });
});

const SNAPSHOT: SessionSnapshot = { userId: 'u1', sessionId: 's1', sessionCreatedAt: 100 };

function livenessCheck(result: ReturnType<RoomSessionLivenessCheck>): {
  check: RoomSessionLivenessCheck;
  calls: { userId: string; sessionId: string; createdAt: number }[];
} {
  const calls: { userId: string; sessionId: string; createdAt: number }[] = [];
  return {
    calls,
    check: (_redis, inputs) => {
      calls.push(inputs);
      return result;
    },
  };
}

describe('composeSessionVerifier', () => {
  const REDIS = {} as never;

  it('delivers to a session identity reports active', async () => {
    const verifier = composeSessionVerifier(REDIS, livenessCheck(okAsync('active')).check);
    await expect(verifier.verify(SNAPSHOT)).resolves.toBe('live');
  });

  it('revokes a session identity reports revoked', async () => {
    const verifier = composeSessionVerifier(REDIS, livenessCheck(okAsync('revoked')).check);
    await expect(verifier.verify(SNAPSHOT)).resolves.toBe('revoked');
  });

  it('pauses (fail-closed) when the liveness read errors', async () => {
    const verifier = composeSessionVerifier(
      REDIS,
      livenessCheck(errAsync(unavailableError('redis down'))).check
    );
    await expect(verifier.verify(SNAPSHOT)).resolves.toBe('pause');
  });

  it('maps the snapshot onto identity’s inputs shape', async () => {
    const { check, calls } = livenessCheck(okAsync('active'));
    await composeSessionVerifier(REDIS, check).verify(SNAPSHOT);
    expect(calls).toEqual([{ userId: 'u1', sessionId: 's1', createdAt: 100 }]);
  });
});

describe('createRoomBindings push-notify wiring', () => {
  it('omits notify when no factory is injected', () => {
    expect(createRoomBindings(ENV, fakeRuntime).notify).toBeUndefined();
  });

  it('composes notify from the injected factory with the composed infra deps', () => {
    let received!: PushNotifyCompositionDeps;
    const sentinel: RoomNotify = () => Promise.resolve();
    const bindings = createRoomBindings(ENV, fakeRuntime, {
      createNotify: (deps) => {
        received = deps;
        return sentinel;
      },
    });
    expect(bindings.notify).toBe(sentinel);
    expect(received.env).toBe(ENV);
    expectExposes(received.membership, 'listActiveUserMembers');
    expectExposes(received.db, 'select');
  });
});

describe('createRoomBindings session-liveness wiring', () => {
  it('omits the session verifier when no liveness read is injected', () => {
    expect(createRoomBindings(ENV, fakeRuntime).sessionVerifier).toBeUndefined();
  });

  it('composes the session verifier from the injected liveness read', async () => {
    const bindings = createRoomBindings(ENV, fakeRuntime, {
      sessionLiveness: livenessCheck(okAsync('revoked')).check,
    });
    expect(bindings.sessionVerifier).toBeDefined();
    await expect(bindings.sessionVerifier?.verify(SNAPSHOT)).resolves.toBe('revoked');
  });

  it('constructs the production composition — real chat runtime plus identity liveness read', () => {
    // The exact triple the composition root binds behind the DO class (which
    // itself cannot load here — it imports `cloudflare:workers` transitively).
    // Locks identity's published read against drift from the injected shape.
    const bindings = createRoomBindings(ENV, createChatConversationRuntime, {
      sessionLiveness: checkSessionLiveness,
    });
    expectExposes(bindings.executor, 'start');
    expect(bindings.sessionVerifier).toBeDefined();
  });
});

const SENTRY_DSN = 'https://abc123@o1.ingest.sentry.io/42';

function spyTransport(): {
  factory: SentryTransportFactory;
  envelopes: unknown[];
  constructions: number[];
} {
  const envelopes: unknown[] = [];
  const constructions: number[] = [];
  return {
    factory: () => {
      constructions.push(constructions.length);
      return {
        send: (envelope) => {
          envelopes.push(envelope);
          return Promise.resolve({});
        },
        flush: () => Promise.resolve(true),
      };
    },
    envelopes,
    constructions,
  };
}

function recordingSink(): { sink: ConsoleSink; lines: string[] } {
  const lines: string[] = [];
  const record = (line: string): void => {
    lines.push(line);
  };
  return { sink: { debug: record, info: record, warn: record, error: record }, lines };
}

/**
 * The telemetry port the room composes — the single instance it hands its
 * runtime, its event mapper, and its push composition, and therefore the one
 * every DO-resident capture travels through.
 */
function roomTelemetryPort(env: Bindings, options: DurableObjectTelemetryOptions): Telemetry {
  let port: Telemetry | undefined;
  createRoomBindings(env, fakeRuntime, {
    telemetryOptions: options,
    createNotify: (deps) => {
      port = deps.telemetry;
      return () => Promise.resolve();
    },
  });
  if (port === undefined) {
    throw new Error('the room never composed a telemetry port for its injections');
  }
  return port;
}

describe('createRoomBindings telemetry composition', () => {
  it('delivers a capture to the Sentry transport when the environment asks for the sink', async () => {
    const transport = spyTransport();
    const port = roomTelemetryPort(
      { ...ENV, TELEMETRY_SINKS: 'console,sentry', SENTRY_DSN },
      { consoleSink: recordingSink().sink, sentryTransport: transport.factory }
    );

    port.captureError(new Error('boom'), FINGERPRINT_CODES.workflowNodeDefect);

    await vi.waitFor(() => {
      expect(transport.envelopes).toHaveLength(1);
    });
    expect(JSON.stringify(transport.envelopes)).toContain(FINGERPRINT_CODES.workflowNodeDefect);
  });

  it('builds the Sentry client once for the isolate rather than once per capture', async () => {
    const transport = spyTransport();
    const port = roomTelemetryPort(
      { ...ENV, TELEMETRY_SINKS: 'console,sentry', SENTRY_DSN },
      { consoleSink: recordingSink().sink, sentryTransport: transport.factory }
    );

    port.captureError(new Error('first'), FINGERPRINT_CODES.workflowNodeDefect);
    port.captureError(new Error('second'), FINGERPRINT_CODES.workflowNodeDefect);

    await vi.waitFor(() => {
      expect(transport.envelopes).toHaveLength(2);
    });
    expect(transport.constructions).toHaveLength(1);
  });

  it('degrades to console rather than throwing when the sink list is unparseable', () => {
    const recorded = recordingSink();
    const transport = spyTransport();

    const port = roomTelemetryPort(
      { ...ENV, TELEMETRY_SINKS: 'console,statsd' },
      { consoleSink: recorded.sink, sentryTransport: transport.factory }
    );
    port.captureError(new Error('boom'), FINGERPRINT_CODES.workflowNodeDefect);

    expect(recorded.lines.join('\n')).toContain(FINGERPRINT_CODES.workflowNodeDefect);
    expect(transport.envelopes).toHaveLength(0);
  });

  it('contains a Sentry transport that fails, rather than throwing into the run', () => {
    const port = roomTelemetryPort(
      { ...ENV, TELEMETRY_SINKS: 'console,sentry', SENTRY_DSN },
      {
        consoleSink: recordingSink().sink,
        sentryTransport: () => {
          throw new Error('transport construction failed');
        },
      }
    );

    expect(() => {
      port.captureError(new Error('boom'), FINGERPRINT_CODES.workflowNodeDefect);
    }).not.toThrow();
  });

  it('degrades to console rather than throwing when the sentry sink has no DSN', () => {
    const recorded = recordingSink();
    const transport = spyTransport();

    const port = roomTelemetryPort(
      { ...ENV, TELEMETRY_SINKS: 'console,sentry', SENTRY_DSN: '' },
      { consoleSink: recorded.sink, sentryTransport: transport.factory }
    );
    port.captureError(new Error('boom'), FINGERPRINT_CODES.workflowNodeDefect);

    expect(recorded.lines.join('\n')).toContain(FINGERPRINT_CODES.workflowNodeDefect);
    expect(transport.envelopes).toHaveLength(0);
  });
});
