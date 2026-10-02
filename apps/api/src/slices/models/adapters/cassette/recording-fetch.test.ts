import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import {
  CassetteMissError,
  beginCassetteScope,
  cassetteScopeIsOpen,
  createCassetteFetch,
  endCassetteScope,
  replayFromCassette,
} from './recording-fetch.js';
import { createCassetteStore, type Cassette, type CassetteStore } from './cassette-store.js';
import { descriptorHash, requestToDescriptor } from './canonical-request.js';

let rootDir: string;
let store: CassetteStore;

beforeEach(() => {
  rootDir = mkdtempSync(path.join(tmpdir(), 'recording-fetch-'));
  store = createCassetteStore({ rootDir });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function gatewayRequest(body: unknown): [string, RequestInit] {
  return [
    OPENROUTER_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // OpenRouter carries the model in the body, not a header.
      body: JSON.stringify({ model: 'openai/gpt-4o', ...(body as Record<string, unknown>) }),
    },
  ];
}

function gatewayGetRequest(pathAndQuery: string): [string, RequestInit] {
  return [
    `https://openrouter.ai${pathAndQuery}`,
    { method: 'GET', headers: { accept: 'application/json' } },
  ];
}

function upstreamReturning(bodyText: string, status = 200): typeof globalThis.fetch {
  return vi.fn(() =>
    Promise.resolve(
      new Response(bodyText, {
        status,
        headers: { 'content-type': 'text/event-stream' },
      })
    )
  );
}

/** Answers the queued bodies in call order; throws once the queue runs out. */
function scriptedUpstream(bodies: readonly string[]): typeof globalThis.fetch {
  let index = 0;
  return vi.fn(() => {
    const body = bodies[index];
    index += 1;
    if (body === undefined) throw new Error('scripted upstream exhausted');
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    );
  });
}

/** The single cassette the test just recorded; fails the test when absent. */
function readSingleCassette(fromStore: CassetteStore): Cassette {
  const hash = fromStore.list()[0];
  const cassette = hash === undefined ? undefined : fromStore.read(hash);
  if (cassette === undefined) throw new Error('expected exactly one recorded cassette');
  return cassette;
}

describe('createCassetteFetch in record mode', () => {
  it('passes a miss through to the real fetch and returns its body', async () => {
    const cassetteFetch = createCassetteFetch({
      store,
      mode: 'record',
      realFetch: upstreamReturning('data: {"type":"finish"}\n\n'),
    });

    const response = await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: {"type":"finish"}\n\n');
  });

  it('records the exchange so a later closure replays it without upstream', async () => {
    const realFetch = upstreamReturning('data: {"type":"finish"}\n\n');
    const cassetteFetch = createCassetteFetch({ store, mode: 'record', realFetch });

    const first = await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));
    await first.text();
    expect(store.list()).toHaveLength(1);

    const laterFetch = createCassetteFetch({ store, mode: 'record', realFetch });
    const second = await laterFetch(...gatewayRequest({ prompt: 'hi' }));

    expect(await second.text()).toBe('data: {"type":"finish"}\n\n');
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  it('records the canonical request alongside the response', async () => {
    const cassetteFetch = createCassetteFetch({
      store,
      mode: 'record',
      realFetch: upstreamReturning('data: {"type":"finish"}\n\n'),
    });

    const response = await cassetteFetch(...gatewayRequest({ provider: { zdr: true } }));
    await response.text();
    expect(store.list()).toHaveLength(1);

    const recorded = readSingleCassette(store).request;
    expect(recorded?.method).toBe('POST');
    expect(recorded?.pathAndQuery).toBe('/api/v1/chat/completions');
    expect(recorded?.headers['content-type']).toBe('application/json');
    const parsedBody: unknown = JSON.parse(recorded?.body ?? '{}');
    expect(parsedBody).toEqual({
      model: 'openai/gpt-4o',
      provider: { zdr: true },
    });
  });

  it('does not record a 4xx/5xx response', async () => {
    const cassetteFetch = createCassetteFetch({
      store,
      mode: 'record',
      realFetch: upstreamReturning('{"error":{"message":"nope"}}', 429),
    });

    const response = await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));
    await response.text();

    expect(response.status).toBe(429);
    expect(store.list()).toEqual([]);
  });

  it('records a bodyless response and replays status and headers', async () => {
    const realFetch = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 204, headers: { 'x-marker': 'yes' } }))
    ) as unknown as typeof globalThis.fetch;
    const cassetteFetch = createCassetteFetch({ store, mode: 'record', realFetch });

    await cassetteFetch(...gatewayRequest({ prompt: 'empty' }));
    expect(store.list()).toHaveLength(1);

    const laterFetch = createCassetteFetch({ store, mode: 'record', realFetch });
    const replayed = await laterFetch(...gatewayRequest({ prompt: 'empty' }));

    expect(replayed.status).toBe(204);
    expect(replayed.headers.get('x-marker')).toBe('yes');
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  it('records a bodyless GET request with no body field and replays it', async () => {
    const realFetch = upstreamReturning('{"data":[]}');
    const cassetteFetch = createCassetteFetch({ store, mode: 'record', realFetch });

    const response = await cassetteFetch(...gatewayGetRequest('/v1/models'));
    await response.text();
    expect(store.list()).toHaveLength(1);

    const recorded = readSingleCassette(store).request;
    expect(recorded?.method).toBe('GET');
    expect(recorded?.body).toBeUndefined();

    const laterFetch = createCassetteFetch({ store, mode: 'record', realFetch });
    const replayed = await laterFetch(...gatewayGetRequest('/v1/models'));
    expect(await replayed.text()).toBe('{"data":[]}');
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  it('omits content-encoding from recorded headers so replay is not double-decoded', async () => {
    const realFetch = vi.fn(() =>
      Promise.resolve(
        new Response('data: {"type":"finish"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' },
        })
      )
    ) as unknown as typeof globalThis.fetch;
    const cassetteFetch = createCassetteFetch({ store, mode: 'record', realFetch });

    const response = await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));
    await response.text();
    expect(store.list()).toHaveLength(1);

    const exchange = readSingleCassette(store).exchanges[0];
    expect(exchange?.headers['content-encoding']).toBeUndefined();
    expect(exchange?.headers['content-type']).toBe('text/event-stream');
  });

  it('fails fast when record mode is configured without a real fetch', () => {
    expect(() => createCassetteFetch({ store, mode: 'record' })).toThrow(/realFetch/);
  });

  it('stamps recordedFromSha from GITHUB_SHA on a streamed recording', async () => {
    vi.stubEnv('GITHUB_SHA', 'deadbeefcafe');
    const cassetteFetch = createCassetteFetch({
      store,
      mode: 'record',
      realFetch: upstreamReturning('data: {"type":"finish"}\n\n'),
    });

    const response = await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));
    await response.text();
    expect(store.list()).toHaveLength(1);

    expect(readSingleCassette(store).recordedFromSha).toBe('deadbeefcafe');
  });

  it('stamps recordedFromSha from GITHUB_SHA on a bodyless recording', async () => {
    vi.stubEnv('GITHUB_SHA', 'deadbeefcafe');
    const realFetch = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 204 }))
    ) as unknown as typeof globalThis.fetch;
    const cassetteFetch = createCassetteFetch({ store, mode: 'record', realFetch });

    await cassetteFetch(...gatewayRequest({ prompt: 'empty' }));
    expect(store.list()).toHaveLength(1);

    expect(readSingleCassette(store).recordedFromSha).toBe('deadbeefcafe');
  });

  it('resolves only once the recording is in the store', async () => {
    const cassetteFetch = createCassetteFetch({
      store,
      mode: 'record',
      realFetch: upstreamReturning('data: {"type":"finish"}\n\n'),
    });

    await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));

    expect(store.list()).toHaveLength(1);
  });

  it('raises a store-write failure to the call that made the recording', async () => {
    const failingStore: CassetteStore = {
      ...store,
      write: () => {
        throw new Error('cassette store write failed');
      },
    };
    const cassetteFetch = createCassetteFetch({
      store: failingStore,
      mode: 'record',
      realFetch: upstreamReturning('data: {"type":"finish"}\n\n'),
    });

    await expect(cassetteFetch(...gatewayRequest({ prompt: 'hi' }))).rejects.toThrow(
      /cassette store write failed/
    );
  });

  it('raises a mid-stream upstream failure to the call that made the recording', async () => {
    const realFetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'));
              controller.error(new Error('upstream stream broke'));
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      )
    ) as unknown as typeof globalThis.fetch;
    const cassetteFetch = createCassetteFetch({ store, mode: 'record', realFetch });

    await expect(cassetteFetch(...gatewayRequest({ prompt: 'hi' }))).rejects.toThrow(
      /upstream stream broke/
    );
    expect(store.list()).toEqual([]);
  });

  it('omits recordedFromSha when GITHUB_SHA is unset', async () => {
    // Force it unset even under GitHub Actions, where GITHUB_SHA is real.
    const previousSha = process.env['GITHUB_SHA'];
    delete process.env['GITHUB_SHA'];
    try {
      const cassetteFetch = createCassetteFetch({
        store,
        mode: 'record',
        realFetch: upstreamReturning('data: {"type":"finish"}\n\n'),
      });

      const response = await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));
      await response.text();
      expect(store.list()).toHaveLength(1);

      expect(readSingleCassette(store).recordedFromSha).toBeUndefined();
    } finally {
      if (previousSha !== undefined) process.env['GITHUB_SHA'] = previousSha;
    }
  });
});

describe('replayFromCassette', () => {
  it('throws on a hand-edited cassette with no exchanges', () => {
    expect(() =>
      replayFromCassette({ version: 1, exchanges: [], recordedAt: isoAt(TEST_DAY_START) })
    ).toThrow(/exchanges is empty/);
  });
});

describe('createCassetteFetch in replay-only mode', () => {
  it('replays a stored cassette', async () => {
    const recorder = createCassetteFetch({
      store,
      mode: 'record',
      realFetch: upstreamReturning('data: {"type":"finish"}\n\n'),
    });
    const recorded = await recorder(...gatewayRequest({ prompt: 'hi' }));
    await recorded.text();
    expect(store.list()).toHaveLength(1);

    const replayFetch = createCassetteFetch({ store, mode: 'replay-only' });
    const replayed = await replayFetch(...gatewayRequest({ prompt: 'hi' }));

    expect(await replayed.text()).toBe('data: {"type":"finish"}\n\n');
  });

  it('throws CassetteMissError on a miss instead of recording', async () => {
    const replayFetch = createCassetteFetch({ store, mode: 'replay-only' });

    await expect(replayFetch(...gatewayRequest({ prompt: 'unseen' }))).rejects.toBeInstanceOf(
      CassetteMissError
    );
    expect(store.list()).toEqual([]);
  });

  it('names the request shape but never the body in the miss error', async () => {
    const replayFetch = createCassetteFetch({ store, mode: 'replay-only' });

    const error = await replayFetch(...gatewayRequest({ prompt: 'secret-content' })).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(CassetteMissError);
    expect((error as CassetteMissError).message).toContain('/api/v1/chat/completions');
    expect((error as CassetteMissError).message).not.toContain('secret-content');
  });
});

describe('createCassetteFetch keys a repeated request by its occurrence', () => {
  it('replays a recorded poll sequence in the order it was recorded', async () => {
    const realFetch = scriptedUpstream([
      '{"id":"gen_vid","status":"queued"}',
      '{"status":"queued"}',
      '{"status":"in_progress"}',
      '{"status":"completed"}',
    ]);
    const recorder = createCassetteFetch({ store, mode: 'record', realFetch });

    const submitted = await recorder(...gatewayRequest({ prompt: 'a drone shot' }));
    await submitted.text();
    for (let poll = 0; poll < 3; poll += 1) {
      const polled = await recorder(...gatewayGetRequest('/api/v1/videos/gen_vid'));
      await polled.text();
    }

    const replayFetch = createCassetteFetch({ store, mode: 'replay-only' });
    const replayedSubmit = await replayFetch(...gatewayRequest({ prompt: 'a drone shot' }));
    await replayedSubmit.text();
    const replayedPolls: string[] = [];
    for (let poll = 0; poll < 3; poll += 1) {
      const polled = await replayFetch(...gatewayGetRequest('/api/v1/videos/gen_vid'));
      replayedPolls.push(await polled.text());
    }

    expect(replayedPolls).toEqual([
      '{"status":"queued"}',
      '{"status":"in_progress"}',
      '{"status":"completed"}',
    ]);
  });

  it('sends a second identical request to the live fetch and records it separately', async () => {
    const realFetch = scriptedUpstream(['{"call":"first"}', '{"call":"second"}']);
    const cassetteFetch = createCassetteFetch({ store, mode: 'record', realFetch });

    const first = await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));
    expect(await first.text()).toBe('{"call":"first"}');
    const second = await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));

    expect(await second.text()).toBe('{"call":"second"}');
    expect(realFetch).toHaveBeenCalledTimes(2);
    expect(new Set(store.list())).toHaveLength(2);
  });

  it('counts from zero again in a fresh closure', async () => {
    const recorder = createCassetteFetch({
      store,
      mode: 'record',
      realFetch: scriptedUpstream(['{"call":"first"}', '{"call":"second"}']),
    });
    const recordedFirst = await recorder(...gatewayRequest({ prompt: 'hi' }));
    await recordedFirst.text();
    const recordedSecond = await recorder(...gatewayRequest({ prompt: 'hi' }));
    await recordedSecond.text();

    const replayFetch = createCassetteFetch({ store, mode: 'replay-only' });
    const replayed = await replayFetch(...gatewayRequest({ prompt: 'hi' }));

    expect(await replayed.text()).toBe('{"call":"first"}');
  });

  it('falls through to the live fetch when a replay outruns the recorded sequence', async () => {
    const recorder = createCassetteFetch({
      store,
      mode: 'record',
      realFetch: scriptedUpstream(['{"call":"first"}', '{"call":"second"}']),
    });
    for (let call = 0; call < 2; call += 1) {
      const recorded = await recorder(...gatewayRequest({ prompt: 'hi' }));
      await recorded.text();
    }

    const laterRun = scriptedUpstream(['{"call":"third"}']);
    const laterFetch = createCassetteFetch({ store, mode: 'record', realFetch: laterRun });
    const bodies: string[] = [];
    for (let call = 0; call < 3; call += 1) {
      const response = await laterFetch(...gatewayRequest({ prompt: 'hi' }));
      bodies.push(await response.text());
    }

    expect(bodies).toEqual(['{"call":"first"}', '{"call":"second"}', '{"call":"third"}']);
    expect(laterRun).toHaveBeenCalledTimes(1);
    expect(new Set(store.list())).toHaveLength(3);
  });

  it('restarts the count in a live closure when a new scope begins', async () => {
    const realFetch = scriptedUpstream(['{"call":"first"}', '{"call":"second"}']);
    const cassetteFetch = createCassetteFetch({ store, mode: 'record', realFetch });

    const recorded = await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));
    expect(await recorded.text()).toBe('{"call":"first"}');

    beginCassetteScope();
    const afterScope = await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));

    expect(await afterScope.text()).toBe('{"call":"first"}');
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  it('replays a recording written under the bare-hash scheme as occurrence zero', async () => {
    const [url, init] = gatewayRequest({ prompt: 'hi' });
    const bareHash = descriptorHash(await requestToDescriptor(new Request(url, init)));
    store.write(bareHash, {
      version: 1,
      exchanges: [
        {
          status: 200,
          statusText: '',
          headers: { 'content-type': 'application/json' },
          chunks: [Buffer.from('{"call":"pre-existing"}').toString('base64')],
        },
      ],
      recordedAt: isoAt(TEST_DAY_START),
    });
    const realFetch = scriptedUpstream([]);
    const cassetteFetch = createCassetteFetch({ store, mode: 'record', realFetch });

    const replayed = await cassetteFetch(url, init);

    expect(await replayed.text()).toBe('{"call":"pre-existing"}');
    expect(realFetch).not.toHaveBeenCalled();
  });
});

/**
 * The scope's open/closed state, which is what lets a caller outside this
 * module ask whether its traffic is inside a counted sequence. The counter
 * itself only ever moves forward; this is a separate question from which scope
 * is current.
 */
describe('the cassette occurrence scope reports whether it is open', () => {
  afterEach(() => {
    endCassetteScope();
  });

  it('is open once a scope has begun', () => {
    beginCassetteScope();

    expect(cassetteScopeIsOpen()).toBe(true);
  });

  it('is closed again once the scope ends', () => {
    beginCassetteScope();
    endCassetteScope();

    expect(cassetteScopeIsOpen()).toBe(false);
  });

  it('keeps counting a repeated request across the end of a scope', async () => {
    const realFetch = scriptedUpstream(['{"call":"first"}', '{"call":"second"}']);
    const cassetteFetch = createCassetteFetch({ store, mode: 'record', realFetch });
    beginCassetteScope();
    const first = await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));
    await first.text();

    endCassetteScope();
    const second = await cassetteFetch(...gatewayRequest({ prompt: 'hi' }));

    expect(await second.text()).toBe('{"call":"second"}');
  });
});
