/**
 * Reduce the configured document-sandbox URL (`SANDBOX_ORIGIN_URL`) to the bare
 * origin `scheme://host[:port]` that a Content-Security-Policy names.
 *
 * The policies that name this origin have to agree token for token — the app
 * origin's `frame-src` says which origin may be framed, and the sandbox origin's
 * own fetch directives say which origin its pages may load from — so they derive
 * it here rather than each spelling the reduction out. A divergence in scheme,
 * host or port leaves the renderer frame unable to load its own scripts.
 *
 * Every rejection below is wrong for all of them, so they are unioned rather
 * than chosen between: an absent or empty value names no origin at all, an
 * unparseable one cannot be reduced to one, and a non-http(s) scheme reduces to
 * the opaque origin `null`, which as a policy token matches nothing while
 * reading like a configured host.
 */
export function resolveSandboxOrigin(configuredUrl: string | undefined): string {
  if (configuredUrl === undefined || configuredUrl === '') {
    throw new Error(
      'SANDBOX_ORIGIN_URL is not set, so no policy can name the document sandbox origin. Run `pnpm generate:env`.'
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error(
      `SANDBOX_ORIGIN_URL is not a valid URL: ${JSON.stringify(configuredUrl)}. Set it in the build env or run \`pnpm generate:env\`.`
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`SANDBOX_ORIGIN_URL must use http or https, got "${parsed.protocol}"`);
  }
  return parsed.origin;
}
