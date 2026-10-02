import { requireSite } from '../lib/site-url';
import type { APIContext } from 'astro';

export function GET(context: APIContext): Response {
  const site = requireSite(context.site);

  const body = `# HushBox — ${site.origin}
#
# Public marketing pages are allowed by default.
# App routes are behind auth and not useful for indexing.

User-agent: *

# Public pages — explicitly allowed
Allow: /terms
Allow: /privacy
Allow: /blog

# App routes — not indexable
Disallow: /billing
Disallow: /settings
Disallow: /verify
Disallow: /dev
Disallow: /share
Disallow: /usage
Disallow: /demo

# Assets — no need to index images/scripts
Disallow: /assets

Sitemap: ${new URL('/sitemap-index.xml', site).toString()}
`;

  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
