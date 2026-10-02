import { bindRoutePosture } from '../../lib/rate-limit/index.js';
import {
  adminAuditSearchRateLimit,
  adminCustomer360RateLimit,
  adminDashboardRateLimit,
  adminFeedbackRateLimit,
  adminJobQueueRateLimit,
  adminNewsletterSubscribersRateLimit,
  adminOpsRateLimit,
  adminSqlPanelRateLimit,
} from './domain/rate-limit.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createAdminManifest } from './routes.js';

/**
 * The route keys this slice contributes, derived from its own manifest. A route
 * added, renamed or removed moves this union, so the declaration below stops
 * compiling until it moves with it.
 */
export type AdminRouteKey = SliceRouteKey<ReturnType<typeof createAdminManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * The declaration crosses the slice perimeter as a BOUND COUNTING CAPABILITY,
 * never as a registry entry: `bindRoutePosture` closes over the entries, and a
 * closure's captures have no reflection surface, so the caps, windows, key
 * material and the `clear` disarm stay unreachable from everything this module
 * publishes.
 *
 * Every route here is admin-classed, so the caller is always the admin actor a
 * verified Access assertion minted, and the counters that exist are volume caps
 * rather than authentication bounds — the authentication bound is Access
 * itself. Each read counter bounds a read that names a person, and is spent
 * ahead of it — a request the query or path schema rejects is counted and
 * answers 400 having read nothing. The reads so bounded are the
 * Customer-360 assembly, the audit trail, the dashboard's recent-actions feed
 * over that same trail, the job queue — whose rows carry a handler's payload
 * verbatim, and a registered payload can open on a user id — feedback triage,
 * the newsletter consent-evidence pages and the SQL panel. The two feedback
 * routes share ONE entry, so an actor's triage volume is bounded across the
 * inbox and the detail load together rather than per route.
 *
 * The ops surface carries its own window, shared by preview and execute so an
 * actor's total op activity is bounded across the pair rather than per route.
 * Preview is a read that names a person — one the registry and the input schema
 * both admit returns the effects an op body computed against real customer
 * rows, and writes a read-audit row — so Charter #12 asks it for both halves,
 * audited AND volume-capped. The shared window is spent ahead of both those
 * gates, so a preview naming no registered op is counted and answers 404
 * having computed nothing and audited nothing. Execute is the plane's mutation
 * surface, and the audited engine's own fences do not
 * bound its volume: the idempotency-key row fences replay of ONE operation and
 * a fresh key per call is free, while a registered inverse says a mutation can
 * be reversed, never that it can be refused. The route class's default cannot
 * express the bound either: it is spent on a counter per route, so preview and
 * execute would carry a window each rather than one between them, and it is a
 * backstop over a minute where a sensitive read wants a volume cap over an
 * hour.
 *
 * Everything else does take that default: the ops catalog and the issue-render
 * preview reach no store at all, the prefill returns the op's own registered
 * form state, the subscriber stats are grouped counts, and the issues and
 * models reads return one capped page each. What none of them returns is
 * per-person customer data — the one person an issues row names is the admin
 * who authored it, from the Access JWT — which is why the class default is
 * the whole bound there.
 *
 * Nothing in this slice's domain spends a counter, so no route cites one in
 * flow — the ops the engine runs compose other slices' published barrels, and
 * none of those doors reaches a rate-limit primitive.
 *
 * On the failure axis the two halves part. The named windows declare `closed`:
 * each was sized because a volume cap on a read that names a person is a
 * charter obligation in its own right, and an unspendable counter would lift
 * exactly that cap — the audit row it also writes records who read, never how
 * much. The routes on the class default declare `open`: that default is a
 * backstop rather than the bound anything here rests on, the caller is an
 * allowlisted actor a hardware key authenticated at Cloudflare Access, and a
 * degradation is when the console is most needed.
 */
export const ADMIN_ROUTE_POSTURES = {
  '$get /admin/ops': { kind: 'default', failure: 'open' },
  '$get /admin/ops/:name/prefill': { kind: 'default', failure: 'open' },
  '$post /admin/ops/:name/preview': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'admin-actor', countedAt: 'edge', definition: adminOpsRateLimit }],
  }),
  '$post /admin/ops/:name/execute': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'admin-actor', countedAt: 'edge', definition: adminOpsRateLimit }],
  }),
  '$get /admin/users/overview': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'admin-actor', countedAt: 'edge', definition: adminCustomer360RateLimit }],
  }),
  '$get /admin/dashboard': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'admin-actor', countedAt: 'edge', definition: adminDashboardRateLimit }],
  }),
  '$get /admin/jobs': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'admin-actor', countedAt: 'edge', definition: adminJobQueueRateLimit }],
  }),
  '$get /admin/feedback': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'admin-actor', countedAt: 'edge', definition: adminFeedbackRateLimit }],
  }),
  '$get /admin/feedback/:id': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'admin-actor', countedAt: 'edge', definition: adminFeedbackRateLimit }],
  }),
  '$get /admin/newsletter/issues': { kind: 'default', failure: 'open' },
  '$post /admin/newsletter/render': { kind: 'default', failure: 'open' },
  '$get /admin/newsletter/subscribers/stats': { kind: 'default', failure: 'open' },
  '$get /admin/newsletter/subscribers': bindRoutePosture({
    failure: 'closed',
    layers: [
      {
        identity: 'admin-actor',
        countedAt: 'edge',
        definition: adminNewsletterSubscribersRateLimit,
      },
    ],
  }),
  '$get /admin/models': { kind: 'default', failure: 'open' },
  '$get /admin/audit': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'admin-actor', countedAt: 'edge', definition: adminAuditSearchRateLimit }],
  }),
  '$get /admin/sql': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'admin-actor', countedAt: 'edge', definition: adminSqlPanelRateLimit }],
  }),
} satisfies Record<AdminRouteKey, CarriedRoutePosture>;
