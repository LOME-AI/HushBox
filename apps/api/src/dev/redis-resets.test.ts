import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  SECOND_MS,
  TEST_DAY_START,
  freezeClock,
} from '@hushbox/shared/test-time';
import {
  CHAT_GUEST_SEND_IP_RATE_LIMIT,
  CHAT_STOP_IP_RATE_LIMIT,
  trialQuotaIpKey,
} from '../slices/chat/index.js';
import {
  guestConversationIpRateLimit,
  linkCreateRateLimit,
  memberKeysBatchRateLimit,
  publicShareReadRateLimit,
} from '../slices/conversations/index.js';
import {
  adminAuditSearchRateLimit,
  adminCustomer360RateLimit,
  adminDashboardRateLimit,
  adminFeedbackRateLimit,
  adminJobQueueRateLimit,
  adminNewsletterSubscribersRateLimit,
  adminOpsRateLimit,
  adminSqlPanelRateLimit,
} from '../slices/admin/index.js';
import { MEDIA_RATE_LIMITS } from '../slices/media/index.js';
import { loginNetworkLockoutKey, recoveryNetworkLockoutKeys } from '../slices/identity/index.js';
import {
  AUTH_IP_THROTTLES,
  authResetKeys,
  resetAdminOpsRuns,
  resetAuthRateLimits,
  resetTrialUsage,
  resetUsageRateLimits,
} from './redis-resets.js';
import { hmacRateLimitId, rateLimitKey } from '../lib/rate-limit/index.js';
import type { Redis } from '@upstash/redis';
import type { AuthResetIdentity } from './redis-resets.js';
import type { RateLimitDefinition } from '../lib/rate-limit/index.js';

/**
 * A Redis stub over an empty keyspace that records the globs handed to the
 * server-side sweep — which names them as the script's keys — and every key
 * passed to `del`.
 */
function stubSweepRedis(): { redis: Redis; matches: string[]; deleted: string[] } {
  const matches: string[] = [];
  const deleted: string[] = [];
  const evaluate = vi.fn((_script: string, patterns: string[]) => {
    matches.push(...patterns);
    return Promise.resolve(0);
  });
  const del = vi.fn((...keys: string[]) => {
    deleted.push(...keys);
    return Promise.resolve(0);
  });
  return { redis: { eval: evaluate, del } as unknown as Redis, matches, deleted };
}

/**
 * A Redis stub over a real keyspace: the sweep removes every seeded key its
 * `prefix*` globs cover and `del` removes the keys it names, so a test can
 * assert what SURVIVED a reset rather than only what it asked for.
 */
function stubKeyspaceRedis(seed: readonly string[]): { redis: Redis; remaining: () => string[] } {
  const keyspace = new Set(seed);
  const evaluate = (_script: string, patterns: string[]): Promise<number> => {
    let deleted = 0;
    for (const pattern of patterns) {
      const prefix = pattern.replace(/\*$/, '');
      for (const key of keyspace) {
        if (!key.startsWith(prefix)) continue;
        keyspace.delete(key);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  };
  const del = (...keys: string[]): Promise<number> => {
    for (const key of keys) keyspace.delete(key);
    return Promise.resolve(0);
  };
  return {
    redis: { eval: evaluate, del } as unknown as Redis,
    remaining: () => [...keyspace].toSorted((left, right) => left.localeCompare(right)),
  };
}

/** A stand-in for the caller's hashed IP identity (`callerIpId` answers hex). */
const CALLER_IP_ID = 'a'.repeat(64);

/** A second identity, standing in for another project's or guest's address. */
const OTHER_IP_ID = 'b'.repeat(64);

/** The five per-IP windows the usage reset narrows to its caller. */
const USAGE_IP_LIMITS = [
  MEDIA_RATE_LIMITS.sharePresignIpRateLimit,
  publicShareReadRateLimit,
  guestConversationIpRateLimit,
  CHAT_GUEST_SEND_IP_RATE_LIMIT,
  CHAT_STOP_IP_RATE_LIMIT,
];

/** The key a counter for `id` lives at: the definition's key over its keyed digest. */
function counterKey(definition: RateLimitDefinition, id: string): string {
  return rateLimitKey(definition, id)._unsafeUnwrap();
}

/** The account the reset is asked to clear, and one it is never asked about. */
const NAMED: AuthResetIdentity = { canonical: 'named@identity.test', userId: 'user-named' };
const UNNAMED: AuthResetIdentity = { canonical: 'other@identity.test', userId: 'user-other' };

describe('resetAuthRateLimits', () => {
  it('clears the per-IP auth limiter buckets belonging to the calling identity', async () => {
    const { redis, deleted } = stubSweepRedis();

    await resetAuthRateLimits(redis, CALLER_IP_ID, []);

    expect(deleted).toEqual(
      expect.arrayContaining([
        `ratelimit:identity:login:ip:${hmacRateLimitId(CALLER_IP_ID)}`,
        `ratelimit:identity:register:ip:${hmacRateLimitId(CALLER_IP_ID)}`,
        `ratelimit:identity:recovery-reset:ip:${hmacRateLimitId(CALLER_IP_ID)}`,
        `ratelimit:identity:recovery-getkey:ip:${hmacRateLimitId(CALLER_IP_ID)}`,
        `ratelimit:identity:verify-email:ip:${hmacRateLimitId(CALLER_IP_ID)}`,
        `ratelimit:identity:resend-verify:ip:${hmacRateLimitId(CALLER_IP_ID)}`,
      ])
    );
  });

  it('leaves every other identity’s per-IP buckets alone', async () => {
    const { redis, matches } = stubSweepRedis();

    await resetAuthRateLimits(redis, CALLER_IP_ID, []);

    expect(matches.filter((match) => match.includes(':ip:'))).toEqual([]);
  });

  it('clears every auth counter the named account can carry', async () => {
    const { redis, deleted } = stubSweepRedis();

    await resetAuthRateLimits(redis, CALLER_IP_ID, [NAMED]);

    expect(deleted).toEqual(
      expect.arrayContaining([
        `ratelimit:identity:login:lockout:${hmacRateLimitId(NAMED.canonical)}`,
        `ratelimit:identity:recovery-getkey:lockout:${hmacRateLimitId(NAMED.canonical)}`,
        `ratelimit:identity:recovery-reset:lockout:${hmacRateLimitId(NAMED.canonical)}`,
        `ratelimit:identity:register:email:${hmacRateLimitId(NAMED.canonical)}`,
        `ratelimit:identity:resend-verify:email:${hmacRateLimitId(NAMED.canonical)}`,
        `ratelimit:identity:login:lockout:${hmacRateLimitId('user-named')}`,
        `ratelimit:identity:totp:lockout:${hmacRateLimitId('user-named')}`,
        `ratelimit:identity:step-up:lockout:${hmacRateLimitId('user-named')}`,
        `ratelimit:identity:delete-account:lockout:${hmacRateLimitId('user-named')}`,
        `ratelimit:identity:delete-account:init-lockout:${hmacRateLimitId('user-named')}`,
      ])
    );
  });

  it('names no counter key that carries the email it clears', async () => {
    const keys = await authResetKeys(NAMED, CALLER_IP_ID);

    expect(keys.filter((key) => key.includes('@'))).toEqual([]);
  });

  it('leaves every counter of an identity it was not asked about standing', async () => {
    // The property the glob could not have: a reset for one account is not a
    // reset for the environment. This is what makes the endpoint safe to call
    // from a worker while another worker counts.
    const mine = [
      ...(await authResetKeys(NAMED, CALLER_IP_ID)),
      `totp:used:${String(NAMED.userId)}:111111`,
    ];
    const theirs = [
      ...(await authResetKeys(UNNAMED, CALLER_IP_ID)),
      `totp:used:${String(UNNAMED.userId)}:222222`,
    ];
    const { redis, remaining } = stubKeyspaceRedis([...mine, ...theirs]);

    await resetAuthRateLimits(redis, CALLER_IP_ID, [NAMED]);

    expect(remaining()).toEqual(theirs.toSorted((left, right) => left.localeCompare(right)));
  });

  it('clears the per-network login window of the calling address and the named account', async () => {
    // The one counter here keyed on a digest rather than a value the request
    // carries: both of its parts ARE named by the request, so it is cleared by
    // deriving it rather than left to expire.
    const { redis, deleted } = stubSweepRedis();

    await resetAuthRateLimits(redis, CALLER_IP_ID, [NAMED]);

    expect(deleted).toEqual(
      expect.arrayContaining([
        await loginNetworkLockoutKey(NAMED.canonical, CALLER_IP_ID),
        await loginNetworkLockoutKey(String(NAMED.userId), CALLER_IP_ID),
      ])
    );
  });

  it('clears both per-network recovery windows of the calling address and the named account', async () => {
    const { redis, deleted } = stubSweepRedis();

    await resetAuthRateLimits(redis, CALLER_IP_ID, [NAMED]);

    expect(deleted).toEqual(
      expect.arrayContaining([...(await recoveryNetworkLockoutKeys(NAMED.canonical, CALLER_IP_ID))])
    );
  });

  it('leaves the same account’s window on another address standing', async () => {
    const mine = await loginNetworkLockoutKey(NAMED.canonical, CALLER_IP_ID);
    const theirs = await loginNetworkLockoutKey(NAMED.canonical, OTHER_IP_ID);
    const { redis, remaining } = stubKeyspaceRedis([mine, theirs]);

    await resetAuthRateLimits(redis, CALLER_IP_ID, [NAMED]);

    expect(remaining()).toEqual([theirs]);
  });

  it('sweeps one glob, the named account’s own TOTP replay markers', async () => {
    // Every other counter is named outright. The replay markers stay a glob
    // because the code is part of the key, but the account is not: the glob
    // cannot reach past the user it names.
    const { redis, matches } = stubSweepRedis();

    await resetAuthRateLimits(redis, CALLER_IP_ID, [NAMED]);

    expect(matches).toEqual([`totp:used:${String(NAMED.userId)}:*`]);
  });

  it('sweeps nothing at all when no account is named', async () => {
    const { redis, matches } = stubSweepRedis();

    await resetAuthRateLimits(redis, CALLER_IP_ID, []);

    expect(matches).toEqual([]);
  });

  it('reaches the throttles an identifier that names no account still carries', async () => {
    // Registration and resend key on an email address, which exists before any
    // account does — so an unresolved identifier is a legitimate subject, not
    // an error.
    const { redis, deleted } = stubSweepRedis();

    await resetAuthRateLimits(redis, CALLER_IP_ID, [
      { canonical: 'nobody@identity.test', userId: null },
    ]);

    expect(deleted).toEqual(
      expect.arrayContaining([
        `ratelimit:identity:register:email:${hmacRateLimitId('nobody@identity.test')}`,
        `ratelimit:identity:resend-verify:email:${hmacRateLimitId('nobody@identity.test')}`,
      ])
    );
    expect(deleted.filter((key) => key.includes(':totp:lockout:'))).toEqual([]);
  });

  it('deletes the caller’s per-IP windows and nothing else when given no account', async () => {
    const { redis, deleted } = stubSweepRedis();

    await resetAuthRateLimits(redis, CALLER_IP_ID, []);

    expect(deleted).toEqual(
      AUTH_IP_THROTTLES.map((throttle) => counterKey(throttle, CALLER_IP_ID))
    );
  });
});

describe('resetTrialUsage', () => {
  // The quota's window is a whole UTC day, so the key carries the day it counts
  // and no E2E run can wait one out — an uncleared bucket surfaces as an
  // unexplained 429 in a later spec.
  const FIXED_NOW = new Date(TEST_DAY_START + 5 * HOUR_MS + 6 * MINUTE_MS + 7 * SECOND_MS);

  beforeEach(() => {
    freezeClock(FIXED_NOW.getTime());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the daily quota counter belonging to the calling identity', async () => {
    const { redis, deleted } = stubSweepRedis();

    await resetTrialUsage(redis, CALLER_IP_ID);

    // Named through the counter's own derivation rather than respelled: the
    // identifier is composite (`<day>:<hash>`) and reaches the key only as its
    // keyed digest, and a second copy of that encoder is the duplication the
    // rate-limit module exists to remove. What this pins is the SCOPE — one key,
    // the caller's, for the day it counts.
    expect(deleted).toEqual([trialQuotaIpKey(FIXED_NOW, CALLER_IP_ID)._unsafeUnwrap()]);
    expect(deleted[0]).not.toBe(
      trialQuotaIpKey(new Date(FIXED_NOW.getTime() - DAY_MS), CALLER_IP_ID)._unsafeUnwrap()
    );
  });

  it('leaves every other identity’s daily quota counter alone', async () => {
    const { redis, matches } = stubSweepRedis();

    await resetTrialUsage(redis, CALLER_IP_ID);

    expect(matches.filter((match) => match.includes(':ip:'))).toEqual([]);
  });

  it('retains the global spend cap and the per-session quota counters', async () => {
    // Neither can be narrowed: the spend cap carries no IP component, and a
    // session's identity is a trial token this endpoint never receives.
    const { redis, matches } = stubSweepRedis();

    await resetTrialUsage(redis, CALLER_IP_ID);

    expect(matches).toEqual(
      expect.arrayContaining(['trial:*', 'ratelimit:chat:trial-quota:session:*'])
    );
  });
});

describe('resetUsageRateLimits', () => {
  it('clears the authenticated share-create per-caller rate-limit bucket', async () => {
    // The E2E `clearUsageRateLimits` helper claims share creation is reset, so
    // the key template registered in the conversations slice
    // (`ratelimit:conversations:share-create:user:${callerId}`) must be among the cleared
    // prefixes.
    const { redis, matches } = stubSweepRedis();

    await resetUsageRateLimits(redis, CALLER_IP_ID);

    expect(matches).toContain('ratelimit:conversations:share-create:user:*');
  });

  it('clears the authenticated batch member-keys per-account rate-limit bucket', async () => {
    // The most database-expensive authenticated read the conversations slice
    // answers, and one a client re-issues on every conversation-list refresh:
    // an E2E account that spends this window has no other way back under it,
    // because the counter never clears on success and its window outlives the
    // test that filled it. Derived from the limiter's own `buildKey` rather
    // than respelled, so a renamed template cannot leave this reset clearing a
    // bucket nothing writes.
    const { redis, matches } = stubSweepRedis();

    await resetUsageRateLimits(redis, CALLER_IP_ID);

    expect(matches).toContain(`${memberKeysBatchRateLimit.buildKey('')}*`);
  });

  it('clears the authenticated link-mint per-account rate-limit bucket', async () => {
    // The mint window is what bounds shared-link rows, so a suite that exercises
    // sharing spends it on one account and, like every throttle, gets no clear
    // on success. Derived from the limiter's own `buildKey` (see above).
    const { redis, matches } = stubSweepRedis();

    await resetUsageRateLimits(redis, CALLER_IP_ID);

    expect(matches).toContain(`${linkCreateRateLimit.buildKey('')}*`);
  });

  it('clears the five per-IP buckets belonging to the calling identity', async () => {
    const { redis, deleted } = stubSweepRedis();

    await resetUsageRateLimits(redis, CALLER_IP_ID);

    expect(deleted).toEqual(
      expect.arrayContaining(USAGE_IP_LIMITS.map((limit) => counterKey(limit, CALLER_IP_ID)))
    );
  });

  it('leaves another identity’s per-IP buckets standing', async () => {
    // The property, and the one to read a red by: a guest window this caller
    // never spent must survive its reset. "Nothing was cleared" is a different
    // failure — the caller's own five are asserted gone in the same breath.
    const mine = USAGE_IP_LIMITS.map((limit) => counterKey(limit, CALLER_IP_ID));
    const theirs = USAGE_IP_LIMITS.map((limit) => counterKey(limit, OTHER_IP_ID));
    const { redis, remaining } = stubKeyspaceRedis([...mine, ...theirs]);

    await resetUsageRateLimits(redis, CALLER_IP_ID);

    expect(remaining()).toEqual(theirs.toSorted((left, right) => left.localeCompare(right)));
  });

  it('clears the chat-stream, media and share-create buckets for every identity', async () => {
    const { redis, matches } = stubSweepRedis();

    await resetUsageRateLimits(redis, CALLER_IP_ID);

    expect(matches).toEqual(
      expect.arrayContaining([
        'ratelimit:chat:stream:user:*',
        'ratelimit:media:download:user:*',
        'ratelimit:media:share-presign:remint:*',
        'ratelimit:conversations:share-create:user:*',
      ])
    );
  });

  it('sweeps no per-IP prefix at all', async () => {
    const { redis, matches } = stubSweepRedis();

    await resetUsageRateLimits(redis, CALLER_IP_ID);

    expect(matches.filter((match) => match.includes(':ip:'))).toEqual([]);
  });
});

describe('resetAdminOpsRuns', () => {
  it('clears the operations window for every actor', async () => {
    // The key is a hashed Access actor, an identity no caller presents to the
    // reset endpoint, so this clears every actor's window or none.
    const actors = [
      rateLimitKey(adminOpsRateLimit, 'c'.repeat(64))._unsafeUnwrap(),
      rateLimitKey(adminOpsRateLimit, 'd'.repeat(64))._unsafeUnwrap(),
    ];
    const { redis, remaining } = stubKeyspaceRedis(actors);

    await resetAdminOpsRuns(redis);

    expect(remaining()).toEqual([]);
  });

  it('leaves every sibling admin window standing', async () => {
    // The over-reach direction, and the live hazard: a glob widened to
    // `ratelimit:admin:*` would clear these too, widening what a developer
    // can clear.
    const ops = rateLimitKey(adminOpsRateLimit, 'c'.repeat(64))._unsafeUnwrap();
    const siblings = [
      rateLimitKey(adminDashboardRateLimit, 'c'.repeat(64))._unsafeUnwrap(),
      rateLimitKey(adminJobQueueRateLimit, 'c'.repeat(64))._unsafeUnwrap(),
      rateLimitKey(adminCustomer360RateLimit, 'c'.repeat(64))._unsafeUnwrap(),
      rateLimitKey(adminAuditSearchRateLimit, 'c'.repeat(64))._unsafeUnwrap(),
      rateLimitKey(adminFeedbackRateLimit, 'c'.repeat(64))._unsafeUnwrap(),
      rateLimitKey(adminNewsletterSubscribersRateLimit, 'c'.repeat(64))._unsafeUnwrap(),
      rateLimitKey(adminSqlPanelRateLimit, 'c'.repeat(64))._unsafeUnwrap(),
    ];
    const { redis, remaining } = stubKeyspaceRedis([ops, ...siblings]);

    await resetAdminOpsRuns(redis);

    expect(remaining()).toEqual(siblings.toSorted((left, right) => left.localeCompare(right)));
  });

  it('sweeps one glob, built from the limiter’s own buildKey', async () => {
    const { redis, matches } = stubSweepRedis();

    await resetAdminOpsRuns(redis);

    expect(matches).toEqual([adminOpsRateLimit.buildKey('*')]);
  });
});
