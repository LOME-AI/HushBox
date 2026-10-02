import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { LINK_AUTH_TOKEN_BYTES } from '@hushbox/crypto';
import { ERROR_CODES, createEnvUtilities, toBase64, toStandardBase64 } from '@hushbox/shared';
import { bindRequestValue } from '../lib/context/index.js';
import { unavailableError, validationError } from '../lib/errors/index.js';
import { err, ok } from '../lib/result/index.js';
import { callerIpIdForAddress } from '../lib/redis/index.js';
import {
  callerIdentity,
  hashRateLimitId,
  ipIdentity,
  linkCredentialIdentity,
  rateLimitRefusal,
  sessionlessIpIdentity,
} from './rate-limit.js';
import type { Context } from 'hono';
import type { DomainError } from '../lib/errors/index.js';
import type { Result } from '../lib/result/index.js';
import type { AppEnv, Principal } from '../lib/context/index.js';

/**
 * This module's own tests, and what belongs to it is the IDENTIFIER each
 * resolver derives from a request plus what a decision projects to. No counter
 * is touched here: the counting is `lib/rate-limit`'s and is measured against
 * real Redis there, and what the posture stage does with these identifiers is
 * measured in `pipeline-rate-limit.test.ts` and through the composed app.
 */

const DEVELOPMENT = createEnvUtilities({ NODE_ENV: 'development' });
const PRODUCTION = createEnvUtilities({ NODE_ENV: 'production' });

function fullPrincipal(userId: string): Principal {
  return {
    kind: 'full',
    claims: {
      userId,
      sessionId: 'session',
      createdAt: 0,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
  };
}

interface ProbeOptions {
  readonly principal?: Principal;
  readonly headers?: Record<string, string>;
  readonly envUtilities?: ReturnType<typeof createEnvUtilities>;
}

/**
 * Runs a resolver against a real request context. `envUtils` is set for the
 * same reason the real app sets it in pipeline stage 1: every resolver that
 * reads an address reads it.
 */
async function resolveIdentity<T>(
  identify: (c: Context<AppEnv>) => Promise<Result<T, DomainError>>,
  options: ProbeOptions = {}
): Promise<Result<T, DomainError>> {
  let resolved: Result<T, DomainError> | undefined;
  const app = new Hono<AppEnv>()
    .use('*', async (c, next) => {
      bindRequestValue(c, 'principal', options.principal ?? { kind: 'none' });
      c.set('envUtils', options.envUtilities ?? DEVELOPMENT);
      await next();
    })
    .all('/probe', async (c) => {
      resolved = await identify(c);
      return c.json({ ok: true });
    });
  await app.request('/probe', { headers: options.headers ?? {} });
  if (resolved === undefined) throw new Error('the probe handler never ran');
  return resolved;
}

const CREDENTIAL_HEADER = 'x-link-auth';
// A link-auth-token-sized value whose canonical (URL-safe, unpadded) and standard
// (padded, `+`/`/`) encodings differ — the permutation space `fromBase64`
// collapses when the credential is resolved. Fixed rather than minted, because a
// random token need not contain the characters the two alphabets disagree on.
const linkAuthToken = Uint8Array.from(
  { length: LINK_AUTH_TOKEN_BYTES },
  (_, index) => (index * 37 + 201) % 256
);
const canonical = toBase64(linkAuthToken);
const permutations = [canonical, `${canonical}==`, toStandardBase64(linkAuthToken)];

describe('hashRateLimitId', () => {
  it('produces the SHA-256 hex of the identifier (never a raw identifier in a key)', async () => {
    // sha256('1.1.1.1') — fixed vector so a digest change cannot slip by.
    expect(await hashRateLimitId('1.1.1.1')).toBe(
      'f1412386aa8db2579aff2636cb9511cacc5fd9880ecab60c048508fbe26ee4d9'
    );
  });

  it('is deterministic', async () => {
    expect(await hashRateLimitId('abc')).toBe(await hashRateLimitId('abc'));
  });
});

describe('the decision a refusal is built from', () => {
  it('answers a refusal with the standard 429 body and its retry window', async () => {
    const app = new Hono<AppEnv>().get(
      '/refused',
      (c) =>
        rateLimitRefusal(c, ok({ allowed: false, count: 3, retryAfterSeconds: 57 }), 'closed') ??
        c.text('admitted')
    );
    const res = await app.request('/refused');
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 57 },
    });
  });

  it('answers an admitted decision with no response at all', async () => {
    const app = new Hono<AppEnv>().get(
      '/admitted',
      (c) => rateLimitRefusal(c, ok({ allowed: true, count: 1 }), 'closed') ?? c.text('admitted')
    );
    const res = await app.request('/admitted');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('admitted');
  });

  // The refusal tail is reachable from the counting primitive only through
  // `consume`, which carries no `wireCode` today — so the projection is pinned
  // on the responder directly. Answering the taxonomy code here instead would
  // give this one path a different message from every other route, since the
  // client maps the code to what the user reads.
  it('projects a carried wire code, at the taxonomy status', async () => {
    const app = new Hono<AppEnv>().get(
      '/refused',
      (c) =>
        rateLimitRefusal(
          c,
          err(validationError('boom', undefined, ERROR_CODES.UNSUPPORTED_MODALITY)),
          'closed'
        ) ?? c.text('admitted')
    );
    const res = await app.request('/refused');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'UNSUPPORTED_MODALITY' });
  });

  it('falls back to the taxonomy wire code on a codeless validation refusal', async () => {
    const app = new Hono<AppEnv>().get(
      '/refused',
      (c) =>
        rateLimitRefusal(c, err(validationError('identifier too long')), 'closed') ??
        c.text('admitted')
    );
    const res = await app.request('/refused');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  // The whole reason this arm has a code of its own: a caller reading
  // UNAVAILABLE cannot tell a counter it could not reach from a handler that
  // failed after doing work, and one of those handlers charges a card.
  it('answers an unreachable counter with the limiter code, at the taxonomy status', async () => {
    const app = new Hono<AppEnv>().get(
      '/refused',
      (c) =>
        rateLimitRefusal(c, err(unavailableError('redis down')), 'closed') ?? c.text('admitted')
    );
    const res = await app.request('/refused');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'RATE_LIMIT_UNAVAILABLE' });
  });

  // The stamp defers to a carrier, so a future error naming its own condition
  // keeps it rather than being flattened into the limiter's.
  it('leaves an unavailable error that carries its own wire code alone', async () => {
    const app = new Hono<AppEnv>().get(
      '/refused',
      (c) =>
        rateLimitRefusal(
          c,
          err(unavailableError('boom', undefined, ERROR_CODES.SERVICE_UNAVAILABLE)),
          'closed'
        ) ?? c.text('admitted')
    );
    const res = await app.request('/refused');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
  });

  // The failure posture is a parameter of this function rather than a property
  // of the path that calls it, which is what lets a named route and a class
  // default declare opposite answers to the same input.
  it('answers a spend that failed with no response at all when the route declares open', async () => {
    const app = new Hono<AppEnv>().get(
      '/open',
      (c) => rateLimitRefusal(c, err(unavailableError('redis down')), 'open') ?? c.text('admitted')
    );
    const res = await app.request('/open');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('admitted');
  });

  // The open arm covers every way a spend can answer no decision, including
  // the over-long identifier a `validation` error carries — the enumeration is
  // "the bound could not be spent", never one error code.
  it('admits a codeless validation refusal when the route declares open', async () => {
    const app = new Hono<AppEnv>().get(
      '/open',
      (c) =>
        rateLimitRefusal(c, err(validationError('identifier too long')), 'open') ??
        c.text('admitted')
    );
    const res = await app.request('/open');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('admitted');
  });

  // The law: the failure posture governs the unspendable case and nothing
  // else, so a caller past the cap is refused under either value.
  it('still refuses a caller past the cap when the route declares open', async () => {
    const app = new Hono<AppEnv>().get(
      '/open',
      (c) =>
        rateLimitRefusal(c, ok({ allowed: false, count: 9, retryAfterSeconds: 12 }), 'open') ??
        c.text('admitted')
    );
    const res = await app.request('/open');
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 12 },
    });
  });
});

describe('ipIdentity', () => {
  async function identifiersFor(ips: readonly string[]): Promise<string[]> {
    const resolved = await Promise.all(
      ips.map(async (ip) => resolveIdentity(ipIdentity, { headers: { 'cf-connecting-ip': ip } }))
    );
    return resolved.map((result) => result._unsafeUnwrap());
  }

  it('collapses addresses sharing a /64 onto one identifier', async () => {
    const identifiers = await identifiersFor([
      '2001:db8:1:2::1',
      '2001:db8:1:2:ffff:ffff:ffff:ffff',
      '2001:db8:1:2::beef',
    ]);

    expect(identifiers).toEqual(Array.from({ length: 3 }, () => identifiers[0]));
    expect(identifiers[0]).toBe(await callerIpIdForAddress('2001:db8:1:2::1'));
  });

  it('gives each /64 its own identifier', async () => {
    const identifiers = await identifiersFor([
      '2001:db8:1:2::1',
      '2001:db8:1:3::1',
      '2001:db8:1:4::1',
    ]);

    expect(new Set(identifiers).size).toBe(3);
  });

  // The edge sets `cf-connecting-ip` on every production request that reaches
  // the Worker, so its absence is a fault rather than a caller property. The
  // window these callers would otherwise share is the sentinel's — one window
  // for everyone behind the fault, which caps the fault rather than any caller.
  it('refuses a production caller the edge set no address for', async () => {
    const resolved = await resolveIdentity(ipIdentity, {
      headers: { 'x-forwarded-for': '198.51.100.66' },
      envUtilities: PRODUCTION,
    });

    expect(resolved._unsafeUnwrapErr()).toEqual(unavailableError('caller ip unresolved'));
  });

  // The pair proves the resolver reads the request's own `envUtils` rather than
  // a mode fixed at import: hard-coding either mode fails one of the two.
  it('still opens an identifier per x-forwarded-for caller in development', async () => {
    const resolved = await resolveIdentity(ipIdentity, {
      headers: { 'x-forwarded-for': '198.51.100.66' },
    });

    expect(resolved._unsafeUnwrap()).toBe(await callerIpIdForAddress('198.51.100.66'));
  });
});

describe('sessionlessIpIdentity', () => {
  const ipHeaders = { 'cf-connecting-ip': '9.9.9.9' };

  it('counts a sessionless caller under its IP identity', async () => {
    const resolved = await resolveIdentity(sessionlessIpIdentity, { headers: ipHeaders });

    expect(resolved._unsafeUnwrap()).toBe(await callerIpIdForAddress('9.9.9.9'));
  });

  it('leaves a full principal uncounted', async () => {
    const resolved = await resolveIdentity(sessionlessIpIdentity, {
      headers: ipHeaders,
      principal: fullPrincipal('user-1'),
    });

    expect(resolved._unsafeUnwrap()).toBeNull();
  });

  it('refuses a production sessionless caller the edge set no address for', async () => {
    const resolved = await resolveIdentity(sessionlessIpIdentity, { envUtilities: PRODUCTION });

    expect(resolved._unsafeUnwrapErr()).toEqual(unavailableError('caller ip unresolved'));
  });

  // The refusal belongs to the IP identity, not to the request: a caller this
  // layer never counts is never refused for an address it never resolved.
  it('leaves a production full principal uncounted without the edge header', async () => {
    const resolved = await resolveIdentity(sessionlessIpIdentity, {
      principal: fullPrincipal('user-1'),
      envUtilities: PRODUCTION,
    });

    expect(resolved._unsafeUnwrap()).toBeNull();
  });
});

describe('callerIdentity', () => {
  const IP = '5.5.5.5';
  const identify = callerIdentity(CREDENTIAL_HEADER);

  it('keys an authenticated caller on its user id', async () => {
    const resolved = await resolveIdentity(identify, {
      principal: fullPrincipal('user-1'),
      headers: { [CREDENTIAL_HEADER]: canonical },
      envUtilities: PRODUCTION,
    });

    expect(resolved._unsafeUnwrap()).toBe('user-1');
  });

  it('carries both the hashed IP and the hashed credential in one identifier', async () => {
    const resolved = await resolveIdentity(identify, {
      headers: { 'cf-connecting-ip': IP, [CREDENTIAL_HEADER]: canonical },
    });

    expect(resolved._unsafeUnwrap()).toBe(
      `ip:${await callerIpIdForAddress(IP)}:link:${await hashRateLimitId(canonical)}`
    );
  });

  it('resolves every encoding of one credential to that single identifier', async () => {
    // The three headers are distinct strings that decode to identical bytes:
    // without collapsing them each would open its own window.
    expect(new Set(permutations).size).toBe(3);
    const resolved = await Promise.all(
      permutations.map(async (credential) =>
        resolveIdentity(identify, {
          headers: { 'cf-connecting-ip': IP, [CREDENTIAL_HEADER]: credential },
        })
      )
    );

    expect(new Set(resolved.map((result) => result._unsafeUnwrap())).size).toBe(1);
  });

  it('resolves the same credential to a different identifier per IP', async () => {
    const here = await resolveIdentity(identify, {
      headers: { 'cf-connecting-ip': IP, [CREDENTIAL_HEADER]: canonical },
    });
    const elsewhere = await resolveIdentity(identify, {
      headers: { 'cf-connecting-ip': '6.6.6.6', [CREDENTIAL_HEADER]: canonical },
    });

    expect(here._unsafeUnwrap()).not.toBe(elsewhere._unsafeUnwrap());
  });

  it('keys a credential that identifies no link on the IP alone', async () => {
    const expected = `ip:${await callerIpIdForAddress(IP)}`;
    const undecodable = await resolveIdentity(identify, {
      headers: { 'cf-connecting-ip': IP, [CREDENTIAL_HEADER]: 'not*base64' },
    });
    const empty = await resolveIdentity(identify, {
      headers: { 'cf-connecting-ip': IP, [CREDENTIAL_HEADER]: '' },
    });
    const absent = await resolveIdentity(identify, { headers: { 'cf-connecting-ip': IP } });

    expect([undecodable, empty, absent].map((result) => result._unsafeUnwrap())).toEqual([
      expected,
      expected,
      expected,
    ]);
  });

  // The IP half is what anchors this composite — the credential half is
  // caller-presented and rotatable. Without an address to anchor on, the
  // identifier bounds nothing, so the request is refused rather than keyed on
  // the sentinel.
  it('refuses a production guest the edge set no address for', async () => {
    const resolved = await resolveIdentity(identify, {
      headers: { [CREDENTIAL_HEADER]: canonical },
      envUtilities: PRODUCTION,
    });

    expect(resolved._unsafeUnwrapErr()).toEqual(unavailableError('caller ip unresolved'));
  });
});

describe('linkCredentialIdentity', () => {
  const identify = linkCredentialIdentity(CREDENTIAL_HEADER);

  it('keys the link on its hashed canonical credential alone', async () => {
    const resolved = await resolveIdentity(identify, {
      headers: { 'cf-connecting-ip': '7.7.7.7', [CREDENTIAL_HEADER]: canonical },
    });

    expect(resolved._unsafeUnwrap()).toBe(await hashRateLimitId(canonical));
  });

  it('resolves every encoding of one credential to that single identifier', async () => {
    const resolved = await Promise.all(
      permutations.map(async (credential) =>
        resolveIdentity(identify, { headers: { [CREDENTIAL_HEADER]: credential } })
      )
    );

    expect(resolved.map((result) => result._unsafeUnwrap())).toEqual(
      Array.from({ length: 3 }, () => resolved[0]?._unsafeUnwrap())
    );
  });

  it('leaves an authenticated caller out of the window of any link', async () => {
    const resolved = await resolveIdentity(identify, {
      principal: fullPrincipal('user-1'),
      headers: { [CREDENTIAL_HEADER]: canonical },
    });

    expect(resolved._unsafeUnwrap()).toBeNull();
  });

  it('counts no caller presenting no credential', async () => {
    const resolved = await resolveIdentity(identify, {});

    expect(resolved._unsafeUnwrap()).toBeNull();
  });

  it('counts no credential that decodes to nothing', async () => {
    const undecodable = await resolveIdentity(identify, {
      headers: { [CREDENTIAL_HEADER]: 'not*base64' },
    });
    const empty = await resolveIdentity(identify, { headers: { [CREDENTIAL_HEADER]: '' } });

    expect([undecodable._unsafeUnwrap(), empty._unsafeUnwrap()]).toEqual([null, null]);
  });
});
