/**
 * The dev reset endpoints, and the fact a reader must not get wrong about them:
 * **being one of these is no promise that a reset is scoped to its caller.**
 * Two reach nothing but what the request names — the auth reset, whose per-IP
 * throttles are cleared for the calling address alone and whose account
 * counters are cleared for the identifiers the request body carries and for no
 * others (`resetAuthRateLimits`, `authResetKeys`), and the TOTP replay clear,
 * which takes the one user it is asked about (`clearTotpReplayMarkers`). Every
 * other endpoint here wipes at least one thing for EVERY identity in the
 * environment. The trial and usage resets do clear a per-IP window — the trial
 * quota's per-IP counter, the usage-surface caps — for the calling address
 * alone, but that is one dimension of their reach and not the whole of it:
 * reading the caller-scoped half as the whole is what makes a global reset look
 * safe to call per test, and `resetUsageRateLimits` records what that costs
 * under parallel workers.
 *
 * What is cleared for EVERY identity in the environment, because nothing in the
 * request can name one:
 *
 * - The usage reset's chat-stream, media-download, share-create, link-mint and
 *   batch-keychain buckets and the per-shareId presign re-mint counter
 *   (`resetUsageRateLimits`). A reset request carries none of the identities
 *   they key on.
 * - The global daily trial spend cap and the per-session quota counters
 *   (`resetTrialUsage`): the first carries no IP component at all, the second is
 *   keyed on a trial token the endpoint never receives.
 * - The admin read and ops windows, keyed on a hashed Access actor no caller
 *   presents here, which is why none of them is ever cleared between tests.
 *
 * A limiter can belong in neither frame, and the easiest one here to state
 * wrongly is the email-verification consume throttle: it is keyed on a token, so
 * no caller can name it EITHER — and no reset clears it at all. It is absent
 * from the list above rather than covered by it, and drains only when its own
 * window expires.
 */

import {
  loginIpRateLimit,
  loginNetworkLockoutKey,
  recoveryGetKeyIpRateLimit,
  recoveryNetworkLockoutKeys,
  recoveryResetIpRateLimit,
  registerIpRateLimit,
  resendVerifyIpRateLimit,
  tokenLoginIpRateLimit,
  verifyEmailIpRateLimit,
} from '../slices/identity/index.js';
import {
  CHAT_GUEST_SEND_IP_RATE_LIMIT,
  CHAT_STOP_IP_RATE_LIMIT,
  CHAT_TRIAL_WEBSOCKET_IP_RATE_LIMIT,
  trialQuotaIpKey,
} from '../slices/chat/index.js';
import {
  adminDashboardRateLimit,
  adminJobQueueRateLimit,
  adminOpsRateLimit,
} from '../slices/admin/index.js';
import {
  guestConversationIpRateLimit,
  publicShareReadRateLimit,
} from '../slices/conversations/index.js';
import { deleteKeysMatching } from '../lib/redis/index.js';
import { hmacRateLimitId, rateLimitKey } from '../lib/rate-limit/index.js';
import { MEDIA_RATE_LIMITS } from '../slices/media/index.js';
import { modelArtifactDownloadIpRateLimit } from '../slices/model-weights/index.js';
import { catalogListIpRateLimit } from '../slices/models/index.js';
import { bundleDownloadIpRateLimit } from '../slices/updates/index.js';
import type { Redis } from '@upstash/redis';
import type { ThrottleLimit } from '../lib/rate-limit/index.js';

interface RedisResetResult {
  deleted: number;
}

/**
 * Every key the given globs reach, gone.
 *
 * The walk runs inside Redis, so a reset costs one round trip for all its globs
 * together rather than one per page of the keyspace they cross. That is what
 * makes `resetUsageRateLimits` safe to run before every E2E test: driven from
 * the client, its cost rose with every unrelated key any other seed or suite
 * had left in the database.
 */
async function deleteRedisKeysByPrefixes(
  redis: Redis,
  prefixes: readonly string[]
): Promise<RedisResetResult> {
  return { deleted: await deleteKeysMatching(redis, prefixes) };
}

/**
 * The per-IP auth throttles, taken from the entries that define them rather
 * than respelled here, so a renamed key template cannot leave this reset
 * clearing a bucket nothing writes.
 *
 * Exported, with the glob lists and its usage counterpart, for the rate-limit
 * counter cross-check: a limiter cleared by name here is reachable by a reset
 * without appearing in any glob list, and a cross-check that read only the globs
 * would report it unclearable.
 */
export const AUTH_IP_THROTTLES: readonly ThrottleLimit[] = [
  loginIpRateLimit,
  registerIpRateLimit,
  recoveryResetIpRateLimit,
  recoveryGetKeyIpRateLimit,
  verifyEmailIpRateLimit,
  resendVerifyIpRateLimit,
  tokenLoginIpRateLimit,
];

/**
 * The key a per-IP throttle counts `callerIpId` under, through the encoder
 * `consume` itself keys with. Unwrapped because the encoder's one error arm is
 * an identifier past its length bound, and a caller IP id is one digest wide.
 */
function throttleKey(throttle: ThrottleLimit, callerIpId: string): string {
  return rateLimitKey(throttle, callerIpId)._unsafeUnwrap();
}

/**
 * One account the auth reset has been asked to clear: the identifier in the
 * form the limiters key it (`canonicalIdentifier` — emails lowercased,
 * usernames normalized), and the account it resolves to when it resolves to
 * one. `userId` is null for an identifier that names no account, which is a
 * legitimate subject rather than an error: the registration and resend
 * throttles key on an email address, and an address exists before its account
 * does.
 */
export interface AuthResetIdentity {
  readonly canonical: string;
  readonly userId: string | null;
}

/**
 * Every auth counter key one named account can carry.
 *
 * Written as templates rather than through each limiter's `buildKey` because
 * the identity slice publishes its per-IP throttle entries and not its lockout
 * registry, and widening that published surface is a reviewed edit this file
 * does not get to make. Each template is completed with the identifier's keyed
 * digest ({@link hmacRateLimitId}), the same suffix `consume` writes. The drift
 * that would otherwise cost is caught: the
 * rate-limit counter cross-check asserts that every declared counter's key
 * prefix is reached by some reset target, so a renamed template leaves this
 * list clearing a bucket nothing writes AND fails that check.
 *
 * `loginLockout` appears twice on purpose. It keys on the resolved user id when
 * the identifier names an account and on the canonical identifier when it names
 * none, and a reset that guessed which one applies would leave the other
 * standing.
 *
 * The email-keyed throttles are named for every identifier, username-shaped
 * ones included. A username can carry no `register:email` key, so the delete is
 * a no-op there — cheaper than a branch that has to restate which identifier
 * shapes reach an email throttle.
 *
 * Exported for the rate-limit counter cross-check alongside the per-IP throttle
 * lists: these templates and the limiter entries they name are two statements
 * that must agree, and nothing else ties them together.
 *
 * The per-network lockouts — login's and recovery's two — are the counters here
 * not spelled as templates, because each identifier is a DIGEST of the account
 * and the calling address rather than a value the request carries. They are
 * named through the slice's own derivations for that reason: a second spelling
 * of which parts go into a digest would delete a key nothing writes, and a
 * cross-check that compares key prefixes could not see the difference. They are
 * also the keys here scoped by BOTH dimensions at once, so each is cleared for
 * the calling address and the named account together, exactly as its flow
 * spends it. Recovery's pair takes only the canonical identifier, never the user
 * id: every recovery response is identical by design, so those windows key on
 * what the caller named and never on the account it resolved to.
 */
export async function authResetKeys(
  identity: AuthResetIdentity,
  callerIpId: string
): Promise<readonly string[]> {
  const byIdentifier = [
    keyed('ratelimit:identity:login:lockout:', identity.canonical),
    keyed('ratelimit:identity:recovery-getkey:lockout:', identity.canonical),
    keyed('ratelimit:identity:recovery-reset:lockout:', identity.canonical),
    keyed('ratelimit:identity:register:email:', identity.canonical),
    keyed('ratelimit:identity:resend-verify:email:', identity.canonical),
    await loginNetworkLockoutKey(identity.canonical, callerIpId),
    ...(await recoveryNetworkLockoutKeys(identity.canonical, callerIpId)),
  ];
  if (identity.userId === null) return byIdentifier;
  return [
    ...byIdentifier,
    keyed('ratelimit:identity:login:lockout:', identity.userId),
    keyed('ratelimit:identity:totp:lockout:', identity.userId),
    keyed('ratelimit:identity:step-up:lockout:', identity.userId),
    keyed('ratelimit:identity:delete-account:lockout:', identity.userId),
    keyed('ratelimit:identity:delete-account:init-lockout:', identity.userId),
    await loginNetworkLockoutKey(identity.userId, callerIpId),
  ];
}

/** A counter key template completed with the identifier's keyed digest. */
function keyed(prefix: string, identifier: string): string {
  return `${prefix}${hmacRateLimitId(identifier)}`;
}

/**
 * The globs the trial reset wipes for every identity: the global daily trial
 * spend cap and the per-session quota counters (see `USAGE_RESET_PREFIXES`).
 */
export const TRIAL_RESET_PREFIXES: readonly string[] = [
  'trial:*',
  'ratelimit:chat:trial-quota:session:*',
];

/**
 * Reset trial usage for testing. The 5/day quota counts through the rate-limit
 * primitive on two identities, and they are cleared at two different scopes:
 * the per-IP counter for `callerIpId` ALONE, the per-session counters for every
 * session (their identity is a trial token this endpoint never sees). The
 * `trial:` prefix covers the global daily trial spend cap, which carries no IP
 * component and cannot be narrowed. Every window here is a whole UTC day, which
 * no run can wait out.
 *
 * The per-IP scoping only works because the caller that clears is the caller
 * that spends: the reset and the trial sends must present the same address, or
 * the reset clears a window nothing spent.
 *
 * The per-IP counter is cleared through the limiter's own day-scoped key
 * derivation rather than by a glob, so it reaches no prefix list (see
 * `AUTH_IP_THROTTLES`).
 *
 * Not covered: the trial send's per-IP abuse throttle
 * (`ratelimit:chat:trial-send:ip:*`), left to its own 60 s expiry rather than
 * cleared here; the specs that must not collide on it carry a distinct
 * `cf-connecting-ip` instead.
 */
export async function resetTrialUsage(redis: Redis, callerIpId: string): Promise<RedisResetResult> {
  const shared = await deleteRedisKeysByPrefixes(redis, TRIAL_RESET_PREFIXES);
  // Through the counter's own derivation, never a respelled template: the day
  // scoping lives with the limiter, and a cleanup that wrote its own copy has
  // already gone stale here once. Unwrapped rather than handled because the one
  // error arm is an identifier past 256 characters, and this identifier is a
  // UTC day plus a 64-character digest — unreachable by construction, not by
  // luck. If it ever fired, the dev route answers `unavailable`.
  const mine = await redis.del(trialQuotaIpKey(new Date(), callerIpId)._unsafeUnwrap());
  return { deleted: shared.deleted + mine };
}

/**
 * Reset auth-related rate limits, lockouts and TOTP replay markers for the
 * caller's address and for the accounts the caller named — nothing else.
 *
 * Every dimension of the reach is named by the request — the per-IP throttles
 * are cleared for `callerIpId` ALONE, keyed exactly as the limiter keys them,
 * so a caller presenting its own `cf-connecting-ip` neither spends nor clears
 * another caller's window, and the account counters are cleared for
 * `identities` alone. There is no unnamed dimension, which is the point. This
 * endpoint is driven from Playwright workers and from api integration tests
 * against one shared Redis, and while it globbed, any caller's reset deleted
 * counters another caller was mid-way through counting.
 *
 * The one surviving glob is per-account: a TOTP replay marker carries the code
 * in its key, so the codes cannot be named, but the account can.
 *
 * The per-IP keys are built through each entry's own definition and the
 * encoder `consume` keys with, so each is the key the limiter spends.
 */
export async function resetAuthRateLimits(
  redis: Redis,
  callerIpId: string,
  identities: readonly AuthResetIdentity[]
): Promise<RedisResetResult> {
  const replayMarkers = identities
    .filter((identity) => identity.userId !== null)
    .map((identity) => `totp:used:${String(identity.userId)}:*`);
  const markers = await deleteRedisKeysByPrefixes(redis, replayMarkers);
  const accountKeys = await Promise.all(
    identities.map((identity) => authResetKeys(identity, callerIpId))
  );
  const named = await redis.del(
    ...AUTH_IP_THROTTLES.map((throttle) => throttleKey(throttle, callerIpId)),
    ...accountKeys.flat()
  );
  return { deleted: markers.deleted + named };
}

/**
 * The per-IP windows on the usage surfaces, taken from the entries that define
 * them: the unauthenticated share presign and share read caps, the
 * pre-resolution caps a sessionless caller meets on the guest-reachable
 * conversation, send and stop paths, and the caps on the three surfaces an
 * anonymous caller reaches with no credential at all — the model catalog, the
 * OTA bundle download and the trial websocket upgrade.
 */
export const USAGE_IP_THROTTLES: readonly ThrottleLimit[] = [
  MEDIA_RATE_LIMITS.sharePresignIpRateLimit,
  publicShareReadRateLimit,
  guestConversationIpRateLimit,
  CHAT_GUEST_SEND_IP_RATE_LIMIT,
  CHAT_STOP_IP_RATE_LIMIT,
  CHAT_TRIAL_WEBSOCKET_IP_RATE_LIMIT,
  catalogListIpRateLimit,
  modelArtifactDownloadIpRateLimit,
  bundleDownloadIpRateLimit,
];

/**
 * The globs the usage reset wipes for every identity: a reset request carries
 * none of the identities these keys are built from, so nothing in one can
 * narrow them.
 *
 * Exported, with the per-IP throttle lists and `authResetKeys`, for the
 * rate-limit counter cross-check: these lists and the limiter entries they name
 * are two statements that must agree, and nothing else ties them together. A
 * per-caller counter no list reaches cannot be cleared at all — it also never
 * clears on success — so an identity that spends its window stays refused for
 * the window's full length, and the refusal surfaces far from whatever added
 * the limiter.
 */
export const USAGE_RESET_PREFIXES: readonly string[] = [
  'ratelimit:chat:stream:user:*',
  'ratelimit:media:download:user:*',
  'ratelimit:media:share-presign:remint:*',
  // Authenticated per-caller share-creation limiter (`shareCreateRateLimit`).
  'ratelimit:conversations:share-create:user:*',
  // Authenticated per-account batch keychain limiter (`memberKeysBatchRateLimit`).
  'ratelimit:conversations:member-keys:user:*',
  // Authenticated per-account shared-link mint limiter (`linkCreateRateLimit`).
  'ratelimit:conversations:link-create:user:*',
];

/**
 * Reset usage-surface rate limits between tests.
 *
 * Two dimensions, two scopes, exactly as the auth reset splits them: the
 * per-IP windows are cleared for `callerIpId` ALONE, so one caller's reset can
 * no longer free — or race — the windows another is spending; the per-account,
 * per-caller and per-share prefixes below are wiped for every identity, because
 * a reset request carries none of those identities. A caller that must clear a
 * guest's windows presents that guest's address, which is what the E2E
 * identities are derived per project and worker to make possible.
 *
 * Deliberately does NOT clear `billing:admission:*`: that state (per-wallet
 * holds + balance snapshots + scope counters) is global across every wallet, so
 * a per-test wipe under parallel Playwright workers races another worker's live
 * admission — deleting its snapshot mid-flow forces the fail-closed admission
 * script to refuse with a false INSUFFICIENT_ADMISSION. Admission state starts
 * a run clean because of the E2E bring-up's flush of that stack's Redis database
 * locally, and a CI runner's empty Redis in CI; during the run, per-worker
 * wallet isolation + the hold/snapshot TTLs keep it clean.
 */
export async function resetUsageRateLimits(
  redis: Redis,
  callerIpId: string
): Promise<RedisResetResult> {
  const shared = await deleteRedisKeysByPrefixes(redis, USAGE_RESET_PREFIXES);
  const mine = await redis.del(
    ...USAGE_IP_THROTTLES.map((throttle) => throttleKey(throttle, callerIpId))
  );
  return { deleted: shared.deleted + mine };
}

/**
 * The glob the admin-dashboard reset wipes, built from the limiter's own
 * `buildKey` rather than respelled, so a renamed key template cannot leave this
 * reset clearing a bucket nothing writes.
 *
 * Exported for the rate-limit counter cross-check alongside the auth and usage
 * lists, which is what lets that check see this counter as clearable.
 */
export const ADMIN_DASHBOARD_RESET_PREFIXES: readonly string[] = [
  adminDashboardRateLimit.buildKey('*'),
];

/**
 * Clear the admin dashboard's read-volume window for every actor. Global by
 * design, so never run per test (see
 * `resetUsageRateLimits` for what a per-test global wipe costs under parallel
 * workers) — the cap keys on a hashed Access actor, an identity no caller
 * presents to this endpoint, so nothing here can be caller-scoped the way the
 * per-IP resets are.
 *
 * Source of truth for why this window has a reset; the E2E sites that spend it
 * and the test sites that clear or assert it cite this docblock rather than
 * restating the reason. The
 * admin browser fixture's landing navigation renders the console dashboard
 * before a spec's first line (`e2e/admin/fixtures.ts`), so every spec taking
 * that fixture spends this window whatever it is testing, and the total
 * accrues with the suite's size. It is a throttle, so it clears on no success
 * and `clear` cannot reach it; without a reset a crossing would refuse
 * the console's landing page for the rest of the hour, with no way back under
 * it.
 */
export async function resetAdminDashboardReads(redis: Redis): Promise<RedisResetResult> {
  return deleteRedisKeysByPrefixes(redis, ADMIN_DASHBOARD_RESET_PREFIXES);
}

/**
 * The glob the admin job-queue reset wipes, built from the limiter's own
 * `buildKey` rather than respelled, so a renamed key template cannot leave this
 * reset clearing a bucket nothing writes. It is its own list rather than a
 * widening of the dashboard's: one glob spanning both windows would let either
 * counter's obligation to the rate-limit counter cross-check be answered by the
 * other's reset, and the check's red is what says a counter is unclearable.
 *
 * Exported for that cross-check alongside the auth and usage lists.
 */
export const ADMIN_JOB_QUEUE_RESET_PREFIXES: readonly string[] = [
  adminJobQueueRateLimit.buildKey('*'),
];

/**
 * Clear the admin job-queue read window for every actor. Global by design, so
 * never run per test, for the reason
 * `resetAdminDashboardReads` states about the admin caps generally: the key is
 * a hashed Access actor, an identity no caller presents to this endpoint, so
 * nothing here can be caller-scoped the way the per-IP resets are.
 *
 * Why this window has a reset of its own: a jobs read is a PAGE, and the specs
 * that look a row up walk pages until they find it (`e2e/admin/helpers/jobs.ts`
 * pages both its UI and its API path), so one lookup can spend many of the
 * window on the dev actor driving it — and the two halves need not run under
 * one actor, so a spec driving both spends two actors' windows. It is a
 * throttle, so it clears on no success and `clear` cannot reach it; without
 * a reset a crossing would refuse the console's jobs screen for the rest
 * of the hour, with no way back under it.
 */
export async function resetAdminJobQueueReads(redis: Redis): Promise<RedisResetResult> {
  return deleteRedisKeysByPrefixes(redis, ADMIN_JOB_QUEUE_RESET_PREFIXES);
}

/**
 * The glob the admin ops reset wipes, built from the limiter's own `buildKey`
 * rather than respelled, so a renamed key template cannot leave this reset
 * clearing a bucket nothing writes.
 *
 * It is narrow — at this counter's own key prefix, never a parent namespace —
 * because narrowness is what the rate-limit counter cross-check can see: it
 * asks whether some declared target STARTS WITH a counter's own key prefix, and
 * `ratelimit:admin:*` starts with the prefix of no admin counter at all. One
 * glob spanning the admin namespace would therefore earn credit for none of
 * them while deleting all their windows, and the check would name only those
 * that have resets: a counter whose exemption says no reset clears it is
 * filtered out of that assertion, and the staleness assertion cannot catch it
 * either — that one flags an exemption only when a reset DOES reach its
 * counter. Those windows would be swept in silence.
 *
 * Exported for the rate-limit counter cross-check alongside the auth and usage
 * lists.
 */
export const ADMIN_OPS_RESET_PREFIXES: readonly string[] = [adminOpsRateLimit.buildKey('*')];

/**
 * Clear the admin operations window — shared by op preview and execute — for
 * every actor. Global by design, so never run per test, for the reason
 * `resetAdminDashboardReads` states about the admin caps generally: the key is
 * a hashed Access actor, an identity no caller
 * presents to this endpoint, so nothing here can be caller-scoped the way the
 * per-IP resets are.
 *
 * Why this window has a reset of its own: the admin suite seeds audit rows
 * through the op engine itself, one execute per seeded row
 * (`e2e/admin/helpers/audit.ts`), so one spec's seed count alone is a large
 * share of the hourly cap on a single actor — and preview and execute share
 * the window, so neither is the free half. It is a throttle, so it clears on
 * no success and `clear` cannot reach it; without a reset the window
 * accrues until a crossing refuses every op preview and execute
 * for the rest of its hour, with no way back under it.
 */
export async function resetAdminOpsRuns(redis: Redis): Promise<RedisResetResult> {
  return deleteRedisKeysByPrefixes(redis, ADMIN_OPS_RESET_PREFIXES);
}

/**
 * Delete a user's TOTP replay markers (`totp:used:{userId}:{code}`) so a
 * previously-accepted code can be presented again without waiting for the
 * next 30-second window. The markers enforce one-time use; clearing them
 * lets a flow reuse the current code while the real replay check and crypto
 * verification still run against it.
 */
export async function clearTotpReplayMarkers(
  redis: Redis,
  userId: string
): Promise<RedisResetResult> {
  return deleteRedisKeysByPrefixes(redis, [`totp:used:${userId}:*`]);
}
