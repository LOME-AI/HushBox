import { ACCOUNT_ROUTE_POSTURES } from '../slices/account/index.js';
import { ADMIN_ROUTE_POSTURES } from '../slices/admin/index.js';
import { ANNOUNCEMENTS_ROUTE_POSTURES } from '../slices/announcements/index.js';
import { BILLING_ROUTE_POSTURES } from '../slices/billing/index.js';
import { CHAT_ROUTE_POSTURES } from '../slices/chat/index.js';
import { CONVERSATIONS_ROUTE_POSTURES } from '../slices/conversations/index.js';
import { FEEDBACK_ROUTE_POSTURES } from '../slices/feedback/index.js';
import { GROWTH_ROUTE_POSTURES } from '../slices/growth/index.js';
import { IDENTITY_ROUTE_POSTURES } from '../slices/identity/index.js';
import { MEDIA_ROUTE_POSTURES } from '../slices/media/index.js';
import { MODEL_WEIGHTS_ROUTE_POSTURES } from '../slices/model-weights/index.js';
import { MODELS_ROUTE_POSTURES } from '../slices/models/index.js';
import { NEWSLETTER_ROUTE_POSTURES } from '../slices/newsletter/index.js';
import { NOTIFICATIONS_ROUTE_POSTURES } from '../slices/notifications/index.js';
import { ROADMAP_ROUTE_POSTURES } from '../slices/roadmap/index.js';
import { STATS_ROUTE_POSTURES } from '../slices/stats/index.js';
import { UPDATES_ROUTE_POSTURES } from '../slices/updates/index.js';
import type { RoutePosture } from '../lib/rate-limit/index.js';
import type { RoutePostureMap } from '../middleware/pipeline-rate-limit.js';
import type { RouteKey } from './app-route-key.js';

/**
 * # The rate-limit posture map
 *
 * Doctrine (`CODE-RULES.md` §Security): every route declares a rate-limit
 * posture, and the pipeline default-denies a matched route whose posture is
 * absent. This module assembles the declarations; enforcement is the
 * pipeline's.
 *
 * A slice declares its own routes, in its own `rate-limit-posture.ts`, and
 * publishes the result through its barrel as a BOUND COUNTING CAPABILITY — so
 * the caps, windows, key material and the `clear` disarm behind a named posture
 * stay unreachable from everything that crosses the slice perimeter. What is
 * left here is the merge, plus the routes `app.ts` mounts from outside
 * `slices/`, which no slice can declare because no slice owns them.
 */
export const SLICE_ROUTE_POSTURES = {
  ...ACCOUNT_ROUTE_POSTURES,
  ...ADMIN_ROUTE_POSTURES,
  ...ANNOUNCEMENTS_ROUTE_POSTURES,
  ...BILLING_ROUTE_POSTURES,
  ...CHAT_ROUTE_POSTURES,
  ...CONVERSATIONS_ROUTE_POSTURES,
  ...FEEDBACK_ROUTE_POSTURES,
  ...GROWTH_ROUTE_POSTURES,
  ...IDENTITY_ROUTE_POSTURES,
  ...MEDIA_ROUTE_POSTURES,
  ...MODEL_WEIGHTS_ROUTE_POSTURES,
  ...MODELS_ROUTE_POSTURES,
  ...NEWSLETTER_ROUTE_POSTURES,
  ...NOTIFICATIONS_ROUTE_POSTURES,
  ...ROADMAP_ROUTE_POSTURES,
  ...STATS_ROUTE_POSTURES,
  ...UPDATES_ROUTE_POSTURES,
};

/**
 * The routes left for this module to declare: every key the app serves that no
 * fragment contributes. Derived rather than listed, so the two halves cannot
 * both forget a route — a fragment dropped from the merge above puts its
 * slice's keys here, where they are missing and named.
 */
type AppRouteKey = Exclude<RouteKey, keyof typeof SLICE_ROUTE_POSTURES>;

/**
 * The dev root and the liveness route, neither of which sits in a slice. The
 * clause below is on the literal itself: a key naming no such route is caught
 * only while the literal is fresh, and every indirection drops that check
 * silently.
 *
 * Every dev route declares `open`. The class answers 404 in production, at the
 * authorizer, which runs before the counter is spent — so nothing a production
 * caller does reaches these windows, and what an unspendable one would admit is
 * our own tooling. Several of them are the levers that clear a rate-limit
 * window, so refusing them is refusing the recovery. The liveness route carries
 * no failure declaration at all: an exemption reaches no counter to be unable
 * to spend.
 */
const APP_ROUTE_POSTURES = {
  '$get /health': { kind: 'exempt', exemption: 'constant-cost' },
  '$get /dev/acquisition-source/:email': { kind: 'default', failure: 'open' },
  '$delete /dev/admin-dashboard-reads': { kind: 'default', failure: 'open' },
  '$delete /dev/admin-job-queue-reads': { kind: 'default', failure: 'open' },
  '$delete /dev/admin-ops-runs': { kind: 'default', failure: 'open' },
  '$post /dev/admin-targets': { kind: 'default', failure: 'open' },
  '$get /dev/admin-token': { kind: 'default', failure: 'open' },
  '$delete /dev/auth-rate-limits': { kind: 'default', failure: 'open' },
  '$delete /dev/banner': { kind: 'default', failure: 'open' },
  '$get /dev/conversation-cost/:conversationId': { kind: 'default', failure: 'open' },
  '$post /dev/conversation': { kind: 'default', failure: 'open' },
  '$get /dev/emails': { kind: 'default', failure: 'open' },
  '$get /dev/feedback/by-email/:email': { kind: 'default', failure: 'open' },
  '$post /dev/group-chat': { kind: 'default', failure: 'open' },
  '$post /dev/growth-rollup': { kind: 'default', failure: 'open' },
  '$get /dev/llm-completions-count/:conversationId': { kind: 'default', failure: 'open' },
  '$get /dev/mailbox/:id': { kind: 'default', failure: 'open' },
  '$get /dev/mailbox': { kind: 'default', failure: 'open' },
  '$post /dev/media-conversation': { kind: 'default', failure: 'open' },
  '$get /dev/message-payers/:conversationId': { kind: 'default', failure: 'open' },
  '$get /dev/mock-charge-basis': { kind: 'default', failure: 'open' },
  '$post /dev/newsletter/subscribers': { kind: 'default', failure: 'open' },
  '$get /dev/newsletter/tokens/:email': { kind: 'default', failure: 'open' },
  '$get /dev/personas': { kind: 'default', failure: 'open' },
  '$post /dev/revoke-message-share': { kind: 'default', failure: 'open' },
  '$post /dev/set-checksum': { kind: 'default', failure: 'open' },
  '$post /dev/set-version': { kind: 'default', failure: 'open' },
  '$delete /dev/totp-replay': { kind: 'default', failure: 'open' },
  '$delete /dev/trial-usage': { kind: 'default', failure: 'open' },
  '$post /dev/usage-history': { kind: 'default', failure: 'open' },
  '$delete /dev/usage-rate-limits': { kind: 'default', failure: 'open' },
  '$get /dev/verify-token/:email': { kind: 'default', failure: 'open' },
  '$post /dev/wallet-balance': { kind: 'default', failure: 'open' },
} as const satisfies Record<AppRouteKey, RoutePosture>;

/**
 * Completeness is the clause: a route the app serves and neither half declares
 * fails to compile, naming the key. Staleness is not, and cannot be — a spread
 * carries no excess-property check — so each half asserts its own against its
 * own fresh literal, and the colocated test walks the assembled router for what
 * neither reaches.
 *
 * `keyedBy` names only identities `POSTURE_IDENTITIES` carries, and names them
 * wherever the count happens: several routes are bounded inside their slice's
 * domain flow rather than by a mounted limiter, and the posture records the
 * bound, not its mount point. It is POSITIONAL, one entry per layer, so a route
 * spending two counters on one identity names that identity twice. That set is
 * cut by where the counting happens rather than by what a value is: a layer the
 * pipeline stage counts may name only what the stage derives from the request,
 * while a layer its owning slice counts may also name what the caller supplied
 * — an account it claims, a token it presents, a share it asks for.
 *
 * Every declaration carries `failure` as well, and the two dimensions are
 * independent: nothing here or in the pipeline derives one from the other, and
 * a route missing either fails to compile by name. What each row's value is
 * chosen by is one question — with the counter unspendable, is it worse to
 * refuse this route or to admit it uncounted? — and the reasoning per row lives
 * in the fragment that owns it.
 *
 * A reader will notice the answers cluster, and the reason is worth stating so
 * it is not mistaken for the coupling this vocabulary replaced. A class default
 * is a BACKSTOP an order of magnitude above real peak, so losing it for the
 * length of a degradation costs little, and most routes taking one are reached
 * only by an authenticated caller whose volume is bounded by their account. A
 * named limit exists because someone judged a tuned bound necessary, so losing
 * it is losing the bound itself. That is what the reasoning WEIGHS, never what
 * the limit kind decides: rows go the other way in both directions — the OPAQUE
 * `finish` routes on the public class take a class default and declare
 * `closed`, while the public catalog, stats and roadmap reads, the balance
 * read, the unsubscribe and the run abort carry named limits and declare
 * `open`.
 *
 * The annotation is what keeps this resolvable: `RouteKey` is read off
 * `AppType` and `app.ts` reads this map back, so a declared type rather than an
 * inferred one is what stops that being a cycle.
 */
export const ROUTE_POSTURES: RoutePostureMap = {
  ...SLICE_ROUTE_POSTURES,
  ...APP_ROUTE_POSTURES,
} satisfies Record<RouteKey, RoutePosture>;
