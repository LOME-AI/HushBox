import { bindRoutePosture } from '../../lib/rate-limit/index.js';
import { MEDIA_RATE_LIMITS } from './domain/rate-limit.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createMediaManifest } from './routes.js';

/**
 * The route keys this slice contributes, derived from its own manifest. A route
 * added, renamed or removed moves this union, so the declaration below stops
 * compiling until it moves with it.
 */
export type MediaRouteKey = SliceRouteKey<ReturnType<typeof createMediaManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * The declaration crosses the slice perimeter as a BOUND COUNTING CAPABILITY,
 * never as a registry entry: `bindRoutePosture` closes over the entries, and a
 * closure's captures have no reflection surface, so the caps, windows, key
 * material and the `clear` disarm stay unreachable from everything this module
 * publishes.
 *
 * Both presign routes declare layers of their own rather than taking a route
 * class default, and both spend a further counter inside the handler —
 * because its identifier does not exist until the handler has resolved
 * something.
 *
 * On the member path all four are declared. The three edge layers are one
 * all-or-nothing check (a caller refused by the per-link layer must not have
 * spent the IP and per-caller windows on the way), and the fourth is the
 * per-link MINT window, spent once the presented credential has resolved to a
 * `linkId`. It is declared as a second `link-credential` layer because that
 * identity is the LINK — the same link the lookup layer ahead of it counts,
 * named before the resolution by its public key and after it by its id. What
 * the declaration does not claim is a shared key: the two entries are
 * different objects with different key templates, which is the whole reason
 * both exist.
 *
 * The edge order is load-bearing rather than incidental: a refusal is
 * attributed to the first layer that refuses, and a refused check leaves its
 * admitting siblings untouched. So the IP window goes first — it is the one
 * identity the caller cannot rotate — and the per-link window goes last, so a
 * caller already past its own per-caller window never spends the window that
 * link shares with every network it is presented from.
 *
 * On the share path both are declared too. The second is the per-share re-mint
 * window, spent on the shareId the caller named in the path before anything
 * resolves it — a `claimed-share`, which the pipeline does not resolve and the
 * handler does. It bounds what one share can be made to re-mint however many
 * networks it is asked from, which the address layer ahead of it cannot.
 *
 * Both routes declare `closed`. What these windows price is admitted REQUESTS
 * rather than mints: every edge layer is spent ahead of the credential
 * resolution and the share lookup, so a member-path request carrying neither
 * session nor link credential is counted by each edge layer whose identity
 * resolves and answers 401, and a share-path request naming a share that does
 * not resolve is counted by both its layers and answers 404 — neither mints
 * anything. What the windows bound is the requests that DO mint: both routes
 * are reachable by a caller holding nothing but a link, and the egress a minted
 * URL authorizes is spend no later refusal can recover — the case the
 * assignment rule puts squarely on the closed side.
 */
export const MEDIA_ROUTE_POSTURES = {
  '$get /media/:contentItemId/download-url': bindRoutePosture({
    failure: 'closed',
    layers: [
      {
        identity: 'sessionless-ip',
        countedAt: 'edge',
        definition: MEDIA_RATE_LIMITS.mediaDownloadGuestIpRateLimit,
      },
      {
        identity: 'caller',
        countedAt: 'edge',
        definition: MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit,
      },
      {
        identity: 'link-credential',
        countedAt: 'edge',
        definition: MEDIA_RATE_LIMITS.mediaDownloadLinkLookupRateLimit,
      },
      {
        identity: 'link-credential',
        countedAt: 'flow',
        definition: MEDIA_RATE_LIMITS.mediaDownloadLinkMintRateLimit,
      },
    ],
  }),
  '$get /media/shared/:shareId/:contentItemId/download-url': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'ip', countedAt: 'edge', definition: MEDIA_RATE_LIMITS.sharePresignIpRateLimit },
      {
        identity: 'claimed-share',
        countedAt: 'flow',
        definition: MEDIA_RATE_LIMITS.sharePresignRemintRateLimit,
      },
    ],
  }),
} satisfies Record<MediaRouteKey, CarriedRoutePosture>;
