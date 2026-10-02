import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { newsletterSubscribers, users } from '@hushbox/db';
import { ERROR_CODES, MOBILE_PLATFORMS, NewsletterStatus } from '@hushbox/shared';
import {
  defineSliceManifest,
  rejectInvalid,
  respondDomainError,
  routeClass,
} from '../middleware/pipeline-manifest.js';
import { CF_ACCESS_JWT_HEADER, mintDevAdminToken } from '../middleware/pipeline-admin.js';
import { createErrorResponse, notFoundError, unavailableError } from '../lib/errors/index.js';
import { idempotencyExempt, idempotent, runMutation } from '../lib/idempotency/index.js';
import { fromPromise } from '../lib/result/index.js';
import { callerIpId, growthHourBucket } from '../lib/redis/index.js';
import { listFeedbackForUser } from '../slices/feedback/index.js';
import { growthRollupHourSchema, rollupGrowthHour } from '../slices/growth/index.js';
import { createIdentityStores } from '../slices/identity/index.js';
import { createR2StorageFromEnv } from '../slices/media/index.js';
import { mintNewsletterSubscribers } from '../slices/newsletter/index.js';
import { findCapturedEmail, listCapturedEmails } from '../slices/notifications/index.js';
import { DevSeedError, DevSeedStorageUnavailableError } from './factories.js';
import { ADMIN_TARGET_KINDS, mintAdminTargets } from './mint-admin-targets.js';
import { listDevPersonas } from './personas.js';
import { mockChargeBasis } from './mock-charge-basis.js';
import {
  conversationCost,
  countLlmCompletions,
  listMessagePayers,
  readAcquisitionSource,
} from './reads.js';
import {
  clearTotpReplayMarkers,
  resetAuthRateLimits,
  resetTrialUsage,
  resetAdminDashboardReads,
  resetAdminJobQueueReads,
  resetAdminOpsRuns,
  resetUsageRateLimits,
} from './redis-resets.js';
import { DevWalletNotFoundError, setWalletBalance } from './wallet.js';
import { resetBanner } from './banner.js';
import { EMAIL_TEMPLATE_PREVIEWS } from './email-previews.js';
import {
  authRateLimitsBodySchema,
  conversationBodySchema,
  groupChatBodySchema,
  usageHistoryBodySchema,
} from './route-schemas.js';
import {
  resolveAuthResetIdentities,
  revokeShareWork,
  seedConversationWork,
  seedGroupChatWork,
  seedMediaWork,
  seedUsageHistoryWork,
  setChecksumWork,
  setVersionWork,
} from './route-work.js';
import type { Context } from 'hono';
import type { DevAdminTokenResponse } from '@hushbox/shared';
import type { ResultAsync } from '../lib/result/index.js';
import type { DomainError } from '../lib/errors/index.js';
import type { AppEnv, RefusalResponse } from '../middleware/pipeline-manifest.js';

/** One shared err-arm for every route's `result.match` (all map identically). */
function domainErrorResponder(c: Context<AppEnv>): (error: DomainError) => RefusalResponse {
  return (error) => respondDomainError(c, error);
}

/**
 * Dev tooling promises lifted into the Result channel: the seed factories'
 * 404-shaped errors (unknown persona/wallet — expected E2E states) map to
 * `not_found`; a storage-availability seed failure maps to a truthful
 * `unavailable` (a storage outage is never a missing target); anything else is
 * `unavailable`.
 */
function liftDevWork<T>(work: Promise<T>): ResultAsync<T, DomainError> {
  return fromPromise(work, (cause) => {
    if (cause instanceof DevSeedStorageUnavailableError) {
      return unavailableError('dev route storage unavailable', cause);
    }
    return cause instanceof DevSeedError || cause instanceof DevWalletNotFoundError
      ? notFoundError('dev route target not found', cause)
      : unavailableError('dev route work failed', cause);
  });
}

/**
 * The E2E tooling family. Every route is `dev-only` (404 in production).
 * Mutating routes declare the `naturally-idempotent` exemption — the legacy
 * E2E callers send no Idempotency-Key — and run through `idempotent.byUpsert`
 * as dev-tooling convergent writes (the seed factories mint fresh uuids, so
 * a repeat creates a fresh fixture rather than duplicating a domain effect;
 * the resets and setters genuinely converge on the same end state).
 *
 * Two legacy dev routes are deliberately NOT ported and must not be re-added:
 * `DELETE /dev/test-data` (bulk test-data wipe) is superseded by per-test DB
 * isolation + `pnpm db:reset`; `POST /dev/expire-session` (destroy the session
 * cookie) is superseded by the real `/logout` route and session revocation.
 * Their absence is a decision, not an accidental gap.
 */
export function createDevManifest() {
  return defineSliceManifest({
    basePath: '/dev',
    routes: new Hono<AppEnv>()
      // The dev-admin mint: an Access-shaped JWT for a
      // chosen email, signed by the committed dev key, so the SPA and the
      // e2e suite drive the REAL jose verification stage locally. Choosing
      // the email gives actor switching; a non-allowlisted email mints fine and is then
      // refused by verification — itself a useful denial fixture. Read-shaped
      // (GET, no state written), so no idempotency concern. Production is
      // safe twice over: this class 404s there, and the production env
      // registry carries no dev signing key to mint with.
      .get(
        '/admin-token',
        routeClass('dev-only'),
        zValidator('query', z.object({ email: z.email() }), rejectInvalid),
        async (c) => {
          const token = await mintDevAdminToken(c.env, { email: c.req.valid('query').email });
          return c.json({ token, header: CF_ACCESS_JWT_HEADER } satisfies DevAdminTokenResponse);
        }
      )
      .get(
        '/personas',
        routeClass('dev-only'),
        zValidator('query', z.object({ type: z.enum(['test', 'dev']).optional() }), rejectInvalid),
        async (c) => {
          const { type } = c.req.valid('query');
          const personas = await listDevPersonas(c.var.db, type ?? 'dev');
          return c.json({ personas });
        }
      )
      .post(
        '/conversation',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', conversationBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              liftDevWork(
                seedConversationWork(c.var.db, c.var.redis, c.var.logger, c.req.valid('json'))
              )
            )
          );
          return result.match((created) => c.json(created, 201), domainErrorResponder(c));
        }
      )
      .post(
        '/media-conversation',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator(
          'json',
          z.object({
            ownerEmail: z.email(),
            userContent: z.string(),
            mediaType: z.enum(['image', 'video']),
          }),
          rejectInvalid
        ),
        async (c) => {
          const storage = createR2StorageFromEnv(c.env, c.var.db);
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              liftDevWork(
                seedMediaWork(
                  { db: c.var.db, storage, redis: c.var.redis, logger: c.var.logger },
                  c.req.valid('json')
                )
              )
            )
          );
          return result.match((created) => c.json(created, 201), domainErrorResponder(c));
        }
      )
      .post(
        '/group-chat',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', groupChatBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              liftDevWork(seedGroupChatWork(c.var.db, c.var.logger, c.req.valid('json')))
            )
          );
          return result.match((created) => c.json(created, 201), domainErrorResponder(c));
        }
      )
      // Fresh admin-op target rows (unique ids per call) so parallel E2E
      // specs mutate their own targets instead of racing over the fixed
      // seeded set (`seedAdminOpTargets`). Minting only what's asked keeps
      // specs fast; minted users are disposable, never OPAQUE-loginable.
      .post(
        '/admin-targets',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator(
          'json',
          z.object({ kinds: z.array(z.enum(ADMIN_TARGET_KINDS)).min(1) }),
          rejectInvalid
        ),
        async (c) => {
          const { kinds } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(mintAdminTargets(c.var.db, kinds)))
          );
          return result.match((minted) => c.json(minted, 201), domainErrorResponder(c));
        }
      )
      .post(
        '/wallet-balance',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator(
          'json',
          z.object({
            email: z.email(),
            walletType: z.enum(['purchased', 'free_tier']),
            balance: z.string().min(1),
          }),
          rejectInvalid
        ),
        async (c) => {
          const params = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(setWalletBalance(c.var.db, c.var.redis, params)))
          );
          return result.match(
            (outcome) => c.json({ success: true, newBalance: outcome.newBalance }),
            domainErrorResponder(c)
          );
        }
      )
      .delete(
        '/banner',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(resetBanner(c.var.db)))
          );
          return result.match(() => c.json({ success: true }), domainErrorResponder(c));
        }
      )
      // Backdated usage rows for a spend-surface precondition: the seeding
      // routine already takes the model, provider and instant a spec needs, so
      // a state such as one model billed under two providers is built
      // deliberately instead of being waited for.
      .post(
        '/usage-history',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', usageHistoryBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              liftDevWork(seedUsageHistoryWork(c.var.db, c.req.valid('json')))
            )
          );
          return result.match((seeded) => c.json(seeded, 201), domainErrorResponder(c));
        }
      )
      .delete(
        '/trial-usage',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        async (c) => {
          // The caller's own quota identity, derived exactly as the trial send
          // derives it, so the reset frees the window this caller spends and no
          // other caller's.
          const ipId = await callerIpId((name) => c.req.header(name), c.var.envUtils);
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(resetTrialUsage(c.var.redis, ipId)))
          );
          return result.match(
            (outcome) => c.json({ success: true, deleted: outcome.deleted }),
            domainErrorResponder(c)
          );
        }
      )
      .delete(
        '/auth-rate-limits',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', authRateLimitsBodySchema, rejectInvalid),
        async (c) => {
          // Both scopes are named by the request: the caller's own rate-limit
          // identity, derived exactly as the limiters derive it, and the
          // accounts it listed. Nothing else is reachable from here.
          const ipId = await callerIpId((name) => c.req.header(name), c.var.envUtils);
          const identities = await resolveAuthResetIdentities(
            c.var.db,
            c.req.valid('json').identifiers
          );
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              liftDevWork(resetAuthRateLimits(c.var.redis, ipId, identities))
            )
          );
          return result.match(
            (outcome) => c.json({ success: true, deleted: outcome.deleted }),
            domainErrorResponder(c)
          );
        }
      )
      .delete(
        '/usage-rate-limits',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        async (c) => {
          // The caller's own rate-limit identity, derived exactly as the
          // limiters derive it, so the reset reaches the per-IP windows this
          // caller spends and no other caller's — a guest window is cleared by
          // a call presenting that guest's address.
          const ipId = await callerIpId((name) => c.req.header(name), c.var.envUtils);
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(resetUsageRateLimits(c.var.redis, ipId)))
          );
          return result.match(
            (outcome) => c.json({ success: true, deleted: outcome.deleted }),
            domainErrorResponder(c)
          );
        }
      )
      .delete(
        '/admin-dashboard-reads',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(resetAdminDashboardReads(c.var.redis)))
          );
          return result.match(
            (outcome) => c.json({ success: true, deleted: outcome.deleted }),
            domainErrorResponder(c)
          );
        }
      )
      .delete(
        '/admin-job-queue-reads',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(resetAdminJobQueueReads(c.var.redis)))
          );
          return result.match(
            (outcome) => c.json({ success: true, deleted: outcome.deleted }),
            domainErrorResponder(c)
          );
        }
      )
      .delete(
        '/admin-ops-runs',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(resetAdminOpsRuns(c.var.redis)))
          );
          return result.match(
            (outcome) => c.json({ success: true, deleted: outcome.deleted }),
            domainErrorResponder(c)
          );
        }
      )
      .delete(
        '/totp-replay',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', z.object({ email: z.email() }), rejectInvalid),
        async (c) => {
          const { email } = c.req.valid('json');
          const [user] = await c.var.db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, email.toLowerCase()));
          if (user === undefined) {
            return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
          }
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(clearTotpReplayMarkers(c.var.redis, user.id)))
          );
          return result.match(
            (outcome) => c.json({ success: true, deleted: outcome.deleted }),
            domainErrorResponder(c)
          );
        }
      )
      // The harness's OTA bundle is built locally, so its sha256 exists only
      // once the zip is written — too late for a binding. Publishing it here
      // is what lets the mobile update flow install a bundle the native client
      // will accept.
      .post(
        '/set-checksum',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator(
          'json',
          z.object({
            platform: z.enum(MOBILE_PLATFORMS),
            checksum: z.string().min(1),
          }),
          rejectInvalid
        ),
        async (c) => {
          const { platform, checksum } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(setChecksumWork(platform, checksum)))
          );
          return result.match(
            (outcome) =>
              c.json(
                { success: true, platform: outcome.platform, checksum: outcome.checksum },
                200
              ),
            domainErrorResponder(c)
          );
        }
      )
      .post(
        '/set-version',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', z.object({ version: z.string().min(1) }), rejectInvalid),
        async (c) => {
          const { version } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(setVersionWork(version)))
          );
          return result.match(
            (outcome) => c.json({ success: true, version: outcome.version }, 200),
            domainErrorResponder(c)
          );
        }
      )
      .get(
        '/verify-token/:email',
        routeClass('dev-only'),
        zValidator('param', z.object({ email: z.email() }), rejectInvalid),
        async (c) => {
          const { email } = c.req.valid('param');
          const token = await createIdentityStores(
            c.var.db
          ).verification.findLatestVerificationToken(email.toLowerCase(), new Date());
          return token.match(
            (value) =>
              value === null
                ? c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404)
                : c.json({ token: value }),
            domainErrorResponder(c)
          );
        }
      )
      // E2E read-back for feedback persistence: the submit endpoint is
      // session-class (dev routes are anonymous), so the caller identity comes
      // from a path-param email, never a principal. 404s in production via the
      // dev-only class.
      .get(
        '/feedback/by-email/:email',
        routeClass('dev-only'),
        zValidator('param', z.object({ email: z.email() }), rejectInvalid),
        async (c) => {
          const { email } = c.req.valid('param');
          const [user] = await c.var.db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, email.toLowerCase()));
          if (user === undefined) {
            return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
          }
          const result = await listFeedbackForUser(c.var.db, user.id);
          return result.match((rows) => c.json({ rows }), domainErrorResponder(c));
        }
      )
      // Forces the growth rollup for one hour, so a spec can beacon and then
      // read the aggregate rows without waiting for the scheduled tick. It runs
      // the same reduction the job handler runs — assignment on each row's
      // dimension tuple — so calling it twice leaves the rows one call leaves.
      // The default is the current hour, which is the one a spec just wrote
      // into; an incomplete hour is no obstacle, since a later run assigns over
      // it.
      .post(
        '/growth-rollup',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', z.object({ hour: growthRollupHourSchema.optional() }), rejectInvalid),
        async (c) => {
          const hour = c.req.valid('json').hour ?? growthHourBucket(new Date());
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              rollupGrowthHour({ db: c.var.db, redis: c.var.redis, hour, now: new Date() })
            )
          );
          return result.match((outcome) => c.json({ hour, outcome }), domainErrorResponder(c));
        }
      )
      // E2E read-back for the account's acquisition row: the source registration
      // stamped and whatever the account holder later said through the channel
      // prompt. The prompt's own appearance and disappearance is app state, not
      // proof of a write, so the specs that drive it assert the row through
      // here. Caller identity is a path-param email, never a principal — dev
      // routes are anonymous.
      .get(
        '/acquisition-source/:email',
        routeClass('dev-only'),
        zValidator('param', z.object({ email: z.email() }), rejectInvalid),
        async (c) => {
          const { email } = c.req.valid('param');
          const row = await readAcquisitionSource(c.var.db, email);
          if (row === null) {
            return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
          }
          return c.json(row);
        }
      )
      .get(
        '/llm-completions-count/:conversationId',
        routeClass('dev-only'),
        zValidator('param', z.object({ conversationId: z.uuid() }), rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          return c.json({ count: await countLlmCompletions(c.var.db, conversationId) });
        }
      )
      .get(
        '/message-payers/:conversationId',
        routeClass('dev-only'),
        zValidator('param', z.object({ conversationId: z.uuid() }), rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const payers = await listMessagePayers(c.var.db, conversationId);
          return c.json({ payers });
        }
      )
      .get(
        '/conversation-cost/:conversationId',
        routeClass('dev-only'),
        zValidator('param', z.object({ conversationId: z.uuid() }), rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          return c.json({ cost: await conversationCost(c.var.db, conversationId) });
        }
      )
      // The mock provider's declared charge basis. E2E money assertions derive
      // their expected amount from it rather than typing one, so a change to
      // what the mock charges or echoes moves every expectation with it.
      .get('/mock-charge-basis', routeClass('dev-only'), (c) => c.json(mockChargeBasis()))
      .post(
        '/revoke-message-share',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', z.object({ shareId: z.uuid() }), rejectInvalid),
        async (c) => {
          const { shareId } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(revokeShareWork(c.var.db, shareId)))
          );
          return result.match(
            (outcome) => c.json({ success: true, rowsAffected: outcome.rowsAffected }),
            domainErrorResponder(c)
          );
        }
      )
      .get('/emails', routeClass('dev-only'), (c) => {
        const templates = EMAIL_TEMPLATE_PREVIEWS.map(({ name, label, render }) => ({
          name,
          label,
          html: render(),
        }));
        return c.json({ templates });
      })
      // E2E read-back for the double-opt-in and unsubscribe flows: the live
      // tokens straight from the subscriber row (the verify-token/:email
      // precedent).
      .get(
        '/newsletter/tokens/:email',
        routeClass('dev-only'),
        zValidator('param', z.object({ email: z.email() }), rejectInvalid),
        async (c) => {
          const { email } = c.req.valid('param');
          const rows = await c.var.db
            .select({
              confirmToken: newsletterSubscribers.confirmToken,
              unsubscribeToken: newsletterSubscribers.unsubscribeToken,
              status: newsletterSubscribers.status,
            })
            .from(newsletterSubscribers)
            .where(eq(newsletterSubscribers.email, email.toLowerCase()));
          const row = rows[0];
          if (row === undefined) {
            return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
          }
          return c.json(row);
        }
      )
      .post(
        '/newsletter/subscribers',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator(
          'json',
          z.object({
            count: z.number().int().min(1).max(500),
            status: NewsletterStatus.optional(),
            emailPrefix: z.string().min(1).max(64).optional(),
          }),
          rejectInvalid
        ),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              liftDevWork(mintNewsletterSubscribers(c.var.db, c.req.valid('json')))
            )
          );
          return result.match((minted) => c.json(minted, 200), domainErrorResponder(c));
        }
      )
      // The dev mailbox: what the factory-built mock sender actually
      // delivered (per-recipient, across requests) — distinct from
      // `/dev/emails`, which previews the static templates.
      .get('/mailbox', routeClass('dev-only'), (c) => {
        const emails = listCapturedEmails().map(({ id, message }) => ({
          id,
          to: message.to,
          subject: message.subject,
        }));
        return c.json({ emails });
      })
      .get('/mailbox/:id', routeClass('dev-only'), (c) => {
        const captured = findCapturedEmail(c.req.param('id'));
        if (captured === undefined) {
          return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
        }
        return c.html(captured.message.html);
      }),
  });
}
