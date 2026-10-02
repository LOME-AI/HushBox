import { Hono } from 'hono';
import { getPath } from 'hono/utils/url';
import { ERROR_CODES, LINEAR_TEAM_KEY } from '@hushbox/shared';
import { trialRoomName } from '@hushbox/realtime/protocol';
import { applyPipeline } from './middleware/pipeline.js';
import { edgeRing } from './middleware/edge-ring.js';
import { defineSliceManifest, routeClass } from './middleware/pipeline-manifest.js';
import { readPipelineVariable } from './middleware/pipeline-markers.js';
import { createErrorResponse } from './lib/errors/index.js';
import { createConsoleTelemetry } from './lib/telemetry/index.js';
import { createAccountManifest, createAccountStores } from './slices/account/index.js';
import {
  adminOperations,
  createAdminAuditReads,
  createAdminManifest,
  createAdminOpEngine,
  createAdminOpRegistry,
  createAdminReadSurface,
  createAdminStores,
  createSqlPanel,
} from './slices/admin/index.js';
import {
  createAnnouncementsManifest,
  createAnnouncementsStores,
} from './slices/announcements/index.js';
import {
  checkBillingPortalRevocation,
  checkSessionRevocation,
  createIdentityManifest,
  createIdentityStores,
} from './slices/identity/index.js';
import {
  LINK_CREDENTIAL_HEADER,
  createConversationRoomRealtime,
  createConversationsManifest,
  createConversationsStores,
  createMembershipRevoker,
} from './slices/conversations/index.js';
import {
  captureContentStorageKeysWithinTx,
  createChatManifest,
  createForkMessageDeleter,
  deleteForeignMessageContentWithinTx,
  detachMessageSendersWithinTx,
} from './slices/chat/index.js';
import {
  MEDIA_RECLAIM_USER_JOB_TYPE,
  createMediaManifest,
  createMediaReclaimUserJob,
  createR2StorageFromEnv,
} from './slices/media/index.js';
import {
  createBillingManifest,
  createBillingStores,
  createPaymentProviderFromEnv,
  createPaymentVerifyJobRegistration,
  createPublicStatsStores,
  readBalance,
  readUsageBreakdown,
} from './slices/billing/index.js';
import { createFeedbackManifest, createFeedbackStores } from './slices/feedback/index.js';
import {
  bundledGrowthEventIndex,
  createGrowthManifest,
  createGrowthStores,
} from './slices/growth/index.js';
import { createModelsManifest } from './slices/models/index.js';
import { createModelWeightsManifest } from './slices/model-weights/index.js';
import {
  createNewsletterManifest,
  createNewsletterStores,
  createResendWebhookVerifier,
} from './slices/newsletter/index.js';
import {
  createDeviceTokenStore,
  createNotificationPreferencesStore,
  createNotificationsManifest,
} from './slices/notifications/index.js';
import { createAppJobRegistry, enqueueOnlyDeps, enqueueWithinTx } from './lib/jobs/index.js';
import { createRoadmapManifest, getLinearClient } from './slices/roadmap/index.js';
import { createStatsManifest } from './slices/stats/index.js';
import { createUpdatesManifest } from './slices/updates/index.js';
import { createDevManifest } from './dev/routes.js';
import { createAppAccountDeletedEmailPort } from './composition/email/account-deleted-email.js';
import { createAppPasswordChangedEmailPort } from './composition/email/password-changed-email.js';
import { createAppPasswordResetEmailPort } from './composition/email/password-reset-email.js';
import { createAppVerificationEmailPort } from './composition/email/verification-email.js';
import {
  createAppNewsletterConfirmEmailPort,
  requestMarketingUrl,
} from './composition/email/newsletter-confirmation-email.js';
import { createEvictUserPort } from './composition/bindings/evict-user-port.js';
import {
  createChatMessagePushNotify,
  createMembershipPushNotify,
} from './composition/push-notify.js';
import { createAppChargebackLockEmailPort } from './composition/email/chargeback-lock-email.js';
import { createAdminCrossSliceReads } from './composition/bindings/admin-read-bindings.js';
import {
  createAdminOpDeps,
  createAdminOpPostDeps,
} from './composition/bindings/admin-op-bindings.js';
import { createAppWelcomeEmailPort } from './composition/email/welcome-email.js';
import { createAppTwoFactorEnabledEmailPort } from './composition/email/two-factor-enabled-email.js';
import { createAppTwoFactorDisabledEmailPort } from './composition/email/two-factor-disabled-email.js';
import { createAppLoginLockoutEmailPort } from './composition/email/login-lockout-email.js';
import { createAppAdminOpNotifier } from './composition/email/admin-op-notification-email.js';
import { createConversationFundingReader } from './composition/bindings/conversation-funding.js';
import { createPresignReaders } from './composition/bindings/presign-readers.js';
import { createLinkResolutionAdapter } from './composition/bindings/link-resolution.js';
import { ROUTE_POSTURES } from './composition/rate-limit-posture.js';
import { ADMIN_ROUTE_ROLES } from './composition/admin-route-roles.js';
import { ROUTE_CACHE_POLICIES } from './composition/route-cache-policy.js';
import {
  createAppAccountDefensePort,
  createSessionRevokeEnqueueRegistration,
  createWebhookVerifierFromEnv,
} from './composition/bindings/billing-bindings.js';
import type { AdminRouteRoleMap } from './middleware/pipeline-admin.js';
import type { CachePolicyMap } from './middleware/pipeline-cache-policy.js';
import type { ResendWebhookSecretEnv } from './slices/newsletter/index.js';
import type { AdminOperationsDeps, AdminOperationsPostDeps } from './slices/admin/index.js';
import type { AppEnv } from './lib/context/index.js';
import type { RoutePostureMap } from './middleware/pipeline-rate-limit.js';

/** Skeleton liveness route — also the living example of the manifest contract. */
const healthManifest = defineSliceManifest({
  basePath: '/health',
  routes: new Hono<AppEnv>().get('/', routeClass('public'), (c) =>
    c.json({ status: 'ok', timestamp: new Date().toISOString() })
  ),
});

// Slice deps are per-request store factories: the manifests construct stores
// from the pipeline's `c.var.db` on each request, so module-level manifest
// construction holds no connection state.
const accountManifest = createAccountManifest({ stores: createAccountStores });
// The admin ops registry: constructing it runs the Iron Law gate at module
// load over the full registered op set — a durable mutation without its registered
// inverse fails the boot, so an irreversible admin operation cannot exist at
// runtime. The ops' slice deps are resolved per engine construction below.
const adminOpRegistry = createAdminOpRegistry<AdminOperationsDeps, AdminOperationsPostDeps>([
  ...adminOperations,
]);
const adminStores = createAdminStores();
// Key-row fence identity (`claimedBy`) for admin executes: per Worker
// instance, an identity rather than state — a restarted isolate claiming
// under a fresh id is exactly what the lease/fence machinery expects.
// Minted lazily on first use: workerd forbids generating random values at
// module scope (boot fails with "Disallowed operation called within global
// scope"), so the id cannot be a top-level const.
let adminExecutorId: string | undefined;
const getAdminExecutorId = (): string => (adminExecutorId ??= `admin-http-${crypto.randomUUID()}`);
const adminManifest = createAdminManifest({
  listOps: () => adminOpRegistry.list(),
  // The registered resolver runs with the SAME composed dep set the op
  // bodies receive (the engine's `opDeps` binding below), resolved per
  // request from the pipeline's db — one dep surface, no prefill-only
  // wiring to drift. `null` (unknown op or no resolver) 404s at the route.
  prefill: (db, name) => {
    const implementation = adminOpRegistry.get(name);
    // Only a mutation carries a resolver — a read's current-state input is
    // the read itself — so a read reaching here answers like an unknown op.
    if (implementation === undefined || !('prefill' in implementation)) return null;
    return implementation.prefill(createAdminOpDeps(db, billingStores));
  },
  // Deliberately NO `hooks`: `afterAudit` is the audit-atomicity battery's
  // test seam, and production wiring must keep it unreachable — the engine
  // here is composed hookless, and route deps expose no way to add one.
  engine: (db, logger) =>
    createAdminOpEngine({
      db,
      registry: adminOpRegistry,
      stores: adminStores,
      telemetry: logger,
      // Per-request transaction-scoped slice deps for the op bodies (billing
      // within-tx writes, identity stores, the session-revoke enqueue
      // registry, conversations' share writes); the shared billingStores
      // instance is composed here, everything else resolves from the request
      // context inside the binding.
      opDeps: createAdminOpDeps(db, billingStores),
      // Post-commit capabilities: the engine hands these to a registered
      // ephemeral effect's `run` after the transaction commits, never to an op
      // body. Built as its own literal — nothing derives it from `opDeps`, so
      // the two halves share no key and a cast across them reads `undefined`.
      postDeps: createAdminOpPostDeps(createEvictUserPort),
      executorId: getAdminExecutorId(),
      // Best-effort mutation notification to every allowlisted admin
      // (telemetry, never a control): resolved per notice from the request
      // context, guarded by the engine's own capture.
      onExecuted: createAppAdminOpNotifier(),
    }),
  // The bespoke read surface (Customer-360, dashboard, jobs queue, audit
  // search, SQL panel): identity/billing panels compose those slices'
  // published surfaces; conversations/jobs reads come through the app-level
  // cross-slice binding; the SQL panel opens its SECOND, SELECT-only
  // connection from the env registry entry (fail-fast when unset).
  reads: ({ db, env, isDev, role }) => {
    const panelUrl = env.ADMIN_SQL_PANEL_DATABASE_URL;
    if (panelUrl === undefined || panelUrl === '') {
      throw new Error('admin reads: ADMIN_SQL_PANEL_DATABASE_URL is not configured');
    }
    return createAdminReadSurface({
      db,
      role,
      stores: adminStores,
      auditReads: createAdminAuditReads(),
      crossSlice: createAdminCrossSliceReads(db),
      identity: createIdentityStores(db).users,
      billing: {
        balance: (userId, now) => readBalance(billingStores, db, userId, now),
        ledgerHistory: (userId, window) =>
          billingStores.readLedgerHistory(db, { userId, ...window }),
        usage: (userId) => readUsageBreakdown(billingStores, db, { userId, limit: 20 }),
      },
      sqlPanel: createSqlPanel({ url: panelUrl, isDev }),
      clock: { now: (): Date => new Date() },
      marketingUrl: requestMarketingUrl(),
    });
  },
});
const announcementsManifest = createAnnouncementsManifest({ stores: createAnnouncementsStores });
// Zero-dep like the platform manifests: the catalog read composes c.var DI
// (db + logger) per request.
const feedbackManifest = createFeedbackManifest({ stores: createFeedbackStores });
// The confirm-email adapter resolves env/db/logger per send via context
// storage (the static-port pattern); identity's published users store binds
// structurally to the slice's account-email read.
const newsletterManifest = createNewsletterManifest({
  stores: createNewsletterStores,
  confirmEmail: createAppNewsletterConfirmEmailPort(),
  identityUsers: (db) => createIdentityStores(db).users,
  // RESEND_WEBHOOK_SECRET is a secret, not on the typed Bindings (the
  // HELCIM_WEBHOOK_VERIFIER precedent); the verifier constructor fail-fasts
  // on a missing or corrupt value at first webhook delivery.
  webhookVerifier: (env: ResendWebhookSecretEnv) =>
    createResendWebhookVerifier({ secret: env.RESEND_WEBHOOK_SECRET }),
});
const modelsManifest = createModelsManifest();
// The on-device model artifacts: a zero-dep manifest reading the MODEL_WEIGHTS
// binding per request. It shares the `/models` mount with the catalog above and
// is mounted after it, which the shared-mount case in its own suite pins.
const modelWeightsManifest = createModelWeightsManifest();
const notificationsManifest = createNotificationsManifest({
  deviceTokenStore: createDeviceTokenStore,
  preferencesStore: createNotificationPreferencesStore,
});
// The email ports are the static (non-factory) slice deps: their adapters
// resolve env/logger per send from the ambient request scope the
// {@link edgeRing} stages enter, so this module-level construction still holds
// no state.
// One billing stores instance is shared by the billing manifest, the chat
// turn, and identity's registration provisioning: all compose the same
// admission/settlement writes, so they must read through the same published
// surface (the DB client is per-request `c.var.db`, which the store methods
// take as an argument — the stores object holds none).
const billingStores = createBillingStores();
// One growth store instance: the beacon reads the campaign registry through it
// and registration reads the same live tags through identity's dependency, so
// the two halves resolve a tag against one list rather than two.
const growthStores = createGrowthStores();
const identityManifest = createIdentityManifest({
  stores: createIdentityStores,
  emailPort: createAppVerificationEmailPort(),
  passwordChangedEmailPort: createAppPasswordChangedEmailPort(),
  passwordResetEmailPort: createAppPasswordResetEmailPort(),
  billingStores,
  welcomeEmailPort: createAppWelcomeEmailPort(),
  twoFactorEnabledEmailPort: createAppTwoFactorEnabledEmailPort(),
  twoFactorDisabledEmailPort: createAppTwoFactorDisabledEmailPort(),
  accountLockedEmailPort: createAppLoginLockoutEmailPort(),
  growthStores,
  // Closes a revoked user's live sockets on logout, 2FA-login rotation,
  // password change, recovery reset, and account deletion (ARCHITECTURE §Streaming & realtime).
  evictUser: createEvictUserPort,
  accountDeletedEmailPort: createAppAccountDeletedEmailPort(),
  // The deletion executor's cross-slice purge: chat's published content
  // helpers plus the media-reclaim enqueue. Composed HERE because identity may
  // import neither the chat nor the media barrel (both already import
  // identity; a barrel cycle is lint-banned). The registry is enqueue-only —
  // the reclaim handler runs in the dispatcher DO with its own registry — but
  // reuses the real registration so schema/lease/shard stay single-sourced.
  deletionPurge: (env, db) => ({
    captureContentStorageKeysWithinTx,
    deleteForeignMessageContentWithinTx,
    detachMessageSendersWithinTx,
    enqueueMediaReclaimWithinTx: async (tx, args) => {
      await enqueueWithinTx(
        tx,
        createAppJobRegistry([
          createMediaReclaimUserJob({
            resolveStorage: enqueueOnlyDeps(createR2StorageFromEnv(env, db)),
          }),
        ]),
        { type: MEDIA_RECLAIM_USER_JOB_TYPE, payload: args }
      );
    },
  }),
});
const conversationsManifest = createConversationsManifest({
  stores: createConversationsStores,
  // The owner-facing budget surface composes billing's member-cap write and the
  // display reads through the shared stores instance (same published surface as
  // the chat turn and settlement — single-writer of `member_budgets`).
  billing: billingStores,
  revoker: createMembershipRevoker,
  realtime: createConversationRoomRealtime,
  // Chat is the single writer of `messages`; a fork deletion composes its
  // deleter to remove the orphaned branch atomically with the fork row.
  deleteForkMessages: createForkMessageDeleter,
  // Shared-link credential resolution (identity's port over conversations'
  // shared-link store); liveness enforced lazily at read, same as media below.
  linkResolution: (db) => createLinkResolutionAdapter(db),
  // Membership events (a member added, a fork branched, a link shared) fire the
  // same notifications wiring the room's terminal sink uses, bound per request
  // and registered as a side-band after the mutation commits, so the
  // capability's membership reads still have the request pool open.
  notifyConversationEvent: createMembershipPushNotify,
});
const mediaManifest = createMediaManifest({
  // Presign readers span chat-owned content_items/messages AND conversations-owned
  // epochs — composed here at the root because no single slice may query across
  // that boundary (single-writer-per-table). Media's domain runs authorization on
  // the reader set without ever touching another slice's tables.
  readers: createPresignReaders,
  // R2 config bound from env; the per-request db threads through for CI evidence.
  storage: createR2StorageFromEnv,
  // Same shared-link resolution the member/share presign paths gate on.
  linkResolution: (db) => createLinkResolutionAdapter(db),
});
const billingManifest = createBillingManifest({
  stores: billingStores,
  // The payer of a group turn is named by conversations-owned rows, which
  // billing may not read (single-writer-per-table) — composed here, exactly
  // like media's presign readers.
  conversationFunding: createConversationFundingReader,
  // The request-scoped db threads into the real charge adapter for CI
  // service-evidence (no-op in production, where isCI is false — a charge's
  // success never depends on the evidence write).
  paymentProvider: (env, db, executionCtx, mockDirectives) =>
    createPaymentProviderFromEnv(env, db, { executionCtx, mockDirectives }),
  webhookVerifier: createWebhookVerifierFromEnv,
  // No module-scope DB exists here (env is per-request), so the enqueue registry
  // is built per request from `c.var.db`. The registration's DB is unused at
  // enqueue time (it only reads the registered schema/lease/shard); it feeds the
  // handler, which runs in the dispatcher DO, not this route.
  jobRegistry: (env, db) =>
    createAppJobRegistry([
      createPaymentVerifyJobRegistration({
        db,
        stores: billingStores,
        // db+isCI thread into the real Helcim adapter for CI service-evidence
        // (no-op outside CI). This provider reconciles, so it records evidence
        // only if it charges; the card-charge provider is wired separately.
        resolveProvider: enqueueOnlyDeps(createPaymentProviderFromEnv(env, db)),
      }),
      // The webhook's dispute path enqueues session.revoke.v1 inside the
      // clawback settlement transaction; without its registration here the
      // enqueue throws "unregistered job type", rolls the clawback back, and
      // 503-loops Helcim's redelivery. Enqueue reads only the schema/lease/shard
      // (the handler runs in the dispatcher DO's own registry).
      createSessionRevokeEnqueueRegistration(env),
    ]),
  // Chargeback auto-defense over identity's published within-tx lock: the
  // account lock commits in the webhook's clawback SettlementTx (session
  // revocation is the must-happen session.revoke.v1 job it also enqueues).
  accountDefense: createAppAccountDefensePort(),
  accountLockedEmail: createAppChargebackLockEmailPort(),
});
// The Linear client is bound as a factory rather than an instance: its
// env-mode dispatch reads per-request bindings the route holds, so
// module-level construction still holds no state.
const roadmapManifest = createRoadmapManifest({
  linear: getLinearClient,
  teamKey: LINEAR_TEAM_KEY,
});
// The stats slice reads its snapshot through billing's published stores.
const statsManifest = createStatsManifest({ stores: createPublicStatsStores() });
// The growth beacon validates every path and event name against the index the
// marketing build emitted and this build bundled, so it reads no file and
// fetches nothing at runtime.
const growthManifest = createGrowthManifest({
  stores: growthStores,
  eventIndex: bundledGrowthEventIndex(),
});
// OTA updates and the dev tooling family: zero-dep manifests — they take
// everything from per-request bindings and c.var DI, so module-level
// construction holds no state.
const updatesManifest = createUpdatesManifest();
const devManifest = createDevManifest();
const chatManifest = createChatManifest({
  conversations: createConversationsStores,
  billing: billingStores,
  // The turn streams over the same ConversationRoom DO conversations broadcasts
  // through — one binding, not a second.
  realtime: createConversationRoomRealtime,
  trialRoomName,
  // Same shared-link resolution the conversations/media manifests gate on: the
  // guest-send path resolves the link principal through it.
  linkResolution: (db) => createLinkResolutionAdapter(db),
  // The runless user-only send's best-effort push side-band — the same
  // `createMessagePushNotify` wiring the ConversationRoom uses for AI turns,
  // bound per request from the route's env + db (push config, membership,
  // device tokens). Absent-and-non-muted members are notified; present, muted,
  // and the sender are suppressed downstream.
  notifyNewMessage: createChatMessagePushNotify,
});

/**
 * Production routes the admin hostname's API traffic to this Worker under an
 * `/api/*` path (`admin.hushbox.ai/api/*` in wrangler.toml), and the admin SPA
 * always calls relative `/api/admin/...` — but the admin slice mounts at
 * `/admin`. This routing-path hook strips exactly the `/api` prefix off
 * `/api/admin/...` requests BEFORE Hono routes them, so dev and prod share one
 * canonical mapping and the pipeline, rate limits, and authorizer all see the
 * final `/admin/...` path. No new auth surface: the alias reaches only the
 * fail-closed `admin` route class (JWT verified on every request). Scoped to
 * the exact `/api/admin/` prefix by design — no general `/api` rewriter, no
 * hostname keying (deploy config owns hostnames; the path is deterministic in
 * every mode). Routing and `c.req.path` both see the rewritten `/admin/...`
 * path; only `c.req.url` keeps the original `/api/...` URL.
 */
export function adminApiAliasPath(request: Request): string {
  const path = getPath(request);
  return path.startsWith('/api/admin/') ? path.slice('/api'.length) : path;
}

/**
 * The declarations widened to the stage's lookup type at the boundary. Handed
 * to `applyPipeline` as its `as const` literal type instead, Hono's inference
 * over {@link createApp}'s slice-route chain collapses to `any` — the map's
 * key union is the size of the route surface, and it is a lookup table here,
 * never a witness.
 */
const routeCachePolicies: CachePolicyMap = ROUTE_CACHE_POLICIES;

/** The admin role declarations widened to the stage's lookup type, for the
 * reason {@link routeCachePolicies} is widened. */
const adminRouteRoles: AdminRouteRoleMap = ADMIN_ROUTE_ROLES;

/**
 * The app assembly: one default-deny pipeline applied to everything mounted
 * under it, then the slice manifests at their real paths. Routes hold no
 * business logic here — this file only composes. Dev-only surfaces are not a
 * mount-time concern: the `dev-only` route class answers 404 in production.
 *
 * Error mapping is owned here (sub-routers must not install `onError`). Both
 * non-route outcomes answer the uniform `{code}` wire shape:
 * - `notFound` matches the authorizer's production-hidden dev-only denial
 *   byte-for-byte, so a probe cannot tell a hidden route from a missing one;
 * - `onError` answers a defect with a bare `{code: INTERNAL}` — internals go
 *   to telemetry only, never the wire. The fallback adapter covers defects
 *   thrown before the bindings stage installs the request logger (e.g. the
 *   missing-binding fail-fast).
 *
 * `additionalPostures` declares the rate-limit posture of routes the CALLER
 * mounts on the returned app. The pipeline refuses any matched route the
 * posture map does not declare, and `ROUTE_POSTURES` can only name routes
 * this function mounts — its keys are read off `AppType` — so whoever adds a
 * route to the assembled app declares it here or watches it be refused. The
 * declarations this function owns are merged LAST, which is what keeps the
 * argument additive: a caller can name a route it mounts, never re-posture
 * one of the product's.
 */
export function createApp(additionalPostures?: RoutePostureMap) {
  const root = new Hono<AppEnv>({ getPath: adminApiAliasPath });
  for (const middleware of edgeRing()) root.use('*', middleware);
  // Credential liveness is enforced app-wide: the identity slice's revocation
  // checks run on every cookie-bearing request, so a logged-out or
  // password-staled session — and a revoked billing-portal handoff, which
  // revokes on its own key — degrades to `none` before authorization, the
  // production configuration `assertRevocationWiredInProduction` expects.
  // The posture map is wired here for the same reason: it is keyed off
  // `AppType`, so the declaration lives at the composition root and the
  // pipeline stage that enforces it reads the map from here.
  const base = applyPipeline(root, {
    session: {
      revocation: checkSessionRevocation,
      billingRevocation: checkBillingPortalRevocation,
    },
    rateLimit: {
      postures: { ...additionalPostures, ...ROUTE_POSTURES },
      linkCredentialHeader: LINK_CREDENTIAL_HEADER,
    },
    cache: { policies: routeCachePolicies },
    admin: { routeRoles: adminRouteRoles },
  })
    .notFound((c) => c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404))
    .onError((error, c) => {
      const logger = readPipelineVariable(c, 'logger') ?? createConsoleTelemetry();
      logger.captureError(error, ERROR_CODES.INTERNAL);
      return c.json(createErrorResponse(ERROR_CODES.INTERNAL), 500);
    });
  // Slice manifests mount below, one chained `.route()` line per slice
  // (chaining — not a loop — keeps AppType inference for the typed client).
  const app = base
    .route(healthManifest.basePath, healthManifest.routes)
    .route(accountManifest.basePath, accountManifest.routes)
    .route(adminManifest.basePath, adminManifest.routes)
    .route(announcementsManifest.basePath, announcementsManifest.routes)
    .route(identityManifest.basePath, identityManifest.routes)
    .route(conversationsManifest.basePath, conversationsManifest.routes)
    .route(chatManifest.basePath, chatManifest.routes)
    .route(billingManifest.basePath, billingManifest.routes)
    .route(mediaManifest.basePath, mediaManifest.routes)
    .route(feedbackManifest.basePath, feedbackManifest.routes)
    .route(growthManifest.basePath, growthManifest.routes)
    .route(newsletterManifest.basePath, newsletterManifest.routes)
    .route(modelsManifest.basePath, modelsManifest.routes)
    .route(modelWeightsManifest.basePath, modelWeightsManifest.routes)
    .route(notificationsManifest.basePath, notificationsManifest.routes)
    .route(roadmapManifest.basePath, roadmapManifest.routes)
    .route(statsManifest.basePath, statsManifest.routes)
    .route(updatesManifest.basePath, updatesManifest.routes)
    .route(devManifest.basePath, devManifest.routes);
  return app;
}

export type AppType = ReturnType<typeof createApp>;
