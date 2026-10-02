import { MARKETING_BASE_URL } from '../platform/routes.ts';

import { GROWTH_EVENT_NAME_MAX_LENGTH, isGrowthEventName } from './patterns.ts';

/**
 * Maximum length of a name derived from an element's visible copy. Shorter
 * than the event-name bound on purpose: copy is the least stable source, and a
 * long headline would otherwise become an 80-character series key.
 */
export const GROWTH_EVENT_TEXT_MAX_LENGTH = 40;

/**
 * The elements a click is counted on: every link carrying a destination, and
 * every button.
 *
 * Declared once because every program that reads this set must agree or the
 * growth figures are wrong, and each way they can diverge is silent in its own
 * direction — a badge appears on an element the beacon never counted, the
 * committed click-name index carries a name no click can send, or an element a
 * visitor really clicks derives no name and is dropped where names are checked.
 */
export const GROWTH_CLICK_SELECTOR = 'a[href],button';

/**
 * The element shape {@link deriveEventName} reads. Structural rather than
 * `Element` so the one implementation runs unchanged in three places that do
 * not share a DOM: the inline marketing script in a browser, the marketing
 * build's extractor over built HTML, and the admin click overlay against a
 * framed page. The three must agree on a name or a badge would report a series
 * the beacon never wrote.
 */
export interface EventNameElement {
  readonly tagName: string;
  readonly textContent: string | null;
  getAttribute(qualifiedName: string): string | null;
}

/**
 * Tags whose value is typed by a person. The derivation refuses them before
 * reading any attribute, so no path exists from a form value to an event name
 * — the autocapture failure mode this design is built to make impossible.
 */
const FORM_CONTROL_TAGS = new Set(['input', 'textarea', 'select', 'option']);

const MARKETING_HOSTNAME = new URL(MARKETING_BASE_URL).hostname;

/** The optional override attribute. Read through `getAttribute` rather than `dataset`, because the extractor and the overlay hand this function element shapes that are not DOM nodes. */
const OVERRIDE_ATTRIBUTE = 'data-track';

/** Lower-cases and reduces a string to `a-z0-9` runs joined by single hyphens, capped at `maxLength`. */
function slugify(value: string, maxLength: number): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .slice(0, maxLength)
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/** A candidate lower-cased and returned only if it is already a legal name. */
function asName(candidate: string): string | null {
  const verbatim = candidate.trim().toLowerCase();
  return isGrowthEventName(verbatim) ? verbatim : null;
}

/**
 * An authored attribute lower-cased and taken as it stands when that alone
 * makes it a legal name, else slugified — so `id="heroCTA"` lands on
 * `herocta` and `data-track="Hero CTA"` on `hero-cta`, rather than on silence.
 */
function fromAttribute(value: string | null): string | null {
  if (value === null) return null;
  const verbatim = asName(value);
  if (verbatim !== null) return verbatim;
  const slug = slugify(value.trim(), GROWTH_EVENT_NAME_MAX_LENGTH);
  return isGrowthEventName(slug) ? slug : null;
}

/** Drops a query, a fragment and a trailing slash, so one destination has one name. */
function normalisePath(path: string): string {
  const bare = path.replace(/[?#][^]*$/, '');
  return bare.length > 1 && bare.endsWith('/') ? bare.slice(0, -1) : bare;
}

/**
 * `link:` plus the destination: the same-origin path where the href names one,
 * the hostname where it leaves the site. Returns `null` for an href that names
 * no page — a fragment, a `mailto:`, a `javascript:` — so the derivation falls
 * through to the label or the copy rather than minting `link:` names that
 * collide across every anchor on the page.
 *
 * Never slugified, unlike an authored attribute: a slugified destination is no
 * longer a destination, and a name past the length bound would truncate to one
 * the build's allowlist cannot contain, turning a dropped event into a
 * misattributed one.
 *
 * The site's own host comes from the constant, never from `location`: the admin
 * overlay reads the same markup from a different origin and must derive the
 * same name.
 */
function fromHref(href: string | null): string | null {
  if (href === null) return null;
  const trimmed = href.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return asName(`link:${normalisePath(trimmed)}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.hostname === MARKETING_HOSTNAME
    ? asName(`link:${normalisePath(parsed.pathname)}`)
    : asName(`link:${parsed.hostname}`);
}

/**
 * The name a click on `element` is counted under, or `null` when the element
 * yields none.
 *
 * Priority, first legal candidate winning: the `data-track` override, the
 * element id, a link's destination, the accessible label, the visible copy.
 * A candidate that cannot be made into a legal name falls through to the next,
 * so a mistyped override degrades to the next source rather than to silence.
 *
 * This is the single implementation behind the marketing script, the build-time
 * allowlist extractor and the admin overlay. The beacon validates what it
 * receives against the allowlist the extractor emitted, so a disagreement here
 * would silently drop events rather than misreport them.
 */
export function deriveEventName(element: EventNameElement): string | null {
  if (FORM_CONTROL_TAGS.has(element.tagName.toLowerCase())) return null;

  const override = fromAttribute(element.getAttribute(OVERRIDE_ATTRIBUTE));
  if (override !== null) return override;

  const id = fromAttribute(element.getAttribute('id'));
  if (id !== null) return id;

  const link = fromHref(element.getAttribute('href'));
  if (link !== null) return link;

  const label = fromAttribute(element.getAttribute('aria-label'));
  if (label !== null) return label;

  const text = slugify((element.textContent ?? '').trim(), GROWTH_EVENT_TEXT_MAX_LENGTH);
  return isGrowthEventName(text) ? text : null;
}
