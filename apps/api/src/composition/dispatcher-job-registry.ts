import { createEnvUtilities } from '@hushbox/shared';
import { createAppJobRegistry, openDispatcherDb } from '../lib/jobs/index.js';
import { createDurableObjectTelemetry } from '../lib/telemetry/index.js';
import {
  configureRateLimitBound,
  configureRateLimitKeySecret,
  rateLimitBound,
} from '../lib/rate-limit/index.js';
import { createBoundedRedis } from '../lib/resilience/index.js';
import {
  createBillingStores,
  createPaymentProviderFromEnv,
  createPaymentVerifyJobRegistration,
} from '../slices/billing/index.js';
import {
  createAdminAuditDigestReads,
  createAdminDigestJobRegistration,
} from '../slices/admin/index.js';
import { createSessionRevokeJobRegistration } from '../slices/identity/index.js';
import { createMediaReclaimUserJob, createR2StorageFromEnv } from '../slices/media/index.js';
import {
  createNewsletterDispatchJobRegistration,
  createNewsletterDispatchStores,
} from '../slices/newsletter/index.js';
import { createGrowthRollupJobRegistration } from '../slices/growth/index.js';
import { createEmailSenderFromEnv } from '../slices/notifications/index.js';
import {
  parseAdminNotificationRecipients,
  requireAdminUrl,
} from './email/admin-op-notification-email.js';
import { createEvictUserPort } from './bindings/evict-user-port.js';
import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { JobRegistry } from '../lib/jobs/index.js';
import type { EvictUserPort } from '../slices/identity/index.js';
import type { Bindings } from '../lib/context/app-env.js';
import type { EnvContext } from '@hushbox/shared';

/**
 * Composition-root wiring for the JobDispatcher DO's job registry. It composes
 * the dispatcher's registrations from the owning slices' published barrels —
 * work `lib/jobs` may not do, since `lib` may not import a slice. The running
 * dispatcher's registry comes from here (via the composition-only
 * `job-dispatcher.ts`), so a `payment.verify.v1` row enqueued by billing's
 * pre-claim resolves to its handler instead of dead-lettering as an
 * unregistered type in the live dispatcher.
 */

/**
 * Opens the dispatcher's Database handle from the DO's per-invocation env. The
 * payment-verify handler's settlement writes run on this connection; the Neon
 * pool connects lazily, so an idle dispatcher still holds no socket, and it
 * lives for the DO instance (the pass executor opens its own per-pass
 * connection for claim/complete and closes it at pass end). Fails fast on a
 * missing DATABASE_URL rather than degrading.
 */
export function openDispatcherDbFromEnv(env: Bindings): Database {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      'JobDispatcher registry: missing required binding DATABASE_URL — ' +
        'the dispatcher fails fast instead of degrading.'
    );
  }
  return openDispatcherDb(databaseUrl, createEnvUtilities(env));
}

/**
 * Opens the dispatcher's Redis client from the DO env, fail-fast on a missing
 * binding. The `session.revoke.v1` handler bumps the all-session
 * `passwordChangedAt` watermark through it (revoke-all).
 *
 * Bounded, because that handler is a revocation. The runner already races
 * every handler against the lesser of its declared execution budget and its
 * lease margin, so a command the store never answers ends either way; the
 * bound is what makes it end in well under a second rather than after the
 * handler's whole execution budget, and what makes the failure carry a
 * cause-specific code rather than a generic lease timeout, which is the
 * better operator signal. Past the deadline the command fails, the handler's
 * Result arm reports `fail`, and the row is retried.
 */
export function openDispatcherRedis(env: Bindings): Redis {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url === undefined || url === '' || token === undefined || token === '') {
    throw new Error(
      'JobDispatcher registry: missing required binding UPSTASH_REDIS_REST_URL/TOKEN — ' +
        'the session-revoke handler fails fast instead of degrading.'
    );
  }
  // The dispatcher isolate has no request pipeline, so the bound on one round
  // trip to this store is put in force here, from this env's registry entry,
  // and read back for the client that runs under it. Both readers need it: the
  // client bounds every command, and a counter check a job handler reaches
  // would otherwise throw instead of counting. The identifier key is put in
  // force beside it, for the same counter check.
  configureRateLimitBound(env);
  configureRateLimitKeySecret(env);
  return createBoundedRedis({ url, token }, rateLimitBound().timeoutMs);
}

/**
 * The origins a dispatched newsletter issue links against. API_URL is how the
 * API knows its own public origin (the one-click unsubscribe POST target);
 * MARKETING_URL is the human goodbye page (the visible unsubscribe link lives on
 * the marketing site, not the API). Both are env registry entries; missing
 * either is a deployment defect, never a silently broken link.
 */
interface IssueUrlsEnv extends EnvContext {
  readonly API_URL?: string;
  readonly MARKETING_URL?: string;
}

function requireIssueEmailUrls(env: IssueUrlsEnv): { apiUrl: string; marketingUrl: string } {
  const { API_URL, MARKETING_URL } = env;
  if (
    API_URL === undefined ||
    API_URL === '' ||
    MARKETING_URL === undefined ||
    MARKETING_URL === ''
  ) {
    throw new Error(
      'JobDispatcher registry: missing required binding API_URL/MARKETING_URL — ' +
        'the newsletter dispatch handler fails fast instead of degrading.'
    );
  }
  return { apiUrl: API_URL, marketingUrl: MARKETING_URL };
}

/**
 * The registry the live JobDispatcher DO runs. The db is passed in (rather than
 * opened here) so the DO composition owns its lifetime and tests can supply a
 * closable handle.
 *
 * Every job type a slice owns is registered here, at the composition seam where
 * the owning slices' barrels are importable — a row of any type then resolves
 * to its handler instead of dead-lettering as an unregistered type. Each
 * handler's own infrastructure is bound here too: the reclaim handler deletes
 * R2 objects (env-bound Storage), the revoke handler bumps the session
 * watermark (env-bound Redis) and evicts live sockets (env-bound realtime), and
 * the growth rollup reads the counting store (env-bound Redis) and writes the
 * growth tables on the passed-in handle.
 *
 * Every config-faulting dependency is passed as a resolver invoked inside its
 * own handler, mirroring the cron surface (`resolveSend`/`resolveReader`):
 * construction cannot throw, so one type's missing binding fails only that
 * type's rows — the executor turns the throw into a `fail` outcome that
 * retries and finally dead-letters, which the dispatcher surfaces as its
 * dead-letter capture at claim time — instead of leaving the dispatcher with
 * no registry and every type dead-lettering as unregistered.
 */
export function createDispatcherJobRegistry(env: Bindings, db: Database): JobRegistry {
  const resolveRevoke = (): { redis: Redis; evictUser: EvictUserPort } => {
    const redis = openDispatcherRedis(env);
    return { redis, evictUser: createEvictUserPort(redis, env) };
  };
  return createAppJobRegistry([
    createPaymentVerifyJobRegistration({
      db,
      stores: createBillingStores(),
      resolveProvider: () => createPaymentProviderFromEnv(env),
    }),
    createMediaReclaimUserJob({
      resolveStorage: () => createR2StorageFromEnv(env, db, 'media-reclaim'),
    }),
    createSessionRevokeJobRegistration({ resolveRevoke }),
    createNewsletterDispatchJobRegistration({
      store: createNewsletterDispatchStores(db),
      resolveSend: () => ({
        sender: createEmailSenderFromEnv(env),
        urls: requireIssueEmailUrls(env),
      }),
    }),
    createAdminDigestJobRegistration({
      auditReads: createAdminAuditDigestReads(db),
      resolveSend: () => ({
        sender: createEmailSenderFromEnv(env),
        adminEmails: parseAdminNotificationRecipients(env.ADMIN_ROLE_MAP),
        adminUrl: requireAdminUrl(env),
      }),
    }),
    createGrowthRollupJobRegistration({
      db,
      resolveRedis: () => openDispatcherRedis(env),
      // Exempt from this registry's config-faulting-resolver rule: a bad sink
      // list degrades to console rather than throwing.
      resolveTelemetry: () => createDurableObjectTelemetry(env),
      now: () => new Date(),
    }),
  ]);
}
