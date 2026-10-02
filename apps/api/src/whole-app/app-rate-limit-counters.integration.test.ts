import { describe, expect, it } from 'vitest';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { createApp } from '../app.js';
import { ROUTE_POSTURES } from '../composition/rate-limit-posture.js';
import {
  ADMIN_DASHBOARD_RESET_PREFIXES,
  ADMIN_JOB_QUEUE_RESET_PREFIXES,
  ADMIN_OPS_RESET_PREFIXES,
  AUTH_IP_THROTTLES,
  TRIAL_RESET_PREFIXES,
  USAGE_IP_THROTTLES,
  USAGE_RESET_PREFIXES,
  authResetKeys,
} from '../dev/redis-resets.js';
import { registeredRouteKeys } from '../lib/context/index.js';
import { CLASS_DEFAULTS, hmacRateLimitId } from '../lib/rate-limit/index.js';
import { roadmapIpRateLimit, statsIpRateLimit } from '../lib/redis/index.js';
import { growthBeaconIpRateLimit } from '../slices/growth/index.js';
import { userSearchRateLimit } from '../slices/account/index.js';
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
import {
  CHAT_GUEST_SEND_IP_RATE_LIMIT,
  CHAT_STOP_IP_RATE_LIMIT,
  CHAT_STREAM_USER_RATE_LIMIT,
  CHAT_TRIAL_WEBSOCKET_IP_RATE_LIMIT,
  trialQuotaIpKey,
} from '../slices/chat/index.js';
import {
  CHAT_TRIAL_REMAINING_IP_RATE_LIMIT,
  CHAT_TRIAL_SEND_IP_RATE_LIMIT,
} from '../slices/chat/domain/rate-limit.js';
import {
  TRIAL_QUOTA_IP_RATE_LIMIT,
  TRIAL_QUOTA_SESSION_RATE_LIMIT,
} from '../slices/chat/domain/trial/quota.js';
import {
  guestConversationIpRateLimit,
  linkCreateRateLimit,
  memberKeysBatchRateLimit,
  publicShareReadRateLimit,
  shareCreateRateLimit,
} from '../slices/conversations/index.js';
import { BILLING_RATE_LIMITS } from '../slices/billing/index.js';
import {
  feedbackSubmitHourlyRateLimit,
  feedbackSubmitRateLimit,
} from '../slices/feedback/index.js';
import {
  loginIpRateLimit,
  recoveryGetKeyIpRateLimit,
  recoveryResetIpRateLimit,
  registerIpRateLimit,
  resendVerifyIpRateLimit,
  tokenLoginIpRateLimit,
  verifyEmailIpRateLimit,
} from '../slices/identity/index.js';
import { IDENTITY_KEYS } from '../slices/identity/domain/keys.js';
import { MEDIA_RATE_LIMITS } from '../slices/media/index.js';
import { modelArtifactDownloadIpRateLimit } from '../slices/model-weights/index.js';
import { catalogListIpRateLimit } from '../slices/models/index.js';
import {
  newsletterConfirmIpRateLimit,
  newsletterSubscribeIpRateLimit,
  newsletterUnsubscribeIpRateLimit,
} from '../slices/newsletter/index.js';
import { bundleDownloadIpRateLimit } from '../slices/updates/index.js';
import type { RateLimitDefinition } from '../lib/rate-limit/index.js';
import type { Redis } from '@upstash/redis';

/**
 * # The rate-limit counters this api declares, and what must hold across them
 *
 * Two subjects, and the difference between them is the design.
 *
 * `DECLARED_LIMITS` is every entry the api declares, bound by the compiler to
 * the objects the slices export, so the properties below hold for counters no
 * route spends at the pipeline edge as well as for the ones it does. It is a
 * list, which is what an inventory deleted from here for being hand-maintained
 * also was; what makes this one different is that the arch rule
 * `rate-limit-entries-reach-the-cross-check` reports in BOTH directions against
 * it — an entry declared anywhere in the api and missing here fails
 * `arch:check`, and a name here that no declaration answers fails it too. What
 * the rule proves is that the list is COMPLETE. It cannot prove that any case
 * below says anything about a member, which is the same ceiling
 * `single-writer-per-table` has over its own map.
 *
 * The class defaults join the subject derived rather than listed: the compiler
 * holds `CLASS_DEFAULTS` total over the route classes, so reading that map
 * whole carries the same completeness the rule carries for the rest.
 *
 * The second subject is the assembled router. Walking the routes the
 * composition root mounts, resolving each route's declaration and spending its
 * bound against a recording Redis answers the key, cap and window the pipeline
 * WOULD use — which no list can answer, because a bound counting capability
 * closes over its entry and the values reach the primitive as script arguments.
 * It is also the only direction that can find a counter no declaration named,
 * and it asserts exactly that below.
 *
 * ## Why no reservation is counted at the edge
 *
 * Not because the pipeline cannot reach a user: the TOTP, step-up and both
 * delete-account lockouts key on a resolved `userId`, which is a
 * `PostureIdentity`. It is that a reservation is spent on a GUESS and released
 * on a verified success, and only the flow that checks the secret knows which
 * of the two just happened. Where the identity is out of the pipeline's reach
 * as well, it is deliberately so: the recovery lockouts key on what the caller
 * supplied — the lowercased identifier, alone or composited with the caller's
 * network — and never on an account, because every recovery response is
 * identical by design, and `loginLockout` keys on the resolved user when the
 * identifier names an account and on that same lowercased identifier when it
 * names none.
 */

/**
 * A sample identifier that survives every entry's own canonicalization
 * unchanged (already lowercase, no delimiter). A key the pipeline spends
 * carries its keyed digest rather than the sample itself, which
 * {@link recordingRedis} maps back, so a built or recovered key differs from a
 * written template only where the entry's own `buildKey` does.
 */
const SAMPLE_ID = '{id}';

/** `toSorted` needs an explicit collation comparator (sonarjs/no-alphabetical-sort). */
const byText = (a: string, b: string): number => a.localeCompare(b);

/**
 * Every rate-limit entry declared in the api, named as the arch rule names its
 * declaration: a top-level const by its own name, one held in a map by the
 * property that holds it. Nothing is inferred from a name — each value is the
 * entry itself, so every property below reads the object the slice exports.
 */
const DECLARED_LIMITS: Readonly<Record<string, RateLimitDefinition>> = {
  loginIpRateLimit,
  registerIpRateLimit,
  recoveryResetIpRateLimit,
  recoveryGetKeyIpRateLimit,
  verifyEmailIpRateLimit,
  resendVerifyIpRateLimit,
  tokenLoginIpRateLimit,
  loginLockout: IDENTITY_KEYS.loginLockout,
  loginLockoutPerNetwork: IDENTITY_KEYS.loginLockoutPerNetwork,
  registerRateLimit: IDENTITY_KEYS.registerRateLimit,
  resendVerifyRateLimit: IDENTITY_KEYS.resendVerifyRateLimit,
  verifyTokenRateLimit: IDENTITY_KEYS.verifyTokenRateLimit,
  recoveryGetKeyLockout: IDENTITY_KEYS.recoveryGetKeyLockout,
  recoveryGetKeyLockoutPerNetwork: IDENTITY_KEYS.recoveryGetKeyLockoutPerNetwork,
  recoveryResetLockout: IDENTITY_KEYS.recoveryResetLockout,
  recoveryResetLockoutPerNetwork: IDENTITY_KEYS.recoveryResetLockoutPerNetwork,
  twoFactorLockout: IDENTITY_KEYS.twoFactorLockout,
  twoFactorCeiling: IDENTITY_KEYS.twoFactorCeiling,
  deleteAccountLockout: IDENTITY_KEYS.deleteAccountLockout,
  deleteAccountInitLockout: IDENTITY_KEYS.deleteAccountInitLockout,
  stepUpLockout: IDENTITY_KEYS.stepUpLockout,
  publicShareReadRateLimit,
  guestConversationIpRateLimit,
  memberKeysBatchRateLimit,
  shareCreateRateLimit,
  linkCreateRateLimit,
  cardChargeIpRateLimit: BILLING_RATE_LIMITS.cardChargeIpRateLimit,
  cardChargeAccountRateLimit: BILLING_RATE_LIMITS.cardChargeAccountRateLimit,
  balanceReadRateLimit: BILLING_RATE_LIMITS.balanceReadRateLimit,
  mediaDownloadUserRateLimit: MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit,
  mediaDownloadGuestIpRateLimit: MEDIA_RATE_LIMITS.mediaDownloadGuestIpRateLimit,
  mediaDownloadLinkMintRateLimit: MEDIA_RATE_LIMITS.mediaDownloadLinkMintRateLimit,
  mediaDownloadLinkLookupRateLimit: MEDIA_RATE_LIMITS.mediaDownloadLinkLookupRateLimit,
  sharePresignIpRateLimit: MEDIA_RATE_LIMITS.sharePresignIpRateLimit,
  sharePresignRemintRateLimit: MEDIA_RATE_LIMITS.sharePresignRemintRateLimit,
  CHAT_STREAM_USER_RATE_LIMIT,
  CHAT_GUEST_SEND_IP_RATE_LIMIT,
  CHAT_STOP_IP_RATE_LIMIT,
  CHAT_TRIAL_SEND_IP_RATE_LIMIT,
  CHAT_TRIAL_REMAINING_IP_RATE_LIMIT,
  CHAT_TRIAL_WEBSOCKET_IP_RATE_LIMIT,
  TRIAL_QUOTA_SESSION_RATE_LIMIT,
  TRIAL_QUOTA_IP_RATE_LIMIT,
  adminCustomer360RateLimit,
  adminAuditSearchRateLimit,
  adminDashboardRateLimit,
  adminFeedbackRateLimit,
  adminJobQueueRateLimit,
  adminNewsletterSubscribersRateLimit,
  adminOpsRateLimit,
  adminSqlPanelRateLimit,
  userSearchRateLimit,
  feedbackSubmitRateLimit,
  feedbackSubmitHourlyRateLimit,
  newsletterSubscribeIpRateLimit,
  newsletterConfirmIpRateLimit,
  newsletterUnsubscribeIpRateLimit,
  roadmapIpRateLimit,
  statsIpRateLimit,
  growthBeaconIpRateLimit,
  catalogListIpRateLimit,
  modelArtifactDownloadIpRateLimit,
  bundleDownloadIpRateLimit,
};

/**
 * The class defaults, named after the route class each one backs. Derived from
 * the map rather than listed beside the declarations above, because the
 * compiler already refuses a route class with no row — so a class added to
 * `ROUTE_CLASSES` joins this subject by existing.
 */
const CLASS_DEFAULT_COUNTERS: readonly (readonly [string, RateLimitDefinition])[] = Object.entries(
  CLASS_DEFAULTS
).map(([routeClass, classDefault]) => [`classDefault:${routeClass}`, classDefault.definition]);

/** Every counter in subject: the declared entries and the class defaults. */
const SUBJECT: readonly (readonly [string, RateLimitDefinition])[] = [
  ...Object.entries(DECLARED_LIMITS),
  ...CLASS_DEFAULT_COUNTERS,
];

/**
 * One counter as this file recovers it: a key, its cap, its window. A named
 * limit's key is the one the pipeline spends. A class default's is not — the
 * pipeline qualifies it per route before spending — so what is recovered here
 * is the CLASS-WIDE key, whose identifier-stripped prefix ({@link keyPrefix})
 * every per-route counter of that class begins with. That prefix is the only
 * part any check below reads out of a key.
 */
interface SpentCounter {
  readonly key: string;
  readonly maxAttempts: number;
  readonly windowSeconds: number;
}

/** One counter as one comparable string: what it keys, and the bound it spends. */
function sized(counter: SpentCounter): string {
  return `${counter.key} at ${String(counter.maxAttempts)}/${String(counter.windowSeconds)}`;
}

/**
 * A Redis double that keeps the script's ARGUMENTS as well as its keys. The
 * shared `scriptedRateLimitRedis` keeps only the keys, which is all a
 * behavioural test needs and is not enough here: the cap and the window reach
 * the primitive as ARGV and are recoverable nowhere else, because a bound
 * counting capability closes over its entry and JavaScript offers no
 * reflection over a closure's captures. Each key is recorded with the sample
 * identifier's keyed digest mapped back to {@link SAMPLE_ID}.
 */
function recordingRedis(recorded: SpentCounter[]): Redis {
  return {
    createScript: () => ({
      exec: (keys: string[], args: string[]) => {
        for (const [index, key] of keys.entries()) {
          recorded.push({
            key: key.replaceAll(hmacRateLimitId(SAMPLE_ID), SAMPLE_ID),
            maxAttempts: Number(args[index * 2]),
            windowSeconds: Number(args[index * 2 + 1]),
          });
        }
        return Promise.resolve('allowed:0:1:0');
      },
    }),
  } as unknown as Redis;
}

/**
 * Every counter the assembled app spends at the pipeline edge, plus one row per
 * class default. A named row is recovered by driving that route's own bound. A
 * class-default row is the CLASS-WIDE entry rather than the per-route counter
 * the pipeline spends, and {@link SUBJECT} is built from the same entries, so
 * the two halves agree on that dimension by construction and nothing here says
 * anything about the route component of a class-default key.
 *
 * One key can arrive several times — a cap shared by a slice's routes is spent
 * on each of them — so this answers occurrences, and the checks below dedupe
 * where the property is about the counter rather than about a route.
 */
async function spentCounters(): Promise<readonly SpentCounter[]> {
  const recorded: SpentCounter[] = [];
  for (const routeKey of registeredRouteKeys(createApp().routes)) {
    const posture = ROUTE_POSTURES[routeKey];
    if (posture?.kind !== 'named') continue;
    const edge = posture.countAtEdge;
    if (edge === undefined) continue;
    await edge
      .count(
        recordingRedis(recorded),
        edge.keyedBy.map(() => SAMPLE_ID)
      )
      .match(
        () => undefined,
        (error) => {
          // The double admits every check, so the refused arm is unreachable
          // and an error means the recovery itself broke — which must not
          // reach the assertions as a route that simply spent nothing.
          throw new Error(`recovering ${routeKey}'s bound failed: ${error.code}`);
        }
      );
  }
  for (const classDefault of Object.values(CLASS_DEFAULTS)) {
    recorded.push({
      key: classDefault.definition.buildKey(SAMPLE_ID),
      maxAttempts: classDefault.definition.maxAttempts,
      windowSeconds: classDefault.definition.windowSeconds,
    });
  }
  return recorded;
}

/**
 * Every key string a retired counting mechanism could write: the pre-migration
 * registry's, transcribed from the commit that carried the read-then-write
 * limiters, plus the trial quota's two, which counted through their own atomic
 * `INCR` and so migrated later than the rest. It is a frozen historical record,
 * never regenerated from the live entries: its whole job is to be INDEPENDENT
 * of them.
 *
 * Reusing one of these strings is a production outage, not a style problem. The
 * value living under such a key was written by a retired mechanism, and for
 * most of them it is a JSON object rather than a number. An `INCR` against a
 * JSON value errors, the limiter fails closed, AND the key keeps its TTL — so
 * every caller on that surface gets a 503 until the window expires, up to a
 * full hour on the identity, admin, feedback and newsletter hourly entries.
 * The two trial keys are the quieter case: they already held integers, so a
 * reuse would not error — it would silently resume a stale day's count.
 */
const PRE_MIGRATION_KEYS: readonly string[] = [
  'login:ip:ratelimit:{id}',
  'register:ip:ratelimit:{id}',
  'recovery:ip:ratelimit:{id}',
  'recovery:getkey:ip:ratelimit:{id}',
  'verify:ip:ratelimit:{id}',
  'resend-verify:ip:ratelimit:{id}',
  'login:lockout:{id}',
  'register:email:ratelimit:{id}',
  'resend-verify:email:ratelimit:{id}',
  'verify:token:ratelimit:{id}',
  'recovery:getkey:lockout:{id}',
  'recovery:reset:lockout:{id}',
  '2fa:lockout:{id}',
  'delete-account:lockout:{id}',
  'conversations:share:read:ip:ratelimit:{id}',
  'conversations:guest:ip:ratelimit:{id}',
  'share:create:user:ratelimit:{id}',
  'media:download:user:ratelimit:{id}',
  'media:download:guest:ip:ratelimit:{id}',
  'media:download:link:mint:ratelimit:{id}',
  'media:download:link:lookup:ratelimit:{id}',
  'media:share:presign:ip:ratelimit:{id}',
  'media:share:presign:remint:ratelimit:{id}',
  'chat:stream:user:ratelimit:{id}',
  'chat:guest:send:ip:ratelimit:{id}',
  'chat:stop:ip:ratelimit:{id}',
  'chat:trial:send:ip:ratelimit:{id}',
  'trial:usage:session:{id}',
  'trial:usage:ip:{id}',
  'admin:read:360:ratelimit:{id}',
  'admin:read:audit:ratelimit:{id}',
  'admin:read:feedback:ratelimit:{id}',
  'admin:read:nlsubs:ratelimit:{id}',
  'admin:read:sql:ratelimit:{id}',
  'feedback:submit:user:ratelimit:{id}',
  'feedback:submit:user:hourly:ratelimit:{id}',
  'newsletter:subscribe:ip:ratelimit:{id}',
  'newsletter:confirm:ip:ratelimit:{id}',
  'newsletter:unsubscribe:ip:ratelimit:{id}',
  'roadmap:ip:ratelimit:{id}',
  'stats:ip:ratelimit:{id}',
];

/**
 * Every Redis target a dev reset deletes: the globs each reset wipes for every
 * identity, and the concrete key each reset names — for the calling identity
 * through the limiter's own `buildKey`, and for the auth reset's subject
 * accounts through `authResetKeys`. Read from the module that owns the resets
 * rather than respelled, so this cross-check measures the reset that runs. A
 * limiter cleared by name reaches no glob list, so a check reading only the
 * globs would report live entries as unclearable. The trial quota's per-IP
 * counter is reached through its own day-scoped derivation, which is the only
 * way to name that key.
 *
 * The auth reset is asked for one identity that resolves to an account, since
 * that is the case whose key set is total: an unresolved identifier carries
 * only identifier-keyed counters, so asking with one would report the per-user
 * lockouts as unclearable.
 */
const RESET_TARGETS: readonly string[] = [
  ...ADMIN_DASHBOARD_RESET_PREFIXES,
  ...ADMIN_JOB_QUEUE_RESET_PREFIXES,
  ...ADMIN_OPS_RESET_PREFIXES,
  ...(await authResetKeys({ canonical: SAMPLE_ID, userId: SAMPLE_ID }, SAMPLE_ID)),
  ...USAGE_RESET_PREFIXES,
  ...TRIAL_RESET_PREFIXES,
  ...AUTH_IP_THROTTLES.map((throttle) => throttle.buildKey(SAMPLE_ID)),
  ...USAGE_IP_THROTTLES.map((throttle) => throttle.buildKey(SAMPLE_ID)),
  trialQuotaIpKey(new Date(TEST_DAY_START), SAMPLE_ID)._unsafeUnwrap(),
];

/**
 * Why every class default stands without a reset, written once because it is
 * one fact about the mechanism rather than six about the caps: a class default
 * is spent on a counter of its own per route, and every cap is a BACKSTOP
 * roughly an order of magnitude above what the population its key stands for
 * does on one route — the statement `lib/rate-limit/class-default.ts` makes
 * over the whole table, ahead of the per-row reasoning. Two of those
 * populations ARE this suite, and that file says so in those terms: `admin`,
 * whose workers act as one allowlisted actor, and `dev-only`, which no
 * production caller reaches. So nothing can be parked behind one of these
 * without having driven a single endpoint at that rate first. Sizing any row
 * down far enough for a flow to reach it falsifies this for all six at once,
 * which is why the rows below cite it rather than restating it — a reader
 * re-sizing the defaults meets one sentence to revisit.
 */
const CLASS_DEFAULT_IS_A_BACKSTOP =
  'a class default: a per-route backstop an order of magnitude above what the population its key stands for does on one route, so reaching it means a flow drove a single endpoint at that rate — the limiter exercising itself, not a flow stuck behind a window';

/**
 * Why both card-charge windows stand without a reset, written once because it
 * is one fact about the route rather than two about the caps. Neither half
 * turns on a cap's magnitude, which is why the rows below interpolate their
 * numbers from their entries and cite this rather than arguing beside them.
 * What it does turn on is the window: lengthening either entry's
 * `windowSeconds` falsifies "inside a minute" for both rows at once, so that
 * is the one sentence a re-sizer has to revisit.
 */
const CARD_CHARGE_WINDOW_STANDS_ALONE =
  'a spent window expires inside a minute, and a dev lever able to clear the bound on the one route that makes a real processor charge attempt is worth less than it costs';

/**
 * Why the balance read's window stands without a reset. Where
 * {@link CARD_CHARGE_WINDOW_STANDS_ALONE} turns on a window length, both halves
 * of this one turn on the cap's MAGNITUDE: the rate it works out to over its
 * window, and its distance above the post-charge confirmation poll that
 * `slices/billing/domain/rate-limit.ts` sizes the entry against. That is why it
 * lives here rather than beside the row's numeral — interpolation keeps the
 * numeral current, and a current numeral standing next to an argument the
 * re-size falsified hides the falsification instead of catching it. Re-sizing
 * the entry is what makes this the one sentence to revisit.
 */
const BALANCE_READ_CAP_IS_A_BACKSTOP =
  'a backstop above what the post-charge confirmation poll asks of one address, so reaching it means a flow drove that one endpoint at ten requests a second — the limiter exercising itself, not a flow stuck behind a window';

/**
 * Why the admin plane's unreset read windows stand without a reset, written
 * once because it is one fact about that surface rather than one per row. Its
 * identity clause is common ground the rows share outright; its window and cap
 * clauses turn on a MAGNITUDE, as in {@link BALANCE_READ_CAP_IS_A_BACKSTOP} —
 * an hour is a length, and a cap sized for a founder-admin working the console
 * is a distance above what one read surface is asked for, which
 * `slices/admin/domain/rate-limit.ts` argues. That is why those clauses live
 * here rather than beside each row's numerals: interpolation keeps a numeral
 * current, and a current numeral standing next to an argument the re-size
 * falsified hides the falsification instead of catching it.
 *
 * The rows citing it do not all sit at one cap, and none of them needs to:
 * reaching a LARGER cap is more of the bulk read this refuses, not less, so a
 * row above the smallest carries the sentence a fortiori. Sizing a row down far
 * enough for the console's own use to reach it is what falsifies this, which is
 * why the rows cite it rather than arguing beside their own numbers.
 */
const ADMIN_READ_CAP_IS_A_BACKSTOP =
  'keyed on a hashed Access actor rather than an identity a caller presents, so no reset could be scoped to the caller that spent it — an hour-long window at a cap sized for a founder-admin working the console, where reaching it is the bulk-read pattern the cap exists to refuse';

/**
 * Every counter no reset clears, each with the reason it can stand alone — the
 * only way out of the check below. The default for a new entry is a reset that
 * reaches it, not a line here: a throttle reserves nothing and clears on no
 * success, so a suite that spends the window has no way back under it before
 * the window expires, and the 429 lands wherever that suite happens to be.
 *
 * A reason has to say why that is tolerable for THIS counter. Shapes that
 * carry: reaching the cap would mean a flow was exercising the limiter itself;
 * or the identity is one a caller varies — an address, a link credential, a
 * single-use token — rather than an account a suite is stuck with.
 */
const NO_RESET_CLEARS: Readonly<Record<string, string>> = {
  'classDefault:public': CLASS_DEFAULT_IS_A_BACKSTOP,
  'classDefault:session': CLASS_DEFAULT_IS_A_BACKSTOP,
  'classDefault:pending-2fa': CLASS_DEFAULT_IS_A_BACKSTOP,
  'classDefault:billing-token': CLASS_DEFAULT_IS_A_BACKSTOP,
  'classDefault:dev-only': CLASS_DEFAULT_IS_A_BACKSTOP,
  'classDefault:admin': CLASS_DEFAULT_IS_A_BACKSTOP,
  userSearchRateLimit:
    'sixty DISTINCT search prefixes on one account inside a minute; the only caller is the invite box, one request per new prefix with repeats served from cache',
  feedbackSubmitRateLimit:
    'ten feedback rows inserted from one account inside a minute — the surface writes a row per attempt, so a flow at that rate is measuring the limiter',
  feedbackSubmitHourlyRateLimit: 'the same insert surface, over an hour-long window',
  verifyTokenRateLimit:
    'keyed on the verification token, an identity no reset can name — the endpoint never receives one; the token is single-use, so the counter it opens is addressed a handful of times and then expires with its window',
  adminCustomer360RateLimit: `the Customer-360 whole-customer loads at ${String(adminCustomer360RateLimit.maxAttempts)} in ${String(adminCustomer360RateLimit.windowSeconds)} s; ${ADMIN_READ_CAP_IS_A_BACKSTOP}`,
  adminAuditSearchRateLimit: `the audit-trail search reads at ${String(adminAuditSearchRateLimit.maxAttempts)} in ${String(adminAuditSearchRateLimit.windowSeconds)} s; ${ADMIN_READ_CAP_IS_A_BACKSTOP}`,
  adminFeedbackRateLimit: `the feedback triage reads at ${String(adminFeedbackRateLimit.maxAttempts)} in ${String(adminFeedbackRateLimit.windowSeconds)} s; ${ADMIN_READ_CAP_IS_A_BACKSTOP}`,
  adminNewsletterSubscribersRateLimit: `the subscriber consent-evidence pages at ${String(adminNewsletterSubscribersRateLimit.maxAttempts)} in ${String(adminNewsletterSubscribersRateLimit.windowSeconds)} s; ${ADMIN_READ_CAP_IS_A_BACKSTOP}`,
  adminSqlPanelRateLimit: `the SQL panel reads at ${String(adminSqlPanelRateLimit.maxAttempts)} in ${String(adminSqlPanelRateLimit.windowSeconds)} s; ${ADMIN_READ_CAP_IS_A_BACKSTOP}`,
  CHAT_TRIAL_SEND_IP_RATE_LIMIT:
    'keyed on the caller address, which a suite varies rather than waits out; the reset module records this one as deliberately left to its own 60 s expiry, and the specs that must not collide on it present a distinct address',
  CHAT_TRIAL_REMAINING_IP_RATE_LIMIT:
    'the same address identity on the remaining-count read, at 120 in 60 s — far above what a composer asks for, and expiring inside a minute',
  cardChargeIpRateLimit: `the card-charge address window at ${String(BILLING_RATE_LIMITS.cardChargeIpRateLimit.maxAttempts)} in ${String(BILLING_RATE_LIMITS.cardChargeIpRateLimit.windowSeconds)} s; ${CARD_CHARGE_WINDOW_STANDS_ALONE}`,
  cardChargeAccountRateLimit: `the per-account card-charge window at ${String(BILLING_RATE_LIMITS.cardChargeAccountRateLimit.maxAttempts)} in ${String(BILLING_RATE_LIMITS.cardChargeAccountRateLimit.windowSeconds)} s, on the same route and for the same reason`,
  mediaDownloadGuestIpRateLimit:
    "the guest download path's pre-resolution address window at 240 in 60 s; a guest that must start clean presents its own address, which is what per-worker caller identities exist for",
  mediaDownloadLinkMintRateLimit:
    'keyed on a resolved linkId at 1200 in 60 s — the identity is a link a flow mints fresh, so a spent window belongs to a link nothing addresses again',
  mediaDownloadLinkLookupRateLimit:
    'keyed on the link credential at 4800 in 60 s, the same fresh-per-link identity the mint window carries',
  newsletterSubscribeIpRateLimit:
    'per-address cap on the unauthenticated signup endpoint at 10 in 60 s; the identity is an address the caller varies, and the window expires inside a minute',
  newsletterConfirmIpRateLimit:
    'per-address cap on the public confirm endpoint — the token is the credential, so this bounds probing rather than any flow a suite repeats from one address',
  newsletterUnsubscribeIpRateLimit: 'the unsubscribe endpoint, same address identity and sizing',
  balanceReadRateLimit: `the balance read at ${String(BILLING_RATE_LIMITS.balanceReadRateLimit.maxAttempts)} in ${String(BILLING_RATE_LIMITS.balanceReadRateLimit.windowSeconds)} s, on the caller address; ${BALANCE_READ_CAP_IS_A_BACKSTOP}`,
  roadmapIpRateLimit: 'per-address cap on an unauthenticated public read at 30 in 60 s',
  statsIpRateLimit: 'the public usage-stats read, same address identity and sizing',
  growthBeaconIpRateLimit: `per-address cap on the unauthenticated marketing beacon at ${String(growthBeaconIpRateLimit.maxAttempts)} in ${String(growthBeaconIpRateLimit.windowSeconds)} s — an address identity a caller varies, and a route that answers the same 204 whether or not the counter admitted it, so a dev lever able to clear it would clear nothing anyone is stuck behind`,
};

/**
 * The secret-guessing surfaces, which are the entries `clear` is reachable
 * from. Five of them are already pinned at their call sites — `clear` takes a
 * `ReservationLimit`, so a class change would fail to compile in the identity
 * slice's login, TOTP, deletion and step-up flows — and the direction this
 * adds is the other one: that NOTHING ELSE in the subject is classified as a
 * reservation, which no call site can say and which the compiler cannot ask.
 */
const RESERVATIONS: readonly string[] = [
  'loginLockout',
  'loginLockoutPerNetwork',
  'twoFactorLockout',
  'twoFactorCeiling',
  'stepUpLockout',
  'deleteAccountLockout',
  'deleteAccountInitLockout',
  'recoveryGetKeyLockout',
  'recoveryGetKeyLockoutPerNetwork',
  'recoveryResetLockout',
  'recoveryResetLockoutPerNetwork',
];

/**
 * The counter's key with its identifier removed — the string a reset target
 * must begin with to reach it. It is the only thing read out of a key here: a
 * counter is in subject because it is DECLARED, never because its key spells a
 * dimension this file claims to recognise.
 */
function keyPrefix(key: string): string {
  return key.slice(0, key.length - SAMPLE_ID.length);
}

function clearedByAReset(key: string): boolean {
  return RESET_TARGETS.some((target) => target.startsWith(keyPrefix(key)));
}

describe('every rate-limit counter the api declares', () => {
  it('keeps every counter under the namespace the primitive rule recognises', () => {
    // `rate-limit-keys-use-the-primitive` finds a counter squatting in the
    // generic key registry by this prefix, so a counter written outside the
    // namespace is one that arch rule cannot see.
    const strays = SUBJECT.filter(
      ([, definition]) => !definition.buildKey(SAMPLE_ID).startsWith('ratelimit:')
    ).map(([name]) => name);

    expect(strays.toSorted(byText)).toEqual([]);
  });

  it('gives every counter a key string no pre-migration entry ever wrote', () => {
    const historical = new Set(PRE_MIGRATION_KEYS);

    const reused = SUBJECT.filter(([, definition]) =>
      historical.has(definition.buildKey(SAMPLE_ID))
    ).map(([name]) => name);

    expect(reused.toSorted(byText)).toEqual([]);
  });

  it('gives every counter a key string distinct from every other counter', () => {
    const keys = SUBJECT.map(([, definition]) => definition.buildKey(SAMPLE_ID));

    expect(new Set(keys).size).toBe(SUBJECT.length);
  });

  it('gives every counter a positive whole-second window', () => {
    // The primitive's script refuses a window it cannot use, which fails the
    // request closed; catching it here is what keeps that from being the first
    // report.
    const rejected = SUBJECT.filter(
      ([, definition]) =>
        !Number.isInteger(definition.windowSeconds) || definition.windowSeconds < 1
    ).map(([name]) => name);

    expect(rejected.toSorted(byText)).toEqual([]);
  });

  it('gives every counter a cap of at least one attempt', () => {
    const rejected = SUBJECT.filter(
      ([, definition]) => !Number.isInteger(definition.maxAttempts) || definition.maxAttempts < 1
    ).map(([name]) => name);

    expect(rejected.toSorted(byText)).toEqual([]);
  });

  it('classifies exactly the secret-guessing surfaces as reservations', () => {
    const classified = SUBJECT.filter(([, definition]) => definition.kind === 'reservation').map(
      ([name]) => name
    );

    expect(classified.toSorted(byText)).toEqual([...RESERVATIONS].toSorted(byText));
  });

  it('leaves a dev reset able to clear every counter, or names why not', () => {
    // Nothing about a counter is inferred from the way its key is spelled: the
    // reset lists are hand-written, so the default outcome for a counter
    // anyone declares is one no path can clear, whatever it names its
    // dimension. This is what turns that from something someone has to
    // remember into a red test.
    const unreachable = SUBJECT.filter(
      ([name, definition]) =>
        !clearedByAReset(definition.buildKey(SAMPLE_ID)) && !(name in NO_RESET_CLEARS)
    ).map(([name]) => name);

    expect(unreachable.toSorted(byText)).toEqual([]);
  });

  it('keeps no exception for a counter that is gone or already cleared', () => {
    // An exception is a claim about a counter as it stands now. Giving it a
    // reset, or retiring the entry, falsifies the claim without touching the
    // map — so the map is asserted against the subject rather than trusted.
    const declared = new Map(SUBJECT);

    const stale = Object.keys(NO_RESET_CLEARS).filter((name) => {
      const definition = declared.get(name);
      return definition === undefined || clearedByAReset(definition.buildKey(SAMPLE_ID));
    });

    expect(stale.toSorted(byText)).toEqual([]);
  });
});

describe('the counters the assembled router spends', () => {
  it('spends the login-start counter at its declared cap and window', async () => {
    // The positive control. The other two cases here quantify over what the
    // walk returned, so a walk that reached nothing would pass them; this one
    // names a counter literally, and both its numbers, so an empty or mis-keyed
    // walk is a red. The expectation is written out rather than read off the
    // entry, which would make it move with the very change it exists to catch.
    const counters = await spentCounters();

    expect(counters).toContainEqual({
      key: 'ratelimit:identity:login:ip:{id}',
      maxAttempts: 20,
      windowSeconds: 900,
    });
  });

  it('spends no counter the declarations do not hold', async () => {
    // The direction the declarations cannot check themselves. A posture layer
    // takes a definition, not a name, so a limit-shaped object literal written
    // inline in a fragment would be bound to a route while being declared
    // nowhere the arch rule reads — invisible to `DECLARED_LIMITS` and to every
    // case above. It is visible here, because the pipeline spends it.
    //
    // The cap and window ride along rather than the key alone, so a bound that
    // reaches the script carrying numbers its declaration does not is a red
    // too.
    const declared = new Set(
      SUBJECT.map(([, definition]) =>
        sized({
          key: definition.buildKey(SAMPLE_ID),
          maxAttempts: definition.maxAttempts,
          windowSeconds: definition.windowSeconds,
        })
      )
    );

    const counters = await spentCounters();

    const unknown = counters
      .filter((counter) => !declared.has(sized(counter)))
      .map((counter) => sized(counter));

    expect([...new Set(unknown)].toSorted(byText)).toEqual([]);
  });

  it('never spends one key under two different caps or windows', async () => {
    // What this catches is two entries sharing a key. It catches the case
    // where they also disagree on their numbers; two distinct entries with
    // identical caps and windows are indistinguishable from one entry spent on
    // two routes, which a walk keyed on published values cannot separate.
    const counters = await spentCounters();

    const sizes = new Map<string, string>();
    const contested: string[] = [];
    for (const counter of counters) {
      const size = `${String(counter.maxAttempts)}/${String(counter.windowSeconds)}`;
      const seen = sizes.get(counter.key);
      if (seen === undefined) sizes.set(counter.key, size);
      else if (seen !== size) contested.push(`${counter.key}: ${seen} and ${size}`);
    }

    expect(contested.toSorted(byText)).toEqual([]);
  });
});
