import type { GrowthDevice } from '@hushbox/shared';

/**
 * The aggregate dimensions the server derives from the request rather than
 * taking from the beacon body.
 *
 * Each is coarse on purpose. A finer device class is a fingerprinting surface
 * no metric anyone reads would consume, and geography stops at the US state:
 * no city, no postal code, no coordinate exists anywhere in this design, so
 * none can leak from it.
 *
 * Every value here also has to satisfy the growth tables' column checks, which
 * is why the normalisers answer the empty string rather than passing an
 * unexpected value through — a value the check rejects would not fail here, it
 * would fail an hour later inside the rollup, on a row nobody can repair.
 */

/** The country column admits exactly this, or the empty string. */
const COUNTRY_CODE = /^[A-Z]{2}$/u;

/** The edge's own properties are typed as unknown values, so each is narrowed before it is read. */
function asText(raw: unknown): string {
  return typeof raw === 'string' ? raw.toUpperCase() : '';
}

/**
 * The edge's own name for an address it could not place.
 *
 * It is two uppercase letters, so the shape test alone admits it — and it
 * means precisely what the empty string means here. Two spellings of "we do
 * not know" in a table kept forever would oblige every query to handle both
 * and would show a dashboard two unknown rows standing for one fact, so this
 * one folds into the empty spelling. The edge's Tor marker needs no entry
 * beside it: that value carries a digit, so the shape test already refuses it,
 * and both markers reach the empty string by the same rule.
 */
const UNPLACED_COUNTRY = 'XX';

/**
 * The country code the edge reported, or the empty string when it reported
 * anything that does not name a country — a value that is not two uppercase
 * letters, or {@link UNPLACED_COUNTRY}.
 */
export function normaliseCountry(raw?: unknown): string {
  const upper = asText(raw);
  return COUNTRY_CODE.test(upper) && upper !== UNPLACED_COUNTRY ? upper : '';
}

/**
 * The US state code the edge reported, or the empty string.
 *
 * `country` is the already-normalised value, and the region is kept only when
 * it is `US`: state resolution exists for the United States and nowhere else,
 * so a subdivision reported for any other country is dropped at the beacon and
 * can never reach a row.
 */
export function normaliseRegion(country: string, raw?: unknown): string {
  if (country !== 'US') return '';
  const upper = asText(raw);
  return COUNTRY_CODE.test(upper) ? upper : '';
}

/** Platform tokens a tablet reports. Android tablets are the ones lacking the phone marker below. */
const TABLET_TOKENS = ['ipad', 'tablet', 'kindle', 'silk', 'playbook'];

/** Tokens a phone reports. `mobi` covers `Mobile` and `Mobi` alike. */
const PHONE_TOKENS = ['mobi', 'iphone', 'ipod'];

/** Tokens a desktop or laptop reports. */
const DESKTOP_TOKENS = ['windows', 'macintosh', 'mac os x', 'x11', 'linux', 'cros'];

/**
 * The coarse device family a user agent reports.
 *
 * The order of the tests is the whole of the logic: an Android tablet and an
 * Android phone report the same platform token and differ only by the phone
 * marker, so the tablet arm has to be decided before the phone arm, and both
 * before the desktop arm — an Android user agent also names Linux.
 */
export function deviceFamily(userAgent: string): GrowthDevice {
  const agent = userAgent.toLowerCase();
  const phone = PHONE_TOKENS.some((token) => agent.includes(token));
  if (TABLET_TOKENS.some((token) => agent.includes(token))) return 'tablet';
  if (agent.includes('android')) return phone ? 'mobile' : 'tablet';
  if (phone) return 'mobile';
  return DESKTOP_TOKENS.some((token) => agent.includes(token)) ? 'desktop' : 'other';
}

/**
 * The country and subdivision code the edge attached to an incoming request,
 * each exactly as it arrived and neither judged here — {@link normaliseCountry}
 * and {@link normaliseRegion} own every judgement about them.
 *
 * The properties are read as the untyped data they are rather than through the
 * platform's request declarations, because this file is compiled under
 * configurations that do not load those declarations: the web application and
 * the end-to-end suite reach this slice through the route types, and under both
 * the standard request type carries no such property. Reading them this way is
 * true under every configuration, and it is also the honest reading — they are
 * attached from outside the system, they are absent on every request that never
 * crossed the edge, and nothing here can check that a value arrived at all.
 */
export function edgeGeography(request: unknown): {
  readonly country: unknown;
  readonly region: unknown;
} {
  const nothing = { country: undefined, region: undefined };
  if (typeof request !== 'object' || request === null || !('cf' in request)) return nothing;
  const edge = request.cf;
  if (typeof edge !== 'object' || edge === null) return nothing;
  return {
    country: 'country' in edge ? edge.country : undefined,
    region: 'regionCode' in edge ? edge.regionCode : undefined,
  };
}
