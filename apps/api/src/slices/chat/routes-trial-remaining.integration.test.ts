// GET /chat/trial/remaining: the trial allowance a caller has left today, and
// the three things that makes it safe to serve on a public route — an
// authenticated caller is refused, no client-named identity is honored, and
// the per-IP throttle answers before the quota is read.
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, TRIAL_MESSAGE_LIMIT } from '@hushbox/shared';
import {
  CHAT_TRIAL_REMAINING_IP_RATE_LIMIT,
  consumeTrialQuota,
  trialQuotaIpKey,
} from './domain/index.js';
import {
  STARTED,
  cookie,
  createApp,
  fakeRealtime,
  getPath,
  ipIdentity,
  redis,
  seedUser,
  testEnv,
} from '../../test-support/chat-routes.integration.setup.js';
import { rateLimitKey } from '../../lib/rate-limit/index.js';

const PATH = '/chat/trial/remaining';

/** A trial caller nothing else in the suite shares: its own token and its own IP. */
function trialCaller(): { readonly token: string; readonly ip: string } {
  return {
    token: crypto.randomUUID(),
    ip: `198.51.100.9-${crypto.randomUUID()}`,
  };
}

function headersFor(caller: {
  readonly token: string;
  readonly ip: string;
}): Record<string, string> {
  return { 'x-trial-token': caller.token, 'cf-connecting-ip': caller.ip };
}

/** Spends `slots` of a caller's daily quota through the same gate the send route uses. */
async function spend(
  caller: { readonly token: string; readonly ip: string },
  slots: number
): Promise<void> {
  for (let slot = 0; slot < slots; slot += 1) {
    const decision = await consumeTrialQuota(redis, {
      sessionId: caller.token,
      ipHash: await ipIdentity(caller.ip),
      now: new Date(),
    });
    decision._unsafeUnwrap();
  }
}

async function remainingFor(caller: {
  readonly token: string;
  readonly ip: string;
}): Promise<Response> {
  return getPath(PATH, fakeRealtime(STARTED), headersFor(caller));
}

describe('chat route: GET /chat/trial/remaining', () => {
  it('serves the whole daily allowance to a caller that has sent nothing', async () => {
    const res = await remainingFor(trialCaller());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ remaining: TRIAL_MESSAGE_LIMIT });
  });

  it('serves a caller that presents no token at all', async () => {
    // The first visit: the composer asks before it has minted a token. The
    // session is minted server-side for the read, so the answer is the IP's.
    const caller = trialCaller();
    await spend(caller, 1);

    const res = await getPath(PATH, fakeRealtime(STARTED), {
      'cf-connecting-ip': caller.ip,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ remaining: TRIAL_MESSAGE_LIMIT - 1 });
  });

  it('serves the allowance left after the caller has spent slots', async () => {
    const caller = trialCaller();
    await spend(caller, 2);

    const res = await remainingFor(caller);

    expect(await res.json()).toEqual({ remaining: TRIAL_MESSAGE_LIMIT - 2 });
  });

  it('answers a token never seen exactly as a token with nothing to report', async () => {
    // The existence-oracle pin. A trial session is never persisted, so "unknown"
    // and "known but unspent" are the same state; the route must not manufacture
    // a difference between them in status or body. Same IP for both, so the only
    // variable is the token: one freshly minted here (never presented anywhere),
    // one this suite has already spent a request under.
    const known = trialCaller();
    await remainingFor(known);

    const unknown = await getPath(PATH, fakeRealtime(STARTED), {
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': known.ip,
    });
    const seen = await remainingFor(known);

    expect(unknown.status).toBe(seen.status);
    expect(await unknown.json()).toEqual(await seen.json());
  });

  it('serves each caller its own count', async () => {
    const spender = trialCaller();
    const bystander = trialCaller();
    await spend(spender, 3);

    const spent = await remainingFor(spender);
    const untouched = await remainingFor(bystander);

    expect(await spent.json()).toEqual({ remaining: TRIAL_MESSAGE_LIMIT - 3 });
    expect(await untouched.json()).toEqual({ remaining: TRIAL_MESSAGE_LIMIT });
  });

  it('ignores a client-named identity, answering only for the request credentials', async () => {
    // A crafted request naming another identity must not retarget the read: the
    // session comes from the x-trial-token the caller presents and the IP from
    // the edge header, so no query parameter can reach a foreign count.
    const exhausted = trialCaller();
    await spend(exhausted, TRIAL_MESSAGE_LIMIT);
    const caller = trialCaller();

    const res = await getPath(
      `${PATH}?sessionId=${exhausted.token}&ipHash=${encodeURIComponent(exhausted.ip)}`,
      fakeRealtime(STARTED),
      headersFor(caller)
    );

    expect(await res.json()).toEqual({ remaining: TRIAL_MESSAGE_LIMIT });
  });

  it('refuses an authenticated caller', async () => {
    const userId = await seedUser();
    const caller = trialCaller();

    const res = await getPath(PATH, fakeRealtime(STARTED), {
      ...headersFor(caller),
      cookie: await cookie(userId),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.AUTHENTICATED_ON_TRIAL });
  });

  it('spends the read against its own per-IP throttle', async () => {
    const caller = trialCaller();
    const key = rateLimitKey(
      CHAT_TRIAL_REMAINING_IP_RATE_LIMIT,
      await ipIdentity(caller.ip)
    )._unsafeUnwrap();

    await remainingFor(caller);

    try {
      expect(await redis.get<number>(key)).toBe(1);
    } finally {
      await redis.del(key);
    }
  });

  it('refuses over the throttle cap without reading the quota', async () => {
    const caller = trialCaller();
    const { maxAttempts, windowSeconds } = CHAT_TRIAL_REMAINING_IP_RATE_LIMIT;
    const key = rateLimitKey(
      CHAT_TRIAL_REMAINING_IP_RATE_LIMIT,
      await ipIdentity(caller.ip)
    )._unsafeUnwrap();
    await redis.set(key, maxAttempts, { ex: windowSeconds });

    try {
      const res = await remainingFor(caller);

      expect(res.status).toBe(429);
      // No count in the refusal body: the throttle answered before the quota
      // was read, so there was never a number to leak.
      expect(await res.json()).toEqual({
        code: ERROR_CODES.RATE_LIMITED,
        details: { retryAfterSeconds: expect.any(Number) },
      });
    } finally {
      await redis.del(key);
    }
  });

  it('refuses rather than guessing when a counter holds an unreadable value', async () => {
    const caller = trialCaller();
    const key = trialQuotaIpKey(new Date(), await ipIdentity(caller.ip))._unsafeUnwrap();
    await redis.set(key, 'corrupt', { ex: 60 });

    try {
      const res = await remainingFor(caller);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
    } finally {
      await redis.del(key);
    }
  });

  it('serves the count with no database reachable', async () => {
    // The read touches Redis only. Pointing the database at a dead address
    // proves it rather than asserting it: any Postgres touch on this path would
    // answer 503 instead of the count.
    const deadDbEnv = {
      ...testEnv,
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:9/hushbox',
    };
    const caller = trialCaller();

    const res = await createApp(fakeRealtime(STARTED)).request(
      PATH,
      { method: 'GET', headers: headersFor(caller) },
      deadDbEnv
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ remaining: TRIAL_MESSAGE_LIMIT });
  });
});
