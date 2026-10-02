/**
 * The containment policy the app applies to the document sandbox iframe, owned
 * here so the app and the security corpus cannot state it differently.
 */

/**
 * The exact `sandbox` attribute the app puts on the document iframe. Shared
 * rather than mirrored: it decides whether untrusted document code gets
 * same-origin access, so a copy would let the corpus prove a frame that is not
 * the one the app ships. Loosening it (adding `allow-same-origin`,
 * `allow-popups`, `allow-top-navigation`, or `allow-modals`) changes this one
 * place, and every pin of the value fails.
 */
export const DOCUMENT_IFRAME_SANDBOX_ATTR = 'allow-scripts';

/**
 * The `frame-src` source list an HTML document declares in its
 * Content-Security-Policy meta tag, or null when it declares none. Returns
 * every source, so a widened policy is visible to a caller asserting the list
 * exactly — which is the only assertion shape that rejects an extra origin.
 */
export function frameSourceList(html: string): string[] | null {
  const [, policy] =
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html) ?? [];
  if (policy === undefined) return null;
  // Anchored on the policy's start or a directive boundary, so a directive
  // merely ending in `frame-src` is not read as one.
  const [, sources] = /(?:^|;)\s*frame-src\s+([^;]*)/i.exec(policy) ?? [];
  if (sources === undefined) return null;
  return sources.trim().split(/\s+/);
}
