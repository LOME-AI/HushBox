/**
 * The authoritative security posture the sandbox origin serves. This
 * Content-Security-Policy IS the containment model for untrusted document code:
 * document code may load ES modules (script-src the served origin + the module
 * CDN + `blob:` for the in-browser-transpiled module), run its own inline scripts
 * (`'unsafe-inline'`), instantiate WebAssembly (`'wasm-unsafe-eval'`), and reach
 * nothing else on the network. `'unsafe-inline'` is required, not a weakening:
 * the sandbox exists to execute the document's own scripts — an html document IS
 * inline `<script>`, classic or module — and a static file cannot mint a
 * per-response nonce for arbitrary user code. Inline execution grants no new
 * capability: containment is the opaque origin plus the network lockdown
 * (connect-src, frame/child/worker/object `'none'`, and the deleted WebRTC
 * constructors), never script-src. Everything not explicitly enumerated is
 * denied: `default-src 'none'` is the floor, so any fetch directive left unset
 * blocks. `frame-src`/`child-src`/`worker-src`/`object-src` are pinned to
 * `'none'` so untrusted code cannot spawn a child frame, worker, or object to
 * obtain a fresh realm — which would restore the WebRTC constructors the
 * bootstrap deletes (`neutralize-webrtc.ts`), since `webrtc 'block'` here is a
 * draft directive Chromium does not enforce. It is kept anyway for engines that
 * may honor it later. `frame-ancestors` limits embedders to the web app and the
 * mobile app-shell origins of the mode the caller names: production admits the
 * native production origins and nothing on localhost; every other mode admits
 * the local stack's embedders instead, whose web app and Android dev shell are
 * `http://localhost` on an arbitrary port, matched with `:*`. Admitting every
 * local port outside production is an accepted exposure, not an oversight: this
 * origin is credential-free and issues no `Set-Cookie`
 * (`e2e/security/document-sandbox-containment.spec.ts` proves it), so an
 * embedding page has nothing to steal, and a hostile local page could run the
 * same document code itself. What stays available is clickjacking-shaped, and
 * only to a page already on the user's own machine. The mode is an input rather
 * than read off the served origin, because Cloudflare's local assets runtime
 * serves the production policy from a localhost origin.
 *
 * The policy is a function of the origin it is served under, and no directive
 * here carries `'self'`. The frame that runs document code is
 * sandboxed without `allow-same-origin`, so its document has an opaque origin.
 * Measured on WebKit inside that frame, each under a source list shaped like
 * this one but carrying `'self'`:
 *
 * - in the committed browser harness (`apps/sandbox/src/csp.browser.test.ts`),
 *   over that harness's `http:` origin, the page was refused its own scripts
 *   where the token was all that named them;
 * - in an ad-hoc probe over an `https:` origin, the page loaded its own scripts
 *   where the token was all that named them, an off-policy `https:` script was
 *   delivered and ran, a cross-origin POST body was delivered and its reply
 *   read, and an `http://127.0.0.1` target was refused in the same run.
 *
 * Every engine figure recorded here is Playwright's bundled build: Safari and
 * iOS WKWebView ship this engine, but neither product was measured.
 *
 * The rule that follows, and the whole of what a reader needs: every fetch
 * directive names the origin these pages are served from, explicitly, and the
 * token is not re-added. That spelling is enforced as written on Chromium,
 * Firefox and WebKit alike, which the browser suite pins on all three;
 * `apps/sandbox/src/csp.test.ts` fails if the token returns. Each caller
 * supplies the origin it serves under: the dev server its own, the browser
 * harness the ephemeral one it binds, and the committed `_headers` the
 * production one.
 *
 * The origin is named in every fetch directive that must reach these pages
 * rather than only the one with a consumer today. `script-src` is what stops
 * the page booting and `connect-src` what stops the Python runtime fetching its
 * interpreter, lock file and stdlib from this origin; `img-src`, `style-src`
 * and `font-src` have no same-origin consumer yet and are treated alike so that
 * adding one is not a second widening. `base-uri` and `form-action` are both
 * `'none'`, and no page this origin serves sets a `<base>` or carries a form.
 *
 * The policy differs per entry point in exactly one directive. Only the Python
 * runtime installs wheels, so only `/python.html` may reach PyPI; `/render.html`
 * and every other asset reach nothing but the origin they are served from, which
 * is where the Python runtime's interpreter, lock file and stdlib are
 * self-hosted.
 *
 * This module is the one source of those strings, and every consumer reads it
 * rather than restating them: the local dev server injects the policy for the
 * path it is serving, the browser integration harnesses apply it to the pages
 * they drive, and the committed `public/_headers` (a static file Cloudflare
 * serves in production, which cannot import TypeScript) is pinned to the policy
 * derived for the production origin by a drift test. A future edit that changes
 * a policy in one place without the others fails that test.
 */

// The narrow subpath, never the barrel: this origin is credential-free, and a
// barrel import inlines the backend env registry into its public bundle.
import { capacitorOrigins } from '@hushbox/shared/origins';

/**
 * The `script-src` sources every sandbox page permits besides the origin it is
 * served from. Exported so the module-CDN reachability check reads the one list
 * that builds the directive rather than a second copy of it.
 */
export const SANDBOX_SCRIPT_SOURCES: readonly string[] = [
  "'unsafe-inline'",
  "'wasm-unsafe-eval'",
  'blob:',
  'https://esm.sh',
];

/**
 * The `connect-src` sources every path but the Python runtime page reaches
 * besides the origin it is served from: none. The renderer fetches its own
 * origin's assets and nothing else.
 */
const DEFAULT_CONNECT_SOURCES: readonly string[] = [];

/**
 * The `connect-src` sources the Python runtime page reaches besides the origin
 * it is served from: the two hosts micropip fetches from (pypi.org for the
 * PEP 691 index, files.pythonhosted.org for the wheels).
 */
const PYTHON_CONNECT_SOURCES: readonly string[] = [
  'https://pypi.org',
  'https://files.pythonhosted.org',
];

/**
 * Refuse anything that is not a bare origin. A value carrying a space or a `;`
 * would not widen `script-src` — it would rewrite the policy, since those are
 * the separators the CSP parser splits sources and directives on. `URL.origin`
 * round-tripping is the check: it rejects a path, a query, credentials and
 * trailing whitespace in one comparison.
 */
function assertServedOrigin(servedOrigin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(servedOrigin);
  } catch {
    throw new Error(
      `the sandbox CSP needs the origin its pages are served from, and ${JSON.stringify(servedOrigin)} is not a URL.`
    );
  }
  if (parsed.origin !== servedOrigin) {
    throw new Error(
      `the sandbox CSP needs a bare origin; ${JSON.stringify(servedOrigin)} carries more than one (its origin is ${parsed.origin}).`
    );
  }
}

/** The embedders the policy admits in production or in any other mode. */
function frameAncestors(isProduction: boolean): readonly string[] {
  if (isProduction) return ['https://hushbox.ai', ...capacitorOrigins(true)];
  const [ios, android] = capacitorOrigins(false);
  return ['https://hushbox.ai', ios, `${android}:*`];
}

/** The policy for a page served from `servedOrigin` reaching `connectSources`. */
function sandboxCsp(
  servedOrigin: string,
  connectSources: readonly string[],
  isProduction: boolean
): string {
  assertServedOrigin(servedOrigin);
  return (
    `default-src 'none'; script-src ${SANDBOX_SCRIPT_SOURCES.join(' ')} ${servedOrigin}; ` +
    `worker-src 'none'; connect-src ${[...connectSources, servedOrigin].join(' ')}; ` +
    "frame-src 'none'; child-src 'none'; object-src 'none'; webrtc 'block'; " +
    `img-src blob: data: ${servedOrigin}; ` +
    `style-src 'unsafe-inline' ${servedOrigin}; ` +
    `font-src data: ${servedOrigin}; ` +
    `frame-ancestors ${frameAncestors(isProduction).join(' ')}; ` +
    // No page this origin serves carries a form, and the document iframe's
    // sandbox attribute (`DOCUMENT_IFRAME_SANDBOX_ATTR` in
    // `packages/shared/src/documents/containment.ts`) omits `allow-forms`, so
    // denying every submission target outright costs these pages nothing.
    "base-uri 'none'; form-action 'none'"
  );
}

/** The one path served the policy that reaches the PyPI wheel hosts. */
export const PYTHON_PAGE_PATH = '/python.html';

/**
 * The policy a request for `pathname` on `servedOrigin` is answered with, in
 * production or in any other mode.
 */
export function sandboxCspFor(
  pathname: string,
  servedOrigin: string,
  isProduction: boolean
): string {
  return sandboxCsp(
    servedOrigin,
    pathname === PYTHON_PAGE_PATH ? PYTHON_CONNECT_SOURCES : DEFAULT_CONNECT_SOURCES,
    isProduction
  );
}

/**
 * The security response headers the sandbox origin serves for `pathname` when it
 * is reached at `servedOrigin`. `X-DNS-Prefetch-Control: off` closes the
 * hostname-leak channel CSP cannot cover (`<link rel="dns-prefetch">` encoding
 * data into a lookup). The dev server and the static `_headers` both carry these.
 */
export function sandboxSecurityHeaders(
  pathname: string,
  servedOrigin: string,
  isProduction: boolean
): Readonly<Record<string, string>> {
  return {
    'Content-Security-Policy': sandboxCspFor(pathname, servedOrigin, isProduction),
    'X-DNS-Prefetch-Control': 'off',
  };
}

/** Space-separated tokens of one CSP directive, the directive name dropped. */
export function cspDirectiveTokens(csp: string, name: string): string[] {
  const directive = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
  if (directive === undefined) throw new Error(`no ${name} directive in CSP`);
  return directive.split(/\s+/).slice(1);
}
