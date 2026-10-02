import { bindRoutePosture } from '../../lib/rate-limit/index.js';
import { feedbackSubmitHourlyRateLimit, feedbackSubmitRateLimit } from './domain/rate-limit.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createFeedbackManifest } from './routes.js';

/**
 * The route keys this slice contributes, derived from its own manifest. A route
 * added, renamed or removed moves this union, so the declaration below stops
 * compiling until it moves with it.
 */
export type FeedbackRouteKey = SliceRouteKey<ReturnType<typeof createFeedbackManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * The declaration crosses the slice perimeter as a BOUND COUNTING CAPABILITY,
 * never as a registry entry: `bindRoutePosture` closes over the entries, and a
 * closure's captures have no reflection surface, so the caps, windows, key
 * material and the `clear` disarm stay unreachable from everything this module
 * publishes.
 *
 * Submission is the one route, and it carries TWO entries on ONE identity — a
 * 10/minute burst throttle and a 30/hour ceiling, both keyed on the caller.
 * That is why a layer list exists at all: an identity-keyed declaration can
 * name `caller` once and cannot say that two separate counters answer for it.
 * Both layers occupy their own position, so the edge capability spends both in
 * one all-or-nothing round trip and either tripping refuses the request.
 *
 * It declares `closed`. The two windows are the only thing bounding how many
 * rows one caller writes, and what they price is admitted REQUESTS rather than
 * rows: both are spent ahead of body validation and ahead of the dedup window,
 * so a body the schema rejects and an identical body resubmitted inside that
 * window are each counted and each write nothing. The route is session-classed,
 * so an unspendable counter still leaves one account able to fill the table for
 * the length of a degradation.
 */
export const FEEDBACK_ROUTE_POSTURES = {
  '$post /feedback': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'caller', countedAt: 'edge', definition: feedbackSubmitRateLimit },
      { identity: 'caller', countedAt: 'edge', definition: feedbackSubmitHourlyRateLimit },
    ],
  }),
} satisfies Record<FeedbackRouteKey, CarriedRoutePosture>;
