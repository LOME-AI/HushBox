import { describe, it, expect, vi, afterEach } from 'vitest';
import { fromBase64 } from '@hushbox/shared';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { MAX_PLAINTEXT_BYTES } from './encrypt.js';
import { sendWebPush } from './send.js';
import type { WebPushSendDeps, WebPushSubscription } from './send.js';

/** The injected clock: the VAPID token's `iat`/`exp` are derived from it. */
const NOW_MS = TEST_DAY_START;

const SUBSCRIPTION: WebPushSubscription = {
  endpoint: 'https://push.example.net/push/xyz',
  // RFC 8291 Appendix A UA public + auth secret (valid P-256 point + 16 bytes).
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};

const VAPID = {
  subject: 'mailto:test@hushbox.ai',
  publicKey:
    'BOeIadxzr8jCEiJstuK2__fGtYo6wWP0HMZDdYl-RWBXoSB9O1Bs4Dd4gPtm5WijJcYxrmH-i1QTCTzaj9xJ4tE',
  privateKey: 'SQ6hnT9IQ-46JeC7tl_zN_tJjH0v76csKdFBGcCYTx0',
} as const;

const PAYLOAD = new TextEncoder().encode('{"category":"message","conversationId":"c1"}');

function stubFetch(status: number): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(null, { status }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function deps(overrides: Partial<WebPushSendDeps> = {}): WebPushSendDeps {
  return {
    vapid: VAPID,
    fetchImpl: stubFetch(201).fetchImpl,
    now: () => NOW_MS,
    ...overrides,
  };
}

describe('sendWebPush — validation', () => {
  it('rejects a topic longer than 32 characters', async () => {
    const result = await sendWebPush(
      SUBSCRIPTION,
      PAYLOAD,
      { ttl: 60, topic: 'x'.repeat(33) },
      deps()
    );
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a topic with characters outside [A-Za-z0-9_-]', async () => {
    const result = await sendWebPush(
      SUBSCRIPTION,
      PAYLOAD,
      { ttl: 60, topic: 'has spaces' },
      deps()
    );
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('accepts a 32-character alias topic', async () => {
    const result = await sendWebPush(
      SUBSCRIPTION,
      PAYLOAD,
      { ttl: 60, topic: 'A'.repeat(32) },
      deps()
    );
    expect(result.isOk()).toBe(true);
  });

  it('rejects a negative or non-integer ttl', async () => {
    const negative = await sendWebPush(SUBSCRIPTION, PAYLOAD, { ttl: -1 }, deps());
    const fractional = await sendWebPush(SUBSCRIPTION, PAYLOAD, { ttl: 1.5 }, deps());
    expect(negative._unsafeUnwrapErr().code).toBe('validation');
    expect(fractional._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects an unknown urgency', async () => {
    const result = await sendWebPush(SUBSCRIPTION, PAYLOAD, { ttl: 60, urgency: 'urgent' }, deps());
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a payload one octet past the interoperable plaintext ceiling', async () => {
    const overLimit = new Uint8Array(MAX_PLAINTEXT_BYTES + 1);
    const result = await sendWebPush(SUBSCRIPTION, overLimit, { ttl: 60 }, deps());
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('accepts a payload at exactly the interoperable plaintext ceiling', async () => {
    const atLimit = new Uint8Array(MAX_PLAINTEXT_BYTES);
    const result = await sendWebPush(SUBSCRIPTION, atLimit, { ttl: 60 }, deps());
    expect(result.isOk()).toBe(true);
  });
});

describe('sendWebPush — request shape', () => {
  it('POSTs the encrypted body with aes128gcm and VAPID headers', async () => {
    const { fetchImpl, calls } = stubFetch(201);
    const result = await sendWebPush(
      SUBSCRIPTION,
      PAYLOAD,
      { ttl: 120, topic: 'alias123', urgency: 'high' },
      deps({ fetchImpl })
    );

    expect(result.isOk()).toBe(true);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(SUBSCRIPTION.endpoint);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers['Content-Type']).toBe('application/octet-stream');
    expect(headers['TTL']).toBe('120');
    expect(headers['Topic']).toBe('alias123');
    expect(headers['Urgency']).toBe('high');
    expect(headers['Authorization']).toMatch(/^vapid t=.+, k=.+$/);
    // Body is the RFC 8188 header (salt || rs || idlen(65) || keyid), not the plaintext.
    const body = init.body as Uint8Array;
    expect(body).toBeInstanceOf(Uint8Array);
    expect(body[20]).toBe(65);
    expect(body).not.toEqual(PAYLOAD);
  });

  it('omits Topic and Urgency headers when not supplied', async () => {
    const { fetchImpl, calls } = stubFetch(201);
    const result = await sendWebPush(SUBSCRIPTION, PAYLOAD, { ttl: 60 }, deps({ fetchImpl }));
    expect(result.isOk()).toBe(true);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Topic']).toBeUndefined();
    expect(headers['Urgency']).toBeUndefined();
  });

  it('uses an injected salt and ephemeral key deterministically', async () => {
    const salt = fromBase64('DGv6ra1nlYgDCS1FRnbzlw');
    const { fetchImpl, calls } = stubFetch(201);
    const result = await sendWebPush(
      SUBSCRIPTION,
      PAYLOAD,
      { ttl: 60 },
      deps({ fetchImpl, generateSalt: () => salt })
    );
    expect(result.isOk()).toBe(true);

    const body = calls[0]!.init.body as Uint8Array;
    expect(body.subarray(0, 16)).toEqual(salt);
  });
});

describe('sendWebPush — outcome classification', () => {
  it('reports delivered on a 2xx response', async () => {
    const result = await sendWebPush(
      SUBSCRIPTION,
      PAYLOAD,
      { ttl: 60 },
      deps({ fetchImpl: stubFetch(201).fetchImpl })
    );
    expect(result._unsafeUnwrap()).toEqual({ outcome: 'delivered', statusCode: 201 });
  });

  it('reports dead on a 404 (subscription gone)', async () => {
    const result = await sendWebPush(
      SUBSCRIPTION,
      PAYLOAD,
      { ttl: 60 },
      deps({ fetchImpl: stubFetch(404).fetchImpl })
    );
    expect(result._unsafeUnwrap()).toEqual({ outcome: 'dead', statusCode: 404 });
  });

  it('reports dead on a 410 (subscription expired)', async () => {
    const result = await sendWebPush(
      SUBSCRIPTION,
      PAYLOAD,
      { ttl: 60 },
      deps({ fetchImpl: stubFetch(410).fetchImpl })
    );
    expect(result._unsafeUnwrap()).toEqual({ outcome: 'dead', statusCode: 410 });
  });

  it('reports dead on a 401 (VAPID signature rejected)', async () => {
    const result = await sendWebPush(
      SUBSCRIPTION,
      PAYLOAD,
      { ttl: 60 },
      deps({ fetchImpl: stubFetch(401).fetchImpl })
    );
    expect(result._unsafeUnwrap()).toEqual({ outcome: 'dead', statusCode: 401 });
  });

  it('reports dead on a 403 (VAPID key no longer matches the subscription)', async () => {
    const result = await sendWebPush(
      SUBSCRIPTION,
      PAYLOAD,
      { ttl: 60 },
      deps({ fetchImpl: stubFetch(403).fetchImpl })
    );
    expect(result._unsafeUnwrap()).toEqual({ outcome: 'dead', statusCode: 403 });
  });

  it('reports a transient failure on a 5xx without retrying', async () => {
    const result = await sendWebPush(
      SUBSCRIPTION,
      PAYLOAD,
      { ttl: 60 },
      deps({ fetchImpl: stubFetch(503).fetchImpl })
    );
    expect(result._unsafeUnwrap()).toEqual({ outcome: 'failed', statusCode: 503 });
  });

  it('reports a transient failure on a 429 rate limit', async () => {
    const result = await sendWebPush(
      SUBSCRIPTION,
      PAYLOAD,
      { ttl: 60 },
      deps({ fetchImpl: stubFetch(429).fetchImpl })
    );
    expect(result._unsafeUnwrap()).toEqual({ outcome: 'failed', statusCode: 429 });
  });

  it('returns an unavailable error when the encryption step fails', async () => {
    const result = await sendWebPush(
      SUBSCRIPTION,
      PAYLOAD,
      { ttl: 60 },
      deps({ generateEphemeral: () => Promise.reject(new Error('no key material')) })
    );

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('returns an unavailable error when the transport throws', async () => {
    const throwing = (() => Promise.reject(new Error('network down'))) as unknown as typeof fetch;
    const result = await sendWebPush(
      SUBSCRIPTION,
      PAYLOAD,
      { ttl: 60 },
      deps({ fetchImpl: throwing })
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('falls back to the global fetch and clock when deps omit them', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', ((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response(null, { status: 201 }));
    }) as unknown as typeof fetch);

    const result = await sendWebPush(SUBSCRIPTION, PAYLOAD, { ttl: 60 }, { vapid: VAPID });

    expect(result._unsafeUnwrap().outcome).toBe('delivered');
    expect(calls).toEqual([SUBSCRIPTION.endpoint]);
  });
});

describe('sendWebPush — timeout', () => {
  it('fails with a timeout error when the push service never responds', async () => {
    const hanging = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

    const result = await sendWebPush(
      SUBSCRIPTION,
      PAYLOAD,
      { ttl: 60 },
      deps({ fetchImpl: hanging, timeoutMs: 25 })
    );

    expect(result._unsafeUnwrapErr().code).toBe('timeout');
  });

  it('aborts the hanging request rather than leaving it running', async () => {
    let aborted = false;
    const hanging = ((_url: string, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;

    const result = await sendWebPush(
      SUBSCRIPTION,
      PAYLOAD,
      { ttl: 60 },
      deps({ fetchImpl: hanging, timeoutMs: 25 })
    );

    expect(result.isErr()).toBe(true);
    expect(aborted).toBe(true);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
