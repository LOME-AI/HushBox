import { z } from 'zod';

import { MARKETING_ROUTES } from '../platform/routes.ts';

import { campaignTagSchema } from './patterns.ts';
import {
  GROWTH_EVENT_NAME_MAX_LENGTH,
  GROWTH_EVENT_NAME_PATTERN,
  GROWTH_HOST_MAX_LENGTH,
  GROWTH_HOST_PATTERN,
  GROWTH_PATH_MAX_LENGTH,
  GROWTH_PATH_PATTERN,
} from './patterns.ts';

/**
 * The beacon body, shared by the inline marketing script that sends it and the
 * route that reads it.
 *
 * Everything else the counts need — the hour and day buckets, the country, the
 * region, the device family — is derived server-side from the request. Nothing
 * a sender could shape is trusted beyond these five fields, and each of the
 * three that name something is validated against a set the build produced, not
 * against a shape.
 */
export const beaconSchema = z.object({
  /** Pageview or named event. */
  t: z.enum(['v', 'e']),
  /** Pathname only. A shape match is not admission: the reader checks it against the exact built page set. */
  p: z.string().max(GROWTH_PATH_MAX_LENGTH).regex(new RegExp(GROWTH_PATH_PATTERN)),
  /**
   * Referrer hostname, from `document.referrer` on the page — never a `Referer`
   * header, which the marketing site's `no-referrer` policy guarantees never
   * arrives. The pattern admits no `:`, so a value carrying `://` is a whole
   * URL rather than a hostname and is refused.
   */
  r: z.string().max(GROWTH_HOST_MAX_LENGTH).regex(new RegExp(GROWTH_HOST_PATTERN)).optional(),
  /** Campaign tag. An unknown tag is folded to `unknown` by the reader, never rejected, so a stale link still counts. */
  c: campaignTagSchema.optional(),
  /** Derived event name. Checked against the page's built name set by the reader, so a name cannot be minted by a sender. */
  n: z
    .string()
    .max(GROWTH_EVENT_NAME_MAX_LENGTH)
    .regex(new RegExp(GROWTH_EVENT_NAME_PATTERN))
    .optional(),
});

/** A parsed beacon body. */
export type BeaconBody = z.infer<typeof beaconSchema>;

/**
 * The path the beacon posts to, and the only path it ever posts to.
 *
 * Same-origin with the marketing pages by way of a zone route on the product
 * Worker.
 *
 * What keeps the count anonymous on every stack is the sender omitting credentials. The session
 * cookie declares no domain attribute, so in production it is host-only on the API host, not the
 * apex the zone route is claimed on; on a localhost stack it is in scope.
 *
 * It is one exported constant because four places have to agree on it — the
 * route that serves it, the inline script that sends it, and the two guards
 * that prove the signed-in app never names it — and four copies of a wire path
 * is a sync contract that drift eventually wins.
 */
export const GROWTH_BEACON_PATH = '/e';

/**
 * The body size the sender must stay under and the reader refuses past, before
 * parsing. The schema cannot express it — a body is bytes on the wire, not a
 * parsed object — so it is a caller obligation on both sides of the wire.
 */
export const GROWTH_BEACON_MAX_BODY_BYTES = 1024;

/** Each built page path mapped to the event names that page can produce, as the marketing build derived them. */
export type GrowthEventIndex = Readonly<Record<string, readonly string[]>>;

/**
 * The one identity a page has.
 *
 * A trailing slash is dropped, because the marketing site builds
 * directory-style: a browser reports `/welcome/` for the page the build
 * emitted as `/welcome`, and comparing the raw strings would drop every beacon
 * the site sends.
 *
 * Exported because every side that names a page has to name it the same way,
 * and the cost of disagreeing is silent rather than loud. A reader validated
 * under one spelling and COUNTED under another writes a Redis key, an index
 * member and then a permanently-retained row under a value the built page set
 * does not contain — and the payload schema admits both spellings, so nothing
 * downstream can tell one page's counts have split into two rows.
 */
export function canonicalMarketingPath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * Whether `path` is a page the site actually built.
 *
 * Exact membership, never a route prefix: `/blog/[slug]` is a dynamic route, so
 * a prefix check would admit `/blog/<anything>` and every junk path would
 * become a Redis key and then, under retention forever, a permanent row.
 *
 * `pages` is what the marketing build emitted. The static routes are unioned in
 * from the one list that already exists, which cannot name a page the site does
 * not build: the headers generator fails the build when a listed route has no
 * matching built HTML.
 */
export function isKnownMarketingPage(path: string, pages: readonly string[]): boolean {
  const wanted = canonicalMarketingPath(path);
  return (
    (MARKETING_ROUTES as readonly string[]).includes(wanted) ||
    pages.some((page) => canonicalMarketingPath(page) === wanted)
  );
}

/**
 * Whether `name` is an event the marketing build derived for `path`.
 *
 * Per page rather than globally, so a name lifted from one page cannot be
 * replayed against another, and an unknown name is dropped rather than
 * refused — a sender cannot mint a series that would be kept forever.
 */
export function isKnownEvent(path: string, name: string, index: GrowthEventIndex): boolean {
  const wanted = canonicalMarketingPath(path);
  for (const [page, names] of Object.entries(index)) {
    if (canonicalMarketingPath(page) === wanted) return names.includes(name);
  }
  return false;
}
