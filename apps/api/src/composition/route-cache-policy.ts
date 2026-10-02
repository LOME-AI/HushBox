import type { RouteKey } from './app-route-key.js';
import type { CachePolicy } from '../lib/cache-policy/index.js';

/**
 * # Which routes a shared cache may store
 *
 * Every route in `AppType` declares here whether a cache the caller does not
 * own may hold its response. Shared caching is switched on per Worker and
 * consulted before the Worker runs; there is no per-route switch, so this
 * declaration, rendered onto the response on the way out, is the whole of the
 * per-route control. The `satisfies Record<RouteKey, CachePolicy>` witness
 * below is what makes the coverage total: a route present in `AppType` and
 * absent here fails to compile by name, and a key naming no route fails as an
 * excess property.
 *
 * ## Route class is not evidence of caller-invariance
 *
 * `GET /chat/trial/remaining` is `routeClass('public')`, refuses an
 * authenticated caller outright, and derives its body from the caller's IP hash
 * and `x-trial-token`. A `public` class says no credential is needed to REACH a
 * route; it says nothing about whether every caller gets the same bytes. Only a
 * route with a proof that they do may be declared storable.
 *
 * ## Why this is not a field on `ROUTE_POSTURES`
 *
 * A route's rate-limit posture and its cacheability are independent facts, and
 * `CODE-RULES.md` §One Implementation, Shared draws its line at whether two
 * things drifting apart breaks something — these two may drift freely. Their
 * failure modes are not comparable either: a wrong posture returns a 429, a
 * wrong declaration here replays one caller's response to a stranger.
 *
 * ## A `shared` declaration also grants the CORS wildcard
 *
 * `apps/api/src/middleware/cors.ts` reads `public` + `s-maxage` off the
 * response as its evidence that a body does not vary with the caller, so the
 * `shared` kind grants the cross-origin wildcard and the `immutable` kind,
 * which writes no `s-maxage`, does not. Changing a route's kind here changes
 * what an unrelated origin may read.
 */
export const ROUTE_CACHE_POLICIES = {
  '$delete /account/instructions': { kind: 'no-store' },
  '$get /account/instructions': { kind: 'no-store' },
  '$put /account/instructions': { kind: 'no-store' },
  '$get /account/preferences/accessibility': { kind: 'no-store' },
  '$put /account/preferences/accessibility': { kind: 'no-store' },
  '$get /account/users/search': { kind: 'no-store' },

  '$get /admin/audit': { kind: 'no-store' },
  '$get /admin/dashboard': { kind: 'no-store' },
  '$get /admin/feedback/:id': { kind: 'no-store' },
  '$get /admin/feedback': { kind: 'no-store' },
  '$get /admin/jobs': { kind: 'no-store' },
  '$get /admin/models': { kind: 'no-store' },
  '$get /admin/newsletter/issues': { kind: 'no-store' },
  '$post /admin/newsletter/render': { kind: 'no-store' },
  '$get /admin/newsletter/subscribers/stats': { kind: 'no-store' },
  '$get /admin/newsletter/subscribers': { kind: 'no-store' },
  '$post /admin/ops/:name/execute': { kind: 'no-store' },
  '$get /admin/ops/:name/prefill': { kind: 'no-store' },
  '$post /admin/ops/:name/preview': { kind: 'no-store' },
  '$get /admin/ops': { kind: 'no-store' },
  '$get /admin/sql': { kind: 'no-store' },
  '$get /admin/users/overview': { kind: 'no-store' },

  '$get /announcements/banner/dismissal': { kind: 'no-store' },
  '$put /announcements/banner/dismissal': { kind: 'no-store' },
  '$get /announcements/banner': { kind: 'shared', sharedMaxAgeSeconds: 60, tag: 'banner' },

  '$post /auth/2fa/disable/finish': { kind: 'no-store' },
  '$post /auth/2fa/disable/init': { kind: 'no-store' },
  '$post /auth/2fa/setup': { kind: 'no-store' },
  '$post /auth/2fa/verify': { kind: 'no-store' },
  '$get /auth/account/acquisition-source': { kind: 'no-store' },
  '$patch /auth/account/acquisition-source': { kind: 'no-store' },
  '$post /auth/account/delete/finish': { kind: 'no-store' },
  '$post /auth/account/delete/init': { kind: 'no-store' },
  '$post /auth/change-password/finish': { kind: 'no-store' },
  '$post /auth/change-password/init': { kind: 'no-store' },
  '$post /auth/login/2fa/verify': { kind: 'no-store' },
  '$post /auth/login/finish': { kind: 'no-store' },
  '$post /auth/login/init': { kind: 'no-store' },
  '$post /auth/logout': { kind: 'no-store' },
  '$get /auth/me': { kind: 'no-store' },
  '$post /auth/recovery/get-wrapped-key': { kind: 'no-store' },
  '$post /auth/recovery/reset/finish': { kind: 'no-store' },
  '$post /auth/recovery/reset/init': { kind: 'no-store' },
  '$post /auth/recovery/save/finish': { kind: 'no-store' },
  '$post /auth/recovery/save/init': { kind: 'no-store' },
  '$post /auth/register/finish': { kind: 'no-store' },
  '$post /auth/register/init': { kind: 'no-store' },
  '$post /auth/token-login': { kind: 'no-store' },
  '$get /auth/verify-email/dev-link': { kind: 'no-store' },
  '$post /auth/verify-email/resend': { kind: 'no-store' },
  '$post /auth/verify-email': { kind: 'no-store' },

  '$get /billing/balance': { kind: 'no-store' },
  '$post /billing/login-link': { kind: 'no-store' },
  '$get /billing/mock/release-webhook': { kind: 'no-store' },
  '$post /billing/payments': { kind: 'no-store' },
  '$get /billing/spendable': { kind: 'no-store' },
  '$get /billing/transactions': { kind: 'no-store' },
  '$get /billing/usage/cost-by-model': { kind: 'no-store' },
  '$get /billing/usage/models': { kind: 'no-store' },
  '$get /billing/usage/spending-by-conversation': { kind: 'no-store' },
  '$get /billing/usage/spending-over-time': { kind: 'no-store' },
  '$get /billing/usage/summary': { kind: 'no-store' },
  '$get /billing/usage': { kind: 'no-store' },
  '$post /billing/webhooks/payment': { kind: 'no-store' },

  '$post /chat/:conversationId/message': { kind: 'no-store' },
  '$post /chat/guest': { kind: 'no-store' },
  '$get /chat/mock/release-stream': { kind: 'no-store' },
  '$post /chat/regenerate': { kind: 'no-store' },
  '$post /chat/stop': { kind: 'no-store' },
  '$get /chat/trial/remaining': { kind: 'no-store' },
  '$get /chat/trial/websocket': { kind: 'no-store' },
  '$post /chat/trial': { kind: 'no-store' },

  '$post /chat': { kind: 'no-store' },

  '$put /conversations/:conversationId/budget': { kind: 'no-store' },
  '$get /conversations/:conversationId/budgets': { kind: 'no-store' },
  '$put /conversations/:conversationId/forks/:forkId/tip': { kind: 'no-store' },
  '$delete /conversations/:conversationId/forks/:forkId': { kind: 'no-store' },
  '$patch /conversations/:conversationId/forks/:forkId': { kind: 'no-store' },
  '$get /conversations/:conversationId/forks': { kind: 'no-store' },
  '$post /conversations/:conversationId/forks': { kind: 'no-store' },
  '$get /conversations/:conversationId/funding': { kind: 'no-store' },
  '$post /conversations/:conversationId/epochs': { kind: 'no-store' },
  '$get /conversations/:conversationId/keychain': { kind: 'no-store' },
  '$post /conversations/:conversationId/leave': { kind: 'no-store' },
  '$patch /conversations/:conversationId/links/:linkId/name': { kind: 'no-store' },
  '$patch /conversations/:conversationId/links/:linkId/privilege': { kind: 'no-store' },
  '$post /conversations/:conversationId/links/:linkId/revoke': { kind: 'no-store' },
  '$get /conversations/:conversationId/links': { kind: 'no-store' },
  '$post /conversations/:conversationId/links': { kind: 'no-store' },
  '$get /conversations/:conversationId/member-keys': { kind: 'no-store' },
  '$put /conversations/:conversationId/member/:memberId/budget': { kind: 'no-store' },
  '$patch /conversations/:conversationId/member/:memberId/privilege': { kind: 'no-store' },
  '$post /conversations/:conversationId/members/:memberId/remove': { kind: 'no-store' },
  '$get /conversations/:conversationId/members': { kind: 'no-store' },
  '$patch /conversations/:conversationId/membership/accept': { kind: 'no-store' },
  '$post /conversations/:conversationId/membership/decline': { kind: 'no-store' },
  '$patch /conversations/:conversationId/membership/mute': { kind: 'no-store' },
  '$patch /conversations/:conversationId/membership/pin': { kind: 'no-store' },
  '$post /conversations/:conversationId/members': { kind: 'no-store' },
  '$get /conversations/:conversationId/messages': { kind: 'no-store' },
  '$get /conversations/:conversationId/my-name': { kind: 'no-store' },
  '$patch /conversations/:conversationId/my-name': { kind: 'no-store' },
  '$patch /conversations/:conversationId/read': { kind: 'no-store' },
  '$post /conversations/:conversationId/shares': { kind: 'no-store' },
  '$get /conversations/:conversationId/websocket': { kind: 'no-store' },
  '$post /conversations/:conversationId/websocket-ticket': { kind: 'no-store' },
  '$delete /conversations/:conversationId': { kind: 'no-store' },
  '$get /conversations/:conversationId': { kind: 'no-store' },
  '$patch /conversations/:conversationId': { kind: 'no-store' },
  '$get /conversations/member-keys/batch': { kind: 'no-store' },
  '$get /conversations/shared/message/:shareId': { kind: 'no-store' },

  '$get /conversations': { kind: 'no-store' },
  '$post /conversations': { kind: 'no-store' },

  '$get /dev/acquisition-source/:email': { kind: 'no-store' },
  '$delete /dev/admin-dashboard-reads': { kind: 'no-store' },
  '$delete /dev/admin-job-queue-reads': { kind: 'no-store' },
  '$delete /dev/admin-ops-runs': { kind: 'no-store' },
  '$post /dev/admin-targets': { kind: 'no-store' },
  '$get /dev/admin-token': { kind: 'no-store' },
  '$delete /dev/auth-rate-limits': { kind: 'no-store' },
  '$delete /dev/banner': { kind: 'no-store' },
  '$get /dev/conversation-cost/:conversationId': { kind: 'no-store' },
  '$post /dev/conversation': { kind: 'no-store' },
  '$get /dev/emails': { kind: 'no-store' },
  '$get /dev/feedback/by-email/:email': { kind: 'no-store' },
  '$post /dev/group-chat': { kind: 'no-store' },
  '$post /dev/growth-rollup': { kind: 'no-store' },
  '$get /dev/llm-completions-count/:conversationId': { kind: 'no-store' },
  '$get /dev/mailbox/:id': { kind: 'no-store' },
  '$get /dev/mailbox': { kind: 'no-store' },
  '$post /dev/media-conversation': { kind: 'no-store' },
  '$get /dev/message-payers/:conversationId': { kind: 'no-store' },
  '$get /dev/mock-charge-basis': { kind: 'no-store' },
  '$post /dev/newsletter/subscribers': { kind: 'no-store' },
  '$get /dev/newsletter/tokens/:email': { kind: 'no-store' },
  '$get /dev/personas': { kind: 'no-store' },
  '$post /dev/revoke-message-share': { kind: 'no-store' },
  '$post /dev/set-checksum': { kind: 'no-store' },
  '$post /dev/set-version': { kind: 'no-store' },
  '$delete /dev/totp-replay': { kind: 'no-store' },
  '$delete /dev/trial-usage': { kind: 'no-store' },
  '$post /dev/usage-history': { kind: 'no-store' },
  '$delete /dev/usage-rate-limits': { kind: 'no-store' },
  '$get /dev/verify-token/:email': { kind: 'no-store' },
  '$post /dev/wallet-balance': { kind: 'no-store' },

  // The beacon writes counters and answers no body. A shared cache holding its
  // 204 would serve a later beacon's request from the first one's answer, and
  // that request is the whole of the write.
  '$post /e': { kind: 'no-store' },

  '$post /feedback': { kind: 'no-store' },

  '$get /health': { kind: 'no-store' },

  '$get /media/:contentItemId/download-url': { kind: 'no-store' },
  '$get /media/shared/:shareId/:contentItemId/download-url': { kind: 'no-store' },

  '$get /models': { kind: 'shared', sharedMaxAgeSeconds: 60, tag: 'catalog' },
  // One published artifact, addressed by a version that sits in its own path:
  // the bytes under a URL can never change, so every cache may keep them for a
  // year. The handler is a pure path-to-object lookup with no auth, no
  // personalisation and no caller variation — proven, as the arch rule
  // requires, by the caller-invariance test colocated with the slice.
  '$get /models/:model/:version/:file': {
    kind: 'immutable',
    maxAgeSeconds: 31_536_000,
    tag: 'model-weights',
  },

  '$post /newsletter/confirm': { kind: 'no-store' },
  '$get /newsletter/me': { kind: 'no-store' },
  '$put /newsletter/me': { kind: 'no-store' },
  '$post /newsletter/subscribe': { kind: 'no-store' },
  '$post /newsletter/unsubscribe': { kind: 'no-store' },
  '$post /newsletter/webhooks/resend': { kind: 'no-store' },

  '$delete /notifications/device-tokens/:token': { kind: 'no-store' },
  '$post /notifications/device-tokens': { kind: 'no-store' },
  '$get /notifications/preferences': { kind: 'no-store' },
  '$put /notifications/preferences': { kind: 'no-store' },
  '$post /notifications/web-subscriptions': { kind: 'no-store' },

  '$get /public/roadmap': {
    kind: 'shared',
    sharedMaxAgeSeconds: 3600,
    staleWhileRevalidateSeconds: 600,
    staleIfErrorSeconds: 86_400,
    tag: 'roadmap',
  },
  '$get /public/stats': {
    kind: 'shared',
    sharedMaxAgeSeconds: 3600,
    staleWhileRevalidateSeconds: 600,
    tag: 'stats',
  },

  // A stale version or checksum strands a client on an old bundle or fails its
  // integrity check against the live one.
  '$get /updates/current': { kind: 'no-store' },
  '$get /updates/download/:platform/:version': {
    kind: 'immutable',
    maxAgeSeconds: 86_400,
    tag: 'ota',
  },
} as const satisfies Record<RouteKey, CachePolicy>;
