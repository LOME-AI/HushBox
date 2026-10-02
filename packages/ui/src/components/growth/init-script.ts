import {
  GROWTH_BEACON_PATH,
  GROWTH_CAMPAIGN_TAG_PATTERN,
  GROWTH_CLICK_SELECTOR,
  GROWTH_EVENT_NAME_MAX_LENGTH,
  GROWTH_EVENT_NAME_PATTERN,
  GROWTH_EVENT_TEXT_MAX_LENGTH,
  GROWTH_SCROLL_EVENTS,
  MARKETING_BASE_URL,
} from '@hushbox/shared';
import type { EnvUtilities } from '@hushbox/shared';

/** The hostname the deployed marketing site is served at. */
const MARKETING_HOSTNAME = new URL(MARKETING_BASE_URL).hostname;

/**
 * The hostname a local stack serves the site at. `scripts/generate-env.ts`
 * rewrites every `<service>.localhost` in the environment registry to that
 * service's allocated `localhost:<port>`, so a development stack and an
 * end-to-end stack alike put the site — and every other local service — under
 * this one name, and only the port tells them apart.
 */
const LOCAL_HOSTNAME = 'localhost';

/**
 * The name the script gives its own body, so a build can run it for more than
 * one hostname. Declared once and interpolated into the definition and into
 * every call: a spelling written twice drifts into a script that parses and
 * counts nothing.
 */
const RUNNER = 'hbCount';

/**
 * Each scroll threshold paired with the name it is counted under, derived from
 * the shared names so nothing can disagree about which percentage `scroll-75`
 * stands for.
 */
const SCROLL_STEPS = GROWTH_SCROLL_EVENTS.map(
  (name) => [Number(name.slice(name.lastIndexOf('-') + 1)), name] as const
);

/**
 * The marketing site's anonymous counter, as one inline script.
 *
 * Inline rather than a module because `scripts/generate-headers.ts` hashes
 * every inline `<script>` body into that page's own Content-Security-Policy,
 * the way the theme and accessibility bootstraps are hashed; a module would
 * instead need a script host in `script-src` on a public origin.
 *
 * It sends one pageview, one event per click on a link or a button, and one
 * per scroll threshold reached. What it never does:
 *
 *  - **Write or read anything on the device.** No cookie and no storage of any
 *    class is named anywhere in this string, which is asserted over the text
 *    itself rather than left to review. The campaign tag lives in the address
 *    bar and dies with the tab.
 *  - **Read anything a person typed.** A click counts only against the nearest
 *    link or button ancestor, and the derivation refuses a form control
 *    outright, so no path runs from a field's contents to a name.
 *  - **Count anywhere but a hostname its own build admits.** The site is built
 *    a second time, framed inside the admin origin for the click overlay, and
 *    that copy returns at the first line.
 *  - **Retry.** Delivery is at-most-once from the client's side: a retry would
 *    double a count nothing downstream could tell from real traffic.
 *
 * Every literal it needs — the endpoint, the patterns, the length bounds, the
 * threshold names — is interpolated from `@hushbox/shared`, so the page and the
 * route that reads it cannot drift apart. The hostnames are the exception: they
 * arrive as calls appended by {@link growthInitScript}, one per hostname the
 * build counts on. The name derivation is
 * the one thing written twice: an inline script cannot import the shared
 * function, so the logic is transcribed here and a test in this directory
 * holds the transcription against `deriveEventName` over a fixture page
 * carrying every priority level and every fall-through.
 *
 * Written flat and terse against a 3 KB budget, because this string is
 * repeated verbatim in every marketing page's HTML and again, as a hash, in
 * that page's `_headers` block.
 */
const GROWTH_INIT_BODY = String.raw`
var ${RUNNER} = function (HOST) {
if (location.hostname !== HOST) return;
var EP = '${GROWTH_BEACON_PATH}';
var RE = new RegExp('${GROWTH_EVENT_NAME_PATTERN}');
var STEPS = ${JSON.stringify(SCROLL_STEPS)};
var tag = new URLSearchParams(location.search).get('c');
if (tag !== null && !new RegExp('${GROWTH_CAMPAIGN_TAG_PATTERN}').test(tag)) tag = null;
function send(b) {
b.p = location.pathname;
if (tag !== null) b.c = tag;
fetch(EP, {method: 'POST', keepalive: true, credentials: 'omit', headers: {'Content-Type': 'text/plain'}, body: JSON.stringify(b)}).catch(function () {});
}
function ok(n) { return n.length <= ${GROWTH_EVENT_NAME_MAX_LENGTH} && RE.test(n); }
function slug(s, m) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, m).replace(/^-+/, '').replace(/-+$/, ''); }
function plain(s) { var t = s.trim().toLowerCase(); return ok(t) ? t : null; }
function attr(a) { if (a === null) return null; var t = plain(a); if (t !== null) return t; var s = slug(a.trim(), ${GROWTH_EVENT_NAME_MAX_LENGTH}); return ok(s) ? s : null; }
function bare(p) { var b = p.replace(/[?#][^]*$/, ''); return b.length > 1 && /\/$/.test(b) ? b.slice(0, -1) : b; }
function dest(h) {
if (h === null) return null;
var t = h.trim(), u;
if (/^\/(?!\/)/.test(t)) return plain('link:' + bare(t));
try { u = new URL(t); } catch (e) { return null; }
if (!/^https?:$/.test(u.protocol)) return null;
return plain('link:' + (u.hostname === HOST ? bare(u.pathname) : u.hostname));
}
function named(el) {
var t = el.tagName.toLowerCase();
if (/^(input|textarea|select|option)$/.test(t)) return null;
return attr(el.getAttribute('data-track')) || attr(el.getAttribute('id')) || dest(el.getAttribute('href')) || attr(el.getAttribute('aria-label')) || plain(slug((el.textContent || '').trim(), ${GROWTH_EVENT_TEXT_MAX_LENGTH}));
}
var ref = '';
try { ref = document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) {}
send(ref && ref !== HOST ? {t: 'v', r: ref} : {t: 'v'});
document.addEventListener('click', function (e) {
var el = e.target && e.target.closest ? e.target.closest('${GROWTH_CLICK_SELECTOR}') : null;
var n = el ? named(el) : null;
if (n) send({t: 'e', n: n});
}, true);
var seen = {};
function depth() {
var d = document.documentElement, span = d.scrollHeight - d.clientHeight;
var pct = span > 0 ? (window.scrollY / span) * 100 : 100;
for (var i = 0, s; i < STEPS.length; i++) {
s = STEPS[i];
if (pct >= s[0] && !seen[s[1]]) {seen[s[1]] = 1; send({t: 'e', n: s[1]}); }
}
}
window.addEventListener('scroll', depth, {passive: true});
function start() {
if (tag !== null) {
var links = document.querySelectorAll('a[href]'), a, u;
for (var i = 0; i < links.length; i++) {
a = links[i];
try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { continue; }
if (u.origin !== location.origin || u.searchParams.has('c')) continue;
u.searchParams.set('c', tag);
a.setAttribute('href', u.pathname + u.search + u.hash);
}
}
depth();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
};
`;

/**
 * The script's own invocation for one hostname it counts on. Exactly one call
 * can get past the first line, because a page has one hostname, so a build
 * admitting several still counts a page once.
 */
function runFor(hostname: string): string {
  return `${RUNNER}('${hostname}');\n`;
}

/**
 * The script as a production build emits it: the body, then the one call for the
 * deployed site's own hostname.
 *
 * It is also the prefix of every other build's script, and
 * `apps/marketing/scripts/growth-index.ts` rests on that: the extractor decides
 * whether a built page renders the beacon by looking for this string in the
 * page's HTML, and raises on a build holding no such page.
 */
export const GROWTH_INIT_SCRIPT = `${GROWTH_INIT_BODY}${runFor(MARKETING_HOSTNAME)}`;

/**
 * The script the build described by `env` emits.
 *
 * A production build counts on the deployed site's hostname alone. Every other
 * build additionally counts on {@link LOCAL_HOSTNAME}, because that is where the
 * site is served outside production, and a beacon that never fires there leaves
 * the whole count unexercised. Which build this is comes from the mode, never
 * from whether some value happens to be set: the layouts resolve Vite's `MODE`
 * through `createEnvUtilities` and hand the answer here.
 *
 * The framed copy on the admin origin is a production build of the site, so it
 * carries the production script and stays silent wherever it is served —
 * a local stack included, where the admin origin's hostname is
 * {@link LOCAL_HOSTNAME} as well.
 */
export function growthInitScript(env: Pick<EnvUtilities, 'isProduction'>): string {
  return env.isProduction ? GROWTH_INIT_SCRIPT : `${GROWTH_INIT_SCRIPT}${runFor(LOCAL_HOSTNAME)}`;
}
