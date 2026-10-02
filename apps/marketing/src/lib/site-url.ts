/**
 * The single accessor for the configured canonical site URL. Astro hands `site`
 * to pages as `Astro.site` and to endpoints as `context.site`, both typed
 * optional; every absolute URL the site emits (canonical, og:image, RSS,
 * JSON-LD) derives from it, so an absent one fails the build here rather than
 * being substituted with a default that silently ships the wrong origin.
 */
export function requireSite(site: URL | undefined): URL {
  if (site === undefined) {
    throw new Error('astro.config.mjs must set `site`: absolute URLs are derived from it.');
  }
  return site;
}
