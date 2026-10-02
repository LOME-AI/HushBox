import { describe, expect, it } from 'vitest';
import { LINK_CREDENTIAL_HEADER } from '@hushbox/shared';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { createRealtimeBroadcast } from './realtime-do.js';
import type { RunStartBody } from '@hushbox/realtime';

interface RecordedCall {
  conversationName: string;
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function fakeNamespace(respond: (call: RecordedCall) => Response | Promise<Response>): {
  namespace: DurableObjectNamespace;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (url: string, init?: RequestInit): Promise<Response> => {
        const call: RecordedCall = {
          conversationName: id.name,
          url,
          method: init?.method ?? 'GET',
          headers: new Headers(init?.headers),
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        return respond(call);
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { namespace, calls };
}

/** An arbitrary fixed session-creation stamp, echoed on the upgrade query. */
const SESSION_CREATED_AT_MS = TEST_DAY_START;

const event = {
  type: 'rotation:complete',
  timestamp: 1,
  conversationId: 'c1',
  newEpochNumber: 2,
} as const;

function runBody(): RunStartBody {
  return {
    mode: 'paid',
    runKey: 'key-1',
    bodyHash: 'body-hash-1',
    definition: {
      version: 1,
      deadlineClass: 'text',
      hooks: { admission: 'chat-admission', settlement: 'chat-settlement' },
      nodes: [],
      edges: [],
    } as unknown as RunStartBody['definition'],
    inputs: {},
    history: [],
    userId: 'u1',
    sender: { kind: 'user', userId: 'u1' },
    walletId: 'w1',
    epochNumber: 1,
    userMessage: { id: 'um1', content: 'hi' },
  };
}

describe('broadcast', () => {
  it('posts the event to the conversation room and returns the receipt', async () => {
    const { namespace, calls } = fakeNamespace(() =>
      Response.json({ delivered: 2, paused: 0, evicted: 1 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.broadcast('c1', event);
    expect(result._unsafeUnwrap()).toEqual({ delivered: 2, paused: 0, evicted: 1 });
    expect(calls[0]).toMatchObject({
      conversationName: 'c1',
      method: 'POST',
      body: event,
    });
    expect(calls[0]?.url).toContain('/broadcast');
  });

  it('maps a network failure to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() => {
      throw new Error('socket hang up');
    });
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.broadcast('c1', event);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a non-ok response to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json({ code: 'VALIDATION' }, { status: 400 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.broadcast('c1', event);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a malformed response body to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() => Response.json({ delivered: 'lots' }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.broadcast('c1', event);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('evict', () => {
  it('posts the principal and resolves the closed count', async () => {
    const { namespace, calls } = fakeNamespace(() => Response.json({ closed: 2 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.evict('c1', 'u1');
    expect(result._unsafeUnwrap()).toBe(2);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { principalId: 'u1' } });
    expect(calls[0]?.url).toContain('/evict');
  });

  it('posts the session id when the close is scoped to one device', async () => {
    const { namespace, calls } = fakeNamespace(() => Response.json({ closed: 1 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.evict('c1', 'u1', 's1');
    expect(result._unsafeUnwrap()).toBe(1);
    expect(calls[0]).toMatchObject({ body: { principalId: 'u1', sessionId: 's1' } });
  });

  it('omits the session id when the close is account-wide', async () => {
    const { namespace, calls } = fakeNamespace(() => Response.json({ closed: 2 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.evict('c1', 'u1');
    expect(result.isOk()).toBe(true);
    expect(calls[0]?.body).not.toHaveProperty('sessionId');
  });
});

describe('presence', () => {
  it('resolves the connected user ids', async () => {
    const { namespace, calls } = fakeNamespace(() => Response.json({ userIds: ['u1', 'u2'] }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.presence('c1');
    expect(result._unsafeUnwrap()).toEqual(['u1', 'u2']);
    expect(calls[0]).toMatchObject({ method: 'GET' });
    expect(calls[0]?.url).toContain('/presence');
  });
});

describe('startRun', () => {
  it('resolves the started outcome, with the answer ids the room minted, on a created run', async () => {
    const { namespace, calls } = fakeNamespace(() =>
      Response.json(
        { runId: 'run-1', deadlineAt: 310_000, assistantMessageIds: ['answer-1'] },
        { status: 201 }
      )
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrap()).toEqual({
      started: true,
      runId: 'run-1',
      deadlineAt: 310_000,
      assistantMessageIds: ['answer-1'],
    });
    expect(calls[0]).toMatchObject({ method: 'POST', body: runBody() });
    expect(calls[0]?.url).toContain('/run/start');
  });

  it('maps a created-run body without its answer ids to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json({ runId: 'run-1', deadlineAt: 310_000 }, { status: 201 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('resolves the typed concurrent outcome on a 409', async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json({ code: 'CONCURRENT_RUN' }, { status: 409 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrap()).toEqual({ started: false, code: 'CONCURRENT_RUN' });
  });

  it('resolves the referee body-mismatch conflict on a 409', async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json({ code: 'IDEMPOTENCY_BODY_MISMATCH' }, { status: 409 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrap()).toEqual({ started: false, code: 'IDEMPOTENCY_BODY_MISMATCH' });
  });

  it('resolves the replay outcome with the stored response on a 200', async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json({ outcome: 'replay', response: { runId: 'settled' } }, { status: 200 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrap()).toEqual({ outcome: 'replay', response: { runId: 'settled' } });
  });

  it("resolves the attach outcome with the live run's message ids on a 200", async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json(
        { outcome: 'attach', userMessageId: 'um-live', assistantMessageIds: ['answer-live'] },
        { status: 200 }
      )
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrap()).toEqual({
      outcome: 'attach',
      userMessageId: 'um-live',
      assistantMessageIds: ['answer-live'],
    });
  });

  it('resolves an attach naming no live run with null message ids', async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json(
        { outcome: 'attach', userMessageId: null, assistantMessageIds: null },
        { status: 200 }
      )
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrap()).toEqual({
      outcome: 'attach',
      userMessageId: null,
      assistantMessageIds: null,
    });
  });

  it('maps an attach body without its answer ids to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json({ outcome: 'attach', userMessageId: 'um-live' }, { status: 200 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps an attach body without its user message id to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json({ outcome: 'attach', assistantMessageIds: null }, { status: 200 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a malformed 200 body to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() => Response.json({ outcome: 'nope' }, { status: 200 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a 409 without the concurrent code to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() => Response.json({ code: 'OTHER' }, { status: 409 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps an unexpected status to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json({ code: 'VALIDATION' }, { status: 400 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.startRun('c1', runBody());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('stopRun', () => {
  const caller = { kind: 'user', userId: 'u1' } as const;

  it('posts the user stop with its caller and resolves whether a run was stopped', async () => {
    const { namespace, calls } = fakeNamespace(() => Response.json({ stopped: true }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.stopRun('c1', caller);
    expect(result._unsafeUnwrap()).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { reason: 'user-stop', caller } });
    expect(calls[0]?.url).toContain('/run/stop');
  });

  it('carries a link-guest caller through unchanged', async () => {
    const { namespace, calls } = fakeNamespace(() => Response.json({ stopped: true }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.stopRun('c1', { kind: 'linkGuest', linkId: 'link-1' });
    expect(result.isOk()).toBe(true);
    expect(calls[0]).toMatchObject({
      body: { reason: 'user-stop', caller: { kind: 'linkGuest', linkId: 'link-1' } },
    });
  });

  it("maps the room's refusal to a forbidden error", async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json({ code: 'FORBIDDEN' }, { status: 403 })
    );
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.stopRun('c1', caller);
    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('maps an unexpected status to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() => new Response(null, { status: 500 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.stopRun('c1', caller);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('upgrade', () => {
  // The DO's real answer is a `101` with the client socket; undici's Response
  // constructor rejects sub-200 statuses, so a `200` sentinel stands in here —
  // the adapter passes the response through untouched regardless of status, and
  // the real `101` round-trip is proven in the workerd validation suite.
  it('forwards the principal as DO query params and returns the response', async () => {
    const proxied = new Response('proxied', { status: 200 });
    const { namespace, calls } = fakeNamespace(() => proxied);
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.upgrade(
      'c1',
      { principalId: 'u1', isGuest: false },
      new Headers({ Upgrade: 'websocket' }),
      null
    );
    expect(result._unsafeUnwrap()).toBe(proxied);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/websocket');
    expect(calls[0]?.url).toContain('principalId=u1');
    expect(calls[0]?.url).toContain('conversationId=c1');
    expect(calls[0]?.url).toContain('isGuest=false');
  });

  it('forwards the handshake headers without the link credential header', async () => {
    const { namespace, calls } = fakeNamespace(() => new Response(null, { status: 200 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.upgrade(
      'c1',
      { principalId: 'link-1', isGuest: true },
      new Headers({ Upgrade: 'websocket', [LINK_CREDENTIAL_HEADER]: 'link-auth-token' }),
      null
    );
    expect(result.isOk()).toBe(true);
    expect(calls[0]?.headers.get('Upgrade')).toBe('websocket');
    expect(calls[0]?.headers.has(LINK_CREDENTIAL_HEADER)).toBe(false);
  });

  it('forwards a guest display name', async () => {
    const { namespace, calls } = fakeNamespace(() => new Response(null, { status: 200 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.upgrade(
      'c1',
      { principalId: 'link-1', isGuest: true, displayName: 'Guest' },
      new Headers(),
      null
    );
    expect(result.isOk()).toBe(true);
    expect(calls[0]?.url).toContain('isGuest=true');
    expect(calls[0]?.url).toContain('displayName=Guest');
  });

  it('forwards the authorizing session snapshot for a real user', async () => {
    const { namespace, calls } = fakeNamespace(() => new Response(null, { status: 200 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.upgrade(
      'c1',
      {
        principalId: 'u1',
        isGuest: false,
        session: { id: 'sess-9', createdAt: SESSION_CREATED_AT_MS },
      },
      new Headers(),
      null
    );
    expect(result.isOk()).toBe(true);
    expect(calls[0]?.url).toContain('sessionId=sess-9');
    expect(calls[0]?.url).toContain(`sessionCreatedAt=${String(SESSION_CREATED_AT_MS)}`);
  });

  it('omits the session params when no session snapshot is supplied', async () => {
    const { namespace, calls } = fakeNamespace(() => new Response(null, { status: 200 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.upgrade(
      'c1',
      { principalId: 'u1', isGuest: false },
      new Headers(),
      null
    );
    expect(result.isOk()).toBe(true);
    expect(calls[0]?.url).not.toContain('sessionId');
    expect(calls[0]?.url).not.toContain('sessionCreatedAt');
  });

  it('forwards the declared stream cursors to the room', async () => {
    const { namespace, calls } = fakeNamespace(() => new Response(null, { status: 200 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.upgrade(
      'c1',
      { principalId: 'u1', isGuest: false },
      new Headers(),
      '[{"streamId":"s1","lastEventId":4,"runId":"r1"}]'
    );
    expect(result.isOk()).toBe(true);
    expect(calls[0]?.url).toContain(
      `cursors=${encodeURIComponent('[{"streamId":"s1","lastEventId":4,"runId":"r1"}]')}`
    );
  });

  it('omits the cursor param when the client declares nothing', async () => {
    const { namespace, calls } = fakeNamespace(() => new Response(null, { status: 200 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.upgrade(
      'c1',
      { principalId: 'u1', isGuest: false },
      new Headers(),
      '[]'
    );
    expect(result.isOk()).toBe(true);
    expect(calls[0]?.url).not.toContain('cursors');
  });

  it('fails the upgrade on a malformed cursor declaration', async () => {
    const { namespace, calls } = fakeNamespace(() => new Response(null, { status: 200 }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.upgrade(
      'c1',
      { principalId: 'u1', isGuest: false },
      new Headers(),
      'not-json'
    );
    expect(result._unsafeUnwrapErr().code).toBe('validation');
    // Refused before the room is addressed: a malformed declaration never
    // reaches the DO at all.
    expect(calls).toEqual([]);
  });

  it('fails the upgrade on a declaration above the stream cap', async () => {
    const { namespace } = fakeNamespace(() => new Response(null, { status: 200 }));
    const adapter = createRealtimeBroadcast(namespace);
    const overCap = Array.from({ length: 33 }, (_unused, index) => ({
      streamId: `s${String(index)}`,
      lastEventId: 0,
      runId: 'r1',
    }));
    const result = await adapter.upgrade(
      'c1',
      { principalId: 'u1', isGuest: false },
      new Headers(),
      JSON.stringify(overCap)
    );
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('maps a transport failure to an unavailable error', async () => {
    const { namespace } = fakeNamespace(() => {
      throw new Error('socket hang up');
    });
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.upgrade(
      'c1',
      { principalId: 'u1', isGuest: false },
      new Headers(),
      null
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('addressing', () => {
  it('addresses the room by the conversation id', async () => {
    const { namespace, calls } = fakeNamespace(() => Response.json({ userIds: [] }));
    const adapter = createRealtimeBroadcast(namespace);
    const result = await adapter.presence('conversation-42');
    expect(result.isOk()).toBe(true);
    expect(calls[0]?.conversationName).toBe('conversation-42');
  });
});

describe('startRun — synchronous admission refusals ride the 409 conflict body', () => {
  it.each(['INSUFFICIENT_ADMISSION', 'ADMISSION_UNAVAILABLE', 'TRIAL_CAPACITY_REACHED'] as const)(
    'resolves %s as a typed start refusal',
    async (code) => {
      const { namespace } = fakeNamespace(() => Response.json({ code }, { status: 409 }));
      const adapter = createRealtimeBroadcast(namespace);
      const result = await adapter.startRun('c1', runBody());
      expect(result._unsafeUnwrap()).toEqual({ started: false, code });
    }
  );
});
