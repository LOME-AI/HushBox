import { z } from 'zod';

/**
 * The three growth pattern sources, written once here and consumed three ways:
 * the Zod schemas below, the Postgres check constraints on the growth tables
 * (interpolated verbatim through `sql.raw`), and the marketing build's
 * event-name extractor. A drift between the schema and the column would let a
 * beacon write a Redis member the rollup could never insert, so the string is
 * the single authority and the regexes are derived from it.
 *
 * Each is POSIX ERE as well as JavaScript: no shorthand class, and a literal
 * hyphen only ever last inside a bracket expression, because Postgres reads
 * `~` operands as POSIX where a mid-expression hyphen is a range.
 *
 * None of them bounds length. The length lives beside the pattern in both
 * places: `length(col) <= N` in the column check, `.max(N)` in the schema.
 */

/** Pathname only: lowercase, digits, `/` and `-`. Admits the ceiling fold value `/other`. */
export const GROWTH_PATH_PATTERN = '^/[a-z0-9/-]*$';

/** Referrer hostname only. A value carrying `://` fails on the `:`, which is how the design's "rejected if it contains `://`" is enforced. Admits the ceiling fold value `other`. */
export const GROWTH_HOST_PATTERN = '^[a-z0-9][a-z0-9.-]*$';

/** Auto-captured event name: the `link:` prefix needs `:` and `/`, an external host name needs `.`, an element id needs `_`. */
export const GROWTH_EVENT_NAME_PATTERN = '^[a-z0-9][a-z0-9:/._-]*$';

/** Campaign tag. Bounded in the pattern itself because the `campaigns.tag` column check is exactly this expression. */
export const GROWTH_CAMPAIGN_TAG_PATTERN = '^[a-z0-9-]{1,40}$';

/** Maximum pathname length; mirrored by `length(path) <= 200` on every growth path column. */
export const GROWTH_PATH_MAX_LENGTH = 200;

/** Maximum hostname length; the DNS limit, mirrored by the `referrer_host` column check. */
export const GROWTH_HOST_MAX_LENGTH = 253;

/** Maximum event-name length; mirrored by the `event_name` column check. */
export const GROWTH_EVENT_NAME_MAX_LENGTH = 80;

const EVENT_NAME_REGEX = new RegExp(GROWTH_EVENT_NAME_PATTERN);

/** Whether a candidate satisfies both halves of the event-name contract — the pattern and the length bound. */
export function isGrowthEventName(candidate: string): boolean {
  return candidate.length <= GROWTH_EVENT_NAME_MAX_LENGTH && EVENT_NAME_REGEX.test(candidate);
}

/** Campaign tag, on the beacon body and the registration body alike. An unknown tag is folded to `unknown` by the reader, never rejected; this schema only rejects a malformed shape. */
export const campaignTagSchema = z.string().regex(new RegExp(GROWTH_CAMPAIGN_TAG_PATTERN));

/**
 * The tag a visit that named no campaign is counted under, and the first of the
 * two tags every count folds to when the visit names no usable campaign of its
 * own ({@link GROWTH_UNKNOWN_CAMPAIGN} is the other).
 *
 * Both are rows seeded into `campaigns`, so the campaign column is never null
 * and no count needs a null branch, and the archive operation refuses both:
 * archiving either would leave counts pointing at a tag that no longer
 * resolves. The seeding statement spells the two values out in SQL, which
 * cannot import them, so this module's own test pins the strings to it.
 */
export const GROWTH_DIRECT_CAMPAIGN = 'direct';

/**
 * The tag a visit naming a campaign nobody is running is counted under: the
 * visit is real and has to land somewhere, and refusing it would turn an
 * expired link into a failure on a marketing page. Seeded and archive-refused
 * on the same terms as {@link GROWTH_DIRECT_CAMPAIGN}.
 */
export const GROWTH_UNKNOWN_CAMPAIGN = 'unknown';
