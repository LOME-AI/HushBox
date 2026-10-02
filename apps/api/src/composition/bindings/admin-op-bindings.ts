import { eq } from 'drizzle-orm';
import { deriveTotpEncryptionKey, totpKeyFingerprint } from '@hushbox/crypto';
import { campaigns, newsletterIssues } from '@hushbox/db';
import {
  createAppJobRegistry,
  enqueueOnlyDeps,
  enqueueOnlyRegistry,
} from '../../lib/jobs/index.js';
import { createAnnouncementsStores } from '../../slices/announcements/index.js';
import {
  createConversationRoomRealtime,
  createConversationsStores,
  createMembershipRevoker,
} from '../../slices/conversations/index.js';
import { createGrowthReads } from '../../slices/growth/index.js';
import {
  archiveCampaignWithinTx,
  createCampaignWithinTx,
} from '../../slices/growth/public/campaigns.js';
import { createIdentityStores } from '../../slices/identity/index.js';
import {
  createNewsletterDispatchJobRegistration,
  createNewsletterDispatchStores,
  enqueueIssueDispatch,
  sendIssueTest,
} from '../../slices/newsletter/index.js';
import { createEmailSenderFromEnv } from '../../slices/notifications/index.js';
import { createSessionRevokeEnqueueRegistration } from './billing-bindings.js';
import { requestEnv, requestPrincipal, requestRedis } from '../../lib/context/index.js';
import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { AppEnv } from '../../lib/context/index.js';
import type { JobRegistry } from '../../lib/jobs/index.js';
import type { AdminOperationsDeps, AdminOperationsPostDeps } from '../../slices/admin/index.js';
import type { BillingStores } from '../../slices/billing/index.js';
import type { ConversationRoomEnv, RealtimeBroadcast } from '../../slices/conversations/index.js';
import type { EvictUserPort } from '../../slices/identity/index.js';
import type { IssueEmailUrls, NewsletterIssueRow } from '../../slices/newsletter/index.js';
import type { BatchEmailSender } from '../../slices/notifications/index.js';
import type { EnvContext } from '@hushbox/shared';

/**
 * `createConversationRoomRealtime` fail-fasts at CONSTRUCTION on a missing
 * CONVERSATION_ROOM binding, but admin op deps are built per engine — eager
 * construction would 500 every op (wallet, model, …) in environments without
 * the DO. The share ops touch realtime only inside their post-commit
 * best-effort eviction, so resolution defers to first use: a missing binding
 * surfaces as a captured ephemeral-effect failure in telemetry, while the
 * fail-closed broadcast-time membership recheck remains the guarantee.
 */
function lazyConversationRealtime(env: ConversationRoomEnv): RealtimeBroadcast {
  let instance: RealtimeBroadcast | undefined;
  const resolved = (): RealtimeBroadcast => (instance ??= createConversationRoomRealtime(env));
  return {
    broadcast: (...args) => resolved().broadcast(...args),
    evict: (...args) => resolved().evict(...args),
    presence: (...args) => resolved().presence(...args),
    startRun: (...args) => resolved().startRun(...args),
    stopRun: (...args) => resolved().stopRun(...args),
    upgrade: (...args) => resolved().upgrade(...args),
  };
}

/** Memoized lazy construction: heavier deps (email sender, dispatch
 * registration) are consumed only by the newsletter ops, so building them
 * eagerly would fail-fast every unrelated op in environments without email
 * config — the `lazyConversationRealtime` precedent. */
function once<T>(build: () => T): () => T {
  let instance: T | undefined;
  return (): T => (instance ??= build());
}

/** The env slice the newsletter test-send and dispatch enqueue link against. */
interface NewsletterOpsEnv extends EnvContext {
  readonly API_URL?: string;
  readonly MARKETING_URL?: string;
}

function requireNewsletterOpsUrls(env: NewsletterOpsEnv): IssueEmailUrls {
  const apiUrl = env.API_URL;
  const marketingUrl = env.MARKETING_URL;
  if (apiUrl === undefined || apiUrl === '' || marketingUrl === undefined || marketingUrl === '') {
    throw new Error(
      'admin newsletter ops: API_URL/MARKETING_URL must be configured for issue emails'
    );
  }
  return { apiUrl, marketingUrl };
}

/**
 * The acting admin's allowlisted Access email, resolved lazily from the
 * request's `admin-actor` principal (the Single Auth Path identity). Lazy on
 * purpose: deps are constructed for every engine, but only the newsletter
 * ops read the actor, and a non-admin construction site must not throw.
 * A missing/other-kind principal here is a pipeline defect — newsletter ops
 * run only on `admin`-classed routes.
 */
function actingAdminEmail(): string {
  const principal = requestPrincipal();
  if (principal.kind !== 'admin-actor') {
    throw new Error('admin newsletter ops: request context has no admin-actor principal');
  }
  return principal.email;
}

/**
 * The identity surface an admin op body holds, rebuilt field by field from the
 * published stores so everything identity offers beyond these
 * within-transaction writes is absent from the value rather than merely hidden
 * by the type. What is withheld are the members bound to the base `Database`
 * handle rather than to a caller's transaction — password rotation and the
 * TOTP transitions among them: a body calling one from inside a preview would
 * perform a write the rollback cannot undo, since it never entered the
 * transaction the rollback discards.
 *
 * Field by field rather than a subset spread: a write added to the narrowed
 * surface then fails to compile here rather than silently riding along, and no
 * spread can carry a withheld member back in. Each member is bound to the store
 * it came off, so the surface stays correct if identity ever implements these
 * as something other than closures over `db`.
 */
function adminIdentityStores(db: Database): AdminOperationsDeps['identityStores'] {
  const { users } = createIdentityStores(db);
  return {
    users: {
      lockForDeletionWithinTx: users.lockForDeletionWithinTx.bind(users),
      lockUserWithinTx: users.lockUserWithinTx.bind(users),
      unlockUserWithinTx: users.unlockUserWithinTx.bind(users),
    },
  };
}

/**
 * The identity surface the two-factor ops hold: the four transaction-scoped
 * doors that clear and restore a stranded second factor. Its own object, and
 * its own dependency key, so nothing in it widens what the user ops reach —
 * and, as there, withheld are the members bound to the base `Database`:
 * `enableTotp` and `disableTotp` write outside the engine's settlement
 * transaction, so a preview's rollback could not undo them, and `disableTotp`
 * also nulls the ciphertext the clear ops must retain to stay reversible.
 */
function adminTwoFactorStores(db: Database): AdminOperationsDeps['twoFactorStores'] {
  const { users } = createIdentityStores(db);
  return {
    users: {
      clearTotpWithinTx: users.clearTotpWithinTx.bind(users),
      disableStrandedTotpWithinTx: users.disableStrandedTotpWithinTx.bind(users),
      restoreStrandedTotpWithinTx: users.restoreStrandedTotpWithinTx.bind(users),
      restoreTotpWithinTx: users.restoreTotpWithinTx.bind(users),
    },
  };
}

/** The env slice the live TOTP key id is derived from. */
interface TotpSecretEnv {
  readonly TOTP_ENCRYPTION_SECRET?: string;
}

/**
 * The key id every stored TOTP secret carries when it was sealed under the
 * live key — the value `twoFactor.clearStranded` measures a row's staleness
 * against, so a wrong one would sweep every second factor in the database.
 * Derived through the same crypto the sealing uses, from the same environment
 * secret, and resolved lazily: these deps are built for EVERY admin op, so an
 * eager derivation would fail unrelated ops wherever no TOTP secret is
 * configured (the `lazyConversationRealtime` precedent).
 */
function liveTotpKeyFingerprint(env: TotpSecretEnv): () => Uint8Array {
  return once((): Uint8Array => {
    const secret = env.TOTP_ENCRYPTION_SECRET;
    if (secret === undefined || secret === '') {
      throw new Error('admin two-factor ops: TOTP_ENCRYPTION_SECRET must be configured');
    }
    return totpKeyFingerprint(deriveTotpEncryptionKey(new TextEncoder().encode(secret)));
  });
}

/**
 * The growth surface an admin op body holds: the slice's published
 * within-transaction campaign writes, and its reads bound to this request's
 * database handle so a read body takes no handle of its own.
 *
 * `readWithinTx` is a composition-root within-tx READ of the growth slice's
 * table — the `newsletterIssueReader` precedent; single-writer governs writes,
 * and scoped cross-slice reads live app-level. It locks the row it returns,
 * because the campaign ops decide what to do from the status it reports and
 * two operators acting on one tag must not both read `active`.
 */
function adminGrowthDeps(
  db: Database
): Pick<AdminOperationsDeps, 'growthCampaigns' | 'growthReads'> {
  const reads = createGrowthReads();
  return {
    growthCampaigns: {
      readWithinTx: async (tx, tag) => {
        const rows = await tx
          .select({
            tag: campaigns.tag,
            label: campaigns.label,
            status: campaigns.status,
            createdAt: campaigns.createdAt,
          })
          .from(campaigns)
          .where(eq(campaigns.tag, tag))
          .for('update');
        return rows[0] ?? null;
      },
      createWithinTx: (tx, campaign) => createCampaignWithinTx(tx, campaign),
      archiveWithinTx: (tx, tag) => archiveCampaignWithinTx(tx, tag),
    },
    growthReads: {
      marketing: (args) => reads.readMarketing(db, args),
      funnelWeeks: (args) => reads.readFunnelWeeks(db, args),
      acquisitionSources: (args) => reads.readAcquisitionSources(db, args),
      campaigns: () => reads.readCampaigns(db),
      hourlyEvents: (args) => reads.readHourlyEvents(db, args),
      pathReach: (args) => reads.readPathReach(db, args),
      newestBuckets: () => reads.readNewestBuckets(db),
    },
  };
}

/**
 * The production dep set for the registered admin ops, resolved per
 * engine construction from the request context (AsyncLocalStorage-backed —
 * the same seam the composition root's other static bindings use). The
 * billing stores instance arrives as a parameter: billing must stay the ONE
 * shared published surface app-wide.
 */
export function createAdminOpDeps(db: Database, billingStores: BillingStores): AdminOperationsDeps {
  const env = requestEnv();
  const emailSender = once((): BatchEmailSender => createEmailSenderFromEnv(env));
  // Enqueue-only registry for the dispatch job (the handler runs in the
  // dispatcher DO with its own registry); enqueueWithinTx consumes only the
  // registration's schema and lease metadata. The send deps are resolved here
  // rather than deferred into the handler: nothing on this path ever invokes
  // the resolver, so deferring would let an admin schedule a dispatch under
  // unconfigured issue urls and get a row that cannot succeed.
  const newsletterDispatchRegistry = once(
    (): JobRegistry =>
      createAppJobRegistry([
        createNewsletterDispatchJobRegistration({
          store: createNewsletterDispatchStores(db),
          resolveSend: enqueueOnlyDeps({
            sender: emailSender(),
            urls: requireNewsletterOpsUrls(env),
          }),
        }),
      ])
  );
  return {
    ...adminGrowthDeps(db),
    // The config store only (banner.set's within-tx surface); the dismissal
    // store stays private to the announcements routes.
    bannerConfig: createAnnouncementsStores(db).config,
    billingStores,
    identityStores: adminIdentityStores(db),
    twoFactorStores: adminTwoFactorStores(db),
    currentTotpKeyFingerprint: liveTotpKeyFingerprint(env),
    // Enqueue-only registry: user.lock / sessions.revokeAll enqueue
    // `session.revoke.v1` inside the settlement transaction; the handler runs
    // in the dispatcher DO with its own registry. The handler-free view is
    // what an op body holds, so the narrow type is backed by a value that has
    // no handler to reach.
    jobRegistry: enqueueOnlyRegistry(
      createAppJobRegistry([createSessionRevokeEnqueueRegistration(env)])
    ),
    clock: { now: (): Date => new Date() },
    conversationsStores: createConversationsStores,
    actorEmail: actingAdminEmail,
    newsletterDispatch: {
      enqueueWithinTx: (tx, params) =>
        enqueueIssueDispatch(tx, newsletterDispatchRegistry(), params),
    },
    newsletterIssueReader: {
      // Composition-root within-tx READ of the newsletter slice's table
      // (single-writer governs writes; scoped cross-slice reads live
      // app-level — the admin-read-bindings precedent). Within-tx because the
      // request's database is serial and refuses a base-db read inside the
      // open settlement transaction at once.
      readWithinTx: async (tx, issueId): Promise<NewsletterIssueRow | null> => {
        const rows = await tx
          .select()
          .from(newsletterIssues)
          .where(eq(newsletterIssues.id, issueId));
        return rows[0] ?? null;
      },
    },
  };
}

/**
 * The production post-commit capability set, built as its own literal from its
 * own resolution of the request context. Disjointness from
 * {@link createAdminOpDeps} is load-bearing, not a style preference: the two
 * objects share no key, so an op body that casts its transaction-scoped deps
 * to this type reads `undefined` rather than a live capability. The colocated
 * test asserts that empty intersection. Never derive one object from the
 * other — a spread would put these names back within a body's reach.
 */
export function createAdminOpPostDeps(
  evictUser: (redis: Redis, env: AppEnv['Bindings']) => EvictUserPort
): AdminOperationsPostDeps {
  const env = requestEnv();
  const redis = requestRedis();
  const emailSender = once((): BatchEmailSender => createEmailSenderFromEnv(env));
  return {
    redis,
    evictUser: evictUser(redis, env),
    membershipRevoker: createMembershipRevoker(redis),
    realtime: lazyConversationRealtime(env),
    newsletterTestEmail: {
      send: (params) =>
        sendIssueTest({
          sender: emailSender(),
          ...params,
          marketingUrl: requireNewsletterOpsUrls(env).marketingUrl,
          sentAt: new Date(),
        }),
    },
  };
}
