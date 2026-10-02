import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  FINGERPRINT_BYTES,
  deriveTotpEncryptionKey,
  encryptTotpSecret,
  generateTotpSecret,
  totpKeyFingerprint,
} from '@hushbox/crypto';
import { DAY_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  SESSION_REVOKE_JOB_TYPE,
  createJobWakeCollector,
  grantJobWakes,
} from '../../lib/jobs/index.js';
import { createBillingStores } from '../../slices/billing/index.js';
import { createConversationsStores } from '../../slices/conversations/index.js';
import { createAdminOpDeps, createAdminOpPostDeps } from './admin-op-bindings.js';
import { bindRequestValue, requestScope } from '../../lib/context/index.js';
import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { EnqueueableJob } from '../../lib/jobs/index.js';
import type { AdminOperationsDeps, AdminOperationsPostDeps } from '../../slices/admin/index.js';
import type { Principal } from '../../lib/context/index.js';
import type { ConversationRoomNamespace } from '../../slices/conversations/index.js';
import type { EvictUserPort, IdentityUsersStore } from '../../slices/identity/index.js';

/** A DO namespace whose stub answers a fixed JSON body, notifying `onFetch` per call. */
function fakeRoomNamespace(onFetch: () => void = (): void => undefined): ConversationRoomNamespace {
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (): Promise<Response> => {
        onFetch();
        return Promise.resolve(Response.json({ closed: 3 }));
      },
    }),
  };
  return namespace as unknown as ConversationRoomNamespace;
}

/** The exact drizzle call chain `enqueueWithinTx` runs for a deduped insert. */
function fakeEnqueueTx(
  jobId: string
): Parameters<AdminOperationsDeps['newsletterDispatch']['enqueueWithinTx']>[0] {
  const chain = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([{ id: jobId, shard: 'bulk' }]),
        }),
      }),
    }),
  };
  // Granted, because the enqueue seam records the inserted row's shard on the
  // handle before it returns.
  return grantJobWakes(chain, createJobWakeCollector()) as unknown as Parameters<
    AdminOperationsDeps['newsletterDispatch']['enqueueWithinTx']
  >[0];
}

/** The composed env under test: `Bindings` plus the optional DO bindings the adapter consumes. */
type OpBindingsEnv = Partial<Bindings> & {
  CONVERSATION_ROOM?: ConversationRoomNamespace;
  API_URL?: string;
  MARKETING_URL?: string;
};

/** Low-entropy stand-in for the live TOTP encryption secret. */
const TOTP_ENCRYPTION_SECRET = 'totp-secret-for-op-binding-tests!'; // gitleaks:allow

const ENV_BASE = {
  UPSTASH_REDIS_REST_URL: 'https://redis.local',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  TOTP_ENCRYPTION_SECRET,
} satisfies OpBindingsEnv;

interface BuildResult {
  readonly deps: AdminOperationsDeps;
  readonly postDeps: AdminOperationsPostDeps;
  readonly redis: Redis;
  readonly evictCalls: readonly { readonly redis: Redis; readonly env: OpBindingsEnv }[];
  readonly probed?: { readonly ok: boolean; readonly value: unknown } | undefined;
}

interface BuildOptions {
  readonly principal?: Principal;
  /** The database handle the deps close over; the growth reads are the members that use it. */
  readonly db?: Database;
  /** Runs with both built halves INSIDE the request context (context-dependent
   * members — actorEmail, the lazy newsletter constructions — resolve there). */
  readonly inContext?: (deps: AdminOperationsDeps, postDeps: AdminOperationsPostDeps) => unknown;
}

/**
 * Runs both composition-root builders inside a request that has entered the
 * ambient request scope, the shape the composition root provides.
 */
async function buildDeps(env: OpBindingsEnv, options: BuildOptions = {}): Promise<BuildResult> {
  const redis = {} as Redis;
  const evictCalls: { redis: Redis; env: OpBindingsEnv }[] = [];
  const evictUser = (r: Redis, e: AppEnv['Bindings']): EvictUserPort => {
    evictCalls.push({ redis: r, env: e });
    return { evictUser: () => Promise.resolve() };
  };

  let captured: AdminOperationsDeps | undefined;
  let capturedPost: AdminOperationsPostDeps | undefined;
  let probed: { ok: boolean; value: unknown } | undefined;
  const app = new Hono<AppEnv>();
  app.use(requestScope());
  app.post('/build', async (c) => {
    bindRequestValue(c, 'redis', redis);
    if (options.principal !== undefined) bindRequestValue(c, 'principal', options.principal);
    captured = createAdminOpDeps(options.db ?? ({} as Database), createBillingStores());
    capturedPost = createAdminOpPostDeps(evictUser);
    if (options.inContext !== undefined) {
      try {
        probed = { ok: true, value: await options.inContext(captured, capturedPost) };
        // eslint-disable-next-line catch-swallow/no-silent-catch -- the throw IS the probe's result: it is recorded as the failed arm and asserted on by the caller
      } catch (error) {
        probed = { ok: false, value: error };
      }
    }
    return c.json({ ok: true });
  });
  await app.request('/build', { method: 'POST' }, env as Bindings);

  if (captured === undefined || capturedPost === undefined) {
    throw new Error('deps were not built');
  }
  return { deps: captured, postDeps: capturedPost, redis, evictCalls, probed };
}

describe('createAdminOpDeps', () => {
  it('resolves the production dep set from the request context', async () => {
    const { deps } = await buildDeps({
      ...ENV_BASE,
      CONVERSATION_ROOM: fakeRoomNamespace(),
    });

    expect(deps.bannerConfig).toBeDefined();
    expect(deps.billingStores).toBeDefined();
    expect(deps.identityStores).toBeDefined();
    expect(deps.twoFactorStores).toBeDefined();
    expect(deps.currentTotpKeyFingerprint()).toEqual(
      totpKeyFingerprint(deriveTotpEncryptionKey(new TextEncoder().encode(TOTP_ENCRYPTION_SECRET)))
    );
    expect(deps.jobRegistry).toBeDefined();
    expect(deps.conversationsStores).toBe(createConversationsStores);
    expect(deps.clock.now()).toBeInstanceOf(Date);
  });

  it('binds a job registry with no runner on it to reach', async () => {
    const { deps } = await buildDeps({
      ...ENV_BASE,
      CONVERSATION_ROOM: fakeRoomNamespace(),
    });

    // The cast an op body would write to escape the narrow type, against the
    // dep object the composition root really hands the engine. It has to find
    // nothing: `session.revoke.v1`'s runner bumps the Redis
    // password-changed watermark, an effect outside the transaction that a
    // preview's rollback cannot recall. Bind the executable registry here in
    // place of `enqueueOnlyRegistry` and this reads back a function.
    const escaped = deps.jobRegistry.get(SESSION_REVOKE_JOB_TYPE) as unknown as
      | (EnqueueableJob & { readonly run?: unknown })
      | undefined;

    expect(escaped?.run).toBeUndefined();
    // The other half, asserted here because the line above alone is satisfied
    // by a binding that resolves nothing at all: every field
    // `enqueueWithinTx` reads must still arrive, or the in-transaction
    // session-revoke enqueue throws instead of writing its row.
    expect(new Set(Object.keys(escaped ?? {}))).toEqual(
      new Set([
        'idempotency',
        'maxClaims',
        'maxExecutionSeconds',
        'maxFailures',
        'schema',
        'shard',
        'type',
      ])
    );
  });

  it('binds an identity surface with no base-database mutator on it to reach', async () => {
    const { deps } = await buildDeps({
      ...ENV_BASE,
      CONVERSATION_ROOM: fakeRoomNamespace(),
    });

    // The cast an op body would write to escape the narrow type, against the
    // dep object the composition root really hands the engine. It has to find
    // nothing: `rotatePassword` and the TOTP transitions write on the base
    // database rather than the engine's settlement transaction, so a preview's
    // rollback cannot undo them. Bind `createIdentityStores(db)` here in place
    // of the narrowed surface and these read back functions.
    const escaped = deps.identityStores.users as unknown as Partial<IdentityUsersStore>;

    expect(escaped.rotatePassword).toBeUndefined();
    expect(escaped.enableTotp).toBeUndefined();
    expect(escaped.disableTotp).toBeUndefined();
    // The other half, asserted here because the lines above alone are satisfied
    // by a binding that resolves nothing at all: every containment write the
    // shipped ops compose must still arrive, or user.lock / user.unlock /
    // sessions.revokeAll throw instead of writing their rows.
    expect(new Set(Object.keys(escaped))).toEqual(
      new Set(['lockForDeletionWithinTx', 'lockUserWithinTx', 'unlockUserWithinTx'])
    );
    // The verification store is not a containment write at all, so no op body
    // holds one: the surface carries `users` and nothing else.
    expect(new Set(Object.keys(deps.identityStores))).toEqual(new Set(['users']));
  });

  it('binds a two-factor surface with no base-database TOTP transition on it to reach', async () => {
    const { deps } = await buildDeps({
      ...ENV_BASE,
      CONVERSATION_ROOM: fakeRoomNamespace(),
    });

    // The cast an op body would write to escape the narrow type. `enableTotp`
    // and `disableTotp` write on the base database rather than the engine's
    // settlement transaction, so a preview's rollback cannot undo them — and
    // `disableTotp` also nulls the ciphertext the clear ops must retain.
    const escaped = deps.twoFactorStores.users as unknown as Partial<IdentityUsersStore>;

    expect(escaped.enableTotp).toBeUndefined();
    expect(escaped.disableTotp).toBeUndefined();
    expect(new Set(Object.keys(escaped))).toEqual(
      new Set([
        'clearTotpWithinTx',
        'disableStrandedTotpWithinTx',
        'restoreStrandedTotpWithinTx',
        'restoreTotpWithinTx',
      ])
    );
    expect(new Set(Object.keys(deps.twoFactorStores))).toEqual(new Set(['users']));
  });

  it('measures stranded rows against the key id a stored secret actually carries', async () => {
    const { probed } = await buildDeps(
      { ...ENV_BASE, CONVERSATION_ROOM: fakeRoomNamespace() },
      { inContext: (deps) => deps.currentTotpKeyFingerprint() }
    );

    // The op sweeps every row whose stored key id is not this one, so the
    // value must be the key id `encryptTotpSecret` writes into a blob sealed
    // under the same environment secret — asserted against a real blob rather
    // than by restating the derivation, because a derivation restated on both
    // sides of an assertion pins nothing.
    const sealed = encryptTotpSecret(
      deriveTotpEncryptionKey(new TextEncoder().encode(TOTP_ENCRYPTION_SECRET)),
      crypto.randomUUID(),
      generateTotpSecret()
    );
    expect(probed?.ok).toBe(true);
    expect(probed?.value).toEqual(sealed.subarray(0, FINGERPRINT_BYTES));
  });

  it('derives the live key id lazily, so an unset secret fails only when asked', async () => {
    const { deps, probed } = await buildDeps(
      {
        UPSTASH_REDIS_REST_URL: ENV_BASE.UPSTASH_REDIS_REST_URL,
        UPSTASH_REDIS_REST_TOKEN: ENV_BASE.UPSTASH_REDIS_REST_TOKEN,
        CONVERSATION_ROOM: fakeRoomNamespace(),
      },
      { inContext: (built) => built.currentTotpKeyFingerprint() }
    );

    // Building the deps must not throw: they are built for EVERY admin op, so
    // an eager derivation would fail wallet, model and job ops in an
    // environment that configures no TOTP secret.
    expect(deps.twoFactorStores).toBeDefined();
    expect(probed?.ok).toBe(false);
  });

  it('memoizes the derived key id across calls', async () => {
    const { probed } = await buildDeps(
      { ...ENV_BASE, CONVERSATION_ROOM: fakeRoomNamespace() },
      {
        inContext: (deps) => {
          const first = deps.currentTotpKeyFingerprint();
          const second = deps.currentTotpKeyFingerprint();
          return first === second;
        },
      }
    );

    expect(probed?.value).toBe(true);
  });

  it('resolves actorEmail from the admin-actor principal at call time', async () => {
    const { probed } = await buildDeps(
      { ...ENV_BASE, CONVERSATION_ROOM: fakeRoomNamespace() },
      {
        principal: {
          kind: 'admin-actor',
          email: 'ops@hushbox.ai',
          audience: 'aud',
          role: 'operator',
        },
        inContext: (deps) => deps.actorEmail(),
      }
    );
    expect(probed).toEqual({ ok: true, value: 'ops@hushbox.ai' });
  });

  it('refuses actorEmail for a non-admin principal (pipeline defect, thrown)', async () => {
    const { probed } = await buildDeps(
      { ...ENV_BASE, CONVERSATION_ROOM: fakeRoomNamespace() },
      {
        principal: { kind: 'trial-session', sessionId: 'trial-1' },
        inContext: (deps) => deps.actorEmail(),
      }
    );
    expect(probed?.ok).toBe(false);
    expect(String(probed?.value)).toMatch(/admin-actor/);
  });

  it('reads a newsletter issue row within the caller transaction', async () => {
    const row = { id: 'issue-1', subject: 's' };
    const tx = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
    } as unknown as Parameters<AdminOperationsDeps['newsletterIssueReader']['readWithinTx']>[0];
    const emptyTx = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    } as unknown as typeof tx;
    const { deps } = await buildDeps({ ...ENV_BASE, CONVERSATION_ROOM: fakeRoomNamespace() });

    expect(await deps.newsletterIssueReader.readWithinTx(tx, 'issue-1')).toBe(row);
    expect(await deps.newsletterIssueReader.readWithinTx(emptyTx, 'issue-2')).toBeNull();
  });

  it('binds every growth read to the request database handle', async () => {
    const rows = [{ bucket: new Date(0) }];
    const chain: Record<string, unknown> = {};
    chain['from'] = () => chain;
    chain['where'] = () => chain;
    chain['orderBy'] = () => Promise.resolve(rows);
    const growthDb = { select: () => chain } as unknown as Database;
    const { deps } = await buildDeps(
      { ...ENV_BASE, CONVERSATION_ROOM: fakeRoomNamespace() },
      { db: growthDb }
    );
    const window = { from: new Date(0), to: new Date(1) };

    const marketing = await deps.growthReads.marketing({ ...window, grain: 'day' });
    const funnel = await deps.growthReads.funnelWeeks(window);
    const sources = await deps.growthReads.acquisitionSources(window);
    const campaignRows = await deps.growthReads.campaigns();
    const events = await deps.growthReads.hourlyEvents(window);

    expect(marketing._unsafeUnwrap()).toBe(rows);
    expect(funnel._unsafeUnwrap()).toBe(rows);
    expect(sources._unsafeUnwrap()).toBe(rows);
    expect(campaignRows._unsafeUnwrap()).toBe(rows);
    expect(events._unsafeUnwrap()).toBe(rows);
  });

  it('binds the newest-bucket read to the request database handle', async () => {
    const at = new Date(0);
    const chain: Record<string, unknown> = {};
    chain['from'] = () => chain;
    chain['orderBy'] = () => chain;
    chain['limit'] = () => Promise.resolve([{ at }]);
    const growthDb = { select: () => chain } as unknown as Database;
    const { deps } = await buildDeps(
      { ...ENV_BASE, CONVERSATION_ROOM: fakeRoomNamespace() },
      { db: growthDb }
    );

    const newest = await deps.growthReads.newestBuckets();

    expect(newest._unsafeUnwrap()).toEqual({
      funnel: { grain: 'week', weekOpening: at },
      sources: { grain: 'week', weekOpening: at },
      marketing: { grain: 'day', runsThrough: at },
      events: { grain: 'day', runsThrough: at },
    });
  });

  it('reads a campaign row within the caller transaction, holding its lock', async () => {
    const row = { tag: 'launch-2026', label: 'Launch', status: 'active', createdAt: new Date(0) };
    const txWith = (
      rows: unknown[]
    ): Parameters<AdminOperationsDeps['growthCampaigns']['readWithinTx']>[0] =>
      ({
        select: () => ({
          from: () => ({ where: () => ({ for: () => Promise.resolve(rows) }) }),
        }),
      }) as unknown as Parameters<AdminOperationsDeps['growthCampaigns']['readWithinTx']>[0];
    const { deps } = await buildDeps({ ...ENV_BASE, CONVERSATION_ROOM: fakeRoomNamespace() });

    expect(await deps.growthCampaigns.readWithinTx(txWith([row]), 'launch-2026')).toBe(row);
    expect(await deps.growthCampaigns.readWithinTx(txWith([]), 'absent')).toBeNull();
  });

  it('mints and retires campaigns through the growth slice’s published doors', async () => {
    const { deps } = await buildDeps({ ...ENV_BASE, CONVERSATION_ROOM: fakeRoomNamespace() });
    const tx = {} as Parameters<AdminOperationsDeps['growthCampaigns']['createWithinTx']>[0];

    // Both doors refuse before they touch the transaction, which is what lets
    // this assert the wiring without one: an illegal tag, and a seeded tag no
    // operation may retire.
    const minted = await deps.growthCampaigns.createWithinTx(tx, {
      tag: 'Not A Tag',
      label: 'Launch',
    });
    const retired = await deps.growthCampaigns.archiveWithinTx(tx, 'unknown');

    expect(minted._unsafeUnwrapErr().code).toBe('validation');
    expect(retired._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails fast on a dispatch enqueue when the issue email urls are unconfigured', async () => {
    const { probed } = await buildDeps(
      { ...ENV_BASE, NODE_ENV: 'development', CONVERSATION_ROOM: fakeRoomNamespace() },
      {
        inContext: (deps) =>
          deps.newsletterDispatch.enqueueWithinTx(fakeEnqueueTx('job-1'), {
            issueId: crypto.randomUUID(),
            scheduledAt: new Date(TEST_DAY_START + 365_000 * DAY_MS),
          }),
      }
    );
    expect(probed?.ok).toBe(false);
    expect(String(probed?.value)).toMatch(/API_URL\/MARKETING_URL/);
  });

  it('enqueues the dispatch job through the lazily built registration', async () => {
    const { probed } = await buildDeps(
      {
        ...ENV_BASE,
        NODE_ENV: 'development',
        API_URL: 'http://api.test.local',
        MARKETING_URL: 'http://marketing.test.local',
        CONVERSATION_ROOM: fakeRoomNamespace(),
      },
      {
        inContext: (deps) =>
          deps.newsletterDispatch.enqueueWithinTx(fakeEnqueueTx('job-9'), {
            issueId: crypto.randomUUID(),
            scheduledAt: new Date(TEST_DAY_START + 365_000 * DAY_MS),
          }),
      }
    );
    expect(probed).toEqual({ ok: true, value: { enqueued: true, jobId: 'job-9' } });
  });
});

describe('createAdminOpPostDeps', () => {
  it('resolves the production post-commit set from the request context', async () => {
    const { postDeps, redis, evictCalls } = await buildDeps({
      ...ENV_BASE,
      CONVERSATION_ROOM: fakeRoomNamespace(),
    });

    expect(postDeps.redis).toBe(redis);
    expect(postDeps.membershipRevoker).toBeDefined();
    expect(postDeps.realtime).toBeDefined();
    expect(evictCalls).toHaveLength(1);
    expect(evictCalls[0]?.redis).toBe(redis);
    expect(evictCalls[0]?.env.CONVERSATION_ROOM).toBeDefined();
  });

  it('sends the newsletter test email through the env-selected sender', async () => {
    const { probed } = await buildDeps(
      {
        ...ENV_BASE,
        NODE_ENV: 'development',
        CONVERSATION_ROOM: fakeRoomNamespace(),
        API_URL: 'https://api.hushbox.ai',
        MARKETING_URL: 'https://hushbox.ai',
      },
      {
        inContext: async (_deps, postDeps) => {
          const sent = await postDeps.newsletterTestEmail.send({
            subject: 'preview',
            bodyMarkdown: '# body',
            to: 'ops@hushbox.ai',
          });
          return sent.isOk();
        },
      }
    );
    expect(probed).toEqual({ ok: true, value: true });
  });

  it('lazily constructs the realtime broadcast and memoizes it across calls', async () => {
    const { postDeps } = await buildDeps({ ...ENV_BASE, CONVERSATION_ROOM: fakeRoomNamespace() });
    const first = await postDeps.realtime.evict('conversation-1', 'principal-1');
    const second = await postDeps.realtime.evict('conversation-2', 'principal-2');
    expect(first.isOk() && first.value).toBe(3);
    expect(second.isOk() && second.value).toBe(3);
  });

  it('proxies every realtime method through the resolved broadcast', async () => {
    let roomFetches = 0;
    const { postDeps } = await buildDeps({
      ...ENV_BASE,
      CONVERSATION_ROOM: fakeRoomNamespace(() => {
        roomFetches += 1;
      }),
    });
    const headers = new Headers();
    const calls = [
      postDeps.realtime.broadcast('c', { type: 'presence', conversationId: 'c' } as never),
      postDeps.realtime.evict('c', 'p'),
      postDeps.realtime.presence('c'),
      postDeps.realtime.startRun('c', {} as never),
      postDeps.realtime.stopRun('c', { kind: 'user', userId: 'p' }),
      postDeps.realtime.upgrade('c', { principalId: 'p', isGuest: false } as never, headers, null),
    ];
    await Promise.all(calls);
    // A method the proxy failed to forward would never reach the stub's fetch,
    // whatever it returned to the caller.
    expect(roomFetches).toBe(calls.length);
  });

  it('is its own object, sharing no name with ctx.deps', async () => {
    const { deps, postDeps } = await buildDeps({
      ...ENV_BASE,
      CONVERSATION_ROOM: fakeRoomNamespace(),
    });

    // The rollback guarantee is runtime disjointness, not only the types: an op
    // body that casts `ctx.deps` to the post-commit half must reach `undefined`
    // rather than a live capability. Two separately built literals give that;
    // one object handed out twice would not.
    expect(deps).not.toBe(postDeps);
    // Asserted as an empty set rather than an upper bound: every post-commit
    // capability has left the transaction-scoped half, so any name reappearing
    // on both is a regression rather than a carve-out to widen.
    const shared = Object.keys(postDeps).filter((key) => key in deps);
    expect(shared).toEqual([]);
  });
});
