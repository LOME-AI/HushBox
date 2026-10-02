import { describe, it, expect, afterEach, vi } from 'vitest';
import { listSitemapUrls } from './sitemap-lister';

const ORIGIN = 'http://localhost:4321';

interface Route {
  ok: boolean;
  body: string;
}

interface FakeFetch {
  impl: typeof fetch;
  requested: string[];
}

function requestedUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

/** A `fetch` over a url→body map: unmapped urls answer 404, listed prefixes never respond. */
function fakeFetch(routes: Record<string, Route>, unreachablePrefixes: string[] = []): FakeFetch {
  const requested: string[] = [];
  const impl: typeof fetch = (input) => {
    const url = requestedUrl(input);
    requested.push(url);
    if (unreachablePrefixes.some((prefix) => url.startsWith(prefix))) {
      return Promise.reject(new TypeError('fetch failed'));
    }
    const route = routes[url];
    if (route === undefined) {
      return Promise.resolve(new Response('', { status: 404 }));
    }
    return Promise.resolve(new Response(route.body, { status: route.ok ? 200 : 500 }));
  };
  return { impl, requested };
}

function urlset(...locs: string[]): Route {
  const entries = locs.map((loc) => `<url><loc>${loc}</loc></url>`).join('');
  return { ok: true, body: `<?xml version="1.0"?><urlset>${entries}</urlset>` };
}

function sitemapIndex(...children: string[]): Route {
  const entries = children.map((child) => `<sitemap><loc>${child}</loc></sitemap>`).join('');
  return { ok: true, body: `<?xml version="1.0"?><sitemapindex>${entries}</sitemapindex>` };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listSitemapUrls', () => {
  it('collects the page urls of the sitemap robots.txt declares', async () => {
    const { impl, requested } = fakeFetch({
      [`${ORIGIN}/robots.txt`]: { ok: true, body: `Sitemap: ${ORIGIN}/pages.xml\n` },
      [`${ORIGIN}/pages.xml`]: urlset(`${ORIGIN}/`, `${ORIGIN}/blog/`),
    });

    const listing = await listSitemapUrls(ORIGIN, impl);

    expect(listing).toEqual({ urls: [`${ORIGIN}/`, `${ORIGIN}/blog/`], reachable: true });
    expect(requested).not.toContain(`${ORIGIN}/sitemap.xml`);
  });

  it('reads a lowercase sitemap directive and ignores every other robots line', async () => {
    const { impl } = fakeFetch({
      [`${ORIGIN}/robots.txt`]: {
        ok: true,
        body: `User-agent: *\nDisallow: /drafts\n  sitemap: ${ORIGIN}/pages.xml\n`,
      },
      [`${ORIGIN}/pages.xml`]: urlset(`${ORIGIN}/`),
    });

    const listing = await listSitemapUrls(ORIGIN, impl);

    expect(listing.urls).toEqual([`${ORIGIN}/`]);
  });

  it('falls back to the conventional sitemap paths when robots declares none', async () => {
    const { impl, requested } = fakeFetch({
      [`${ORIGIN}/robots.txt`]: { ok: true, body: 'User-agent: *\n' },
      [`${ORIGIN}/sitemap.xml`]: urlset(`${ORIGIN}/only/`),
    });

    const listing = await listSitemapUrls(ORIGIN, impl);

    expect(listing.urls).toEqual([`${ORIGIN}/only/`]);
    expect(requested).toContain(`${ORIGIN}/sitemap-index.xml`);
  });

  it('falls back to the conventional sitemap paths when robots.txt is missing', async () => {
    const { impl } = fakeFetch({
      [`${ORIGIN}/sitemap.xml`]: urlset(`${ORIGIN}/only/`),
    });

    const listing = await listSitemapUrls(ORIGIN, impl);

    expect(listing.urls).toEqual([`${ORIGIN}/only/`]);
  });

  it('returns the page urls of the children a sitemap index lists, not the children themselves', async () => {
    const { impl } = fakeFetch({
      [`${ORIGIN}/sitemap-index.xml`]: sitemapIndex(`${ORIGIN}/pages-0.xml`),
      [`${ORIGIN}/pages-0.xml`]: urlset(`${ORIGIN}/a/`, `${ORIGIN}/b/`),
    });

    const listing = await listSitemapUrls(ORIGIN, impl);

    expect(listing.urls).toEqual([`${ORIGIN}/a/`, `${ORIGIN}/b/`]);
    expect(listing.urls).not.toContain(`${ORIGIN}/pages-0.xml`);
  });

  it('skips a child sitemap that does not resolve and keeps the rest', async () => {
    const { impl } = fakeFetch({
      [`${ORIGIN}/sitemap-index.xml`]: sitemapIndex(
        `${ORIGIN}/missing.xml`,
        `${ORIGIN}/pages-1.xml`
      ),
      [`${ORIGIN}/pages-1.xml`]: urlset(`${ORIGIN}/kept/`),
    });

    const listing = await listSitemapUrls(ORIGIN, impl);

    expect(listing).toEqual({ urls: [`${ORIGIN}/kept/`], reachable: true });
  });

  it('follows at most five children of a sitemap index', async () => {
    const children = Array.from(
      { length: 7 },
      (_unused, index) => `${ORIGIN}/pages-${String(index)}.xml`
    );
    const routes: Record<string, Route> = {
      [`${ORIGIN}/sitemap-index.xml`]: sitemapIndex(...children),
    };
    for (const [index, child] of children.entries()) {
      routes[child] = urlset(`${ORIGIN}/page-${String(index)}/`);
    }
    const { impl, requested } = fakeFetch(routes);

    const listing = await listSitemapUrls(ORIGIN, impl);

    expect(listing.urls).toHaveLength(5);
    expect(requested).not.toContain(`${ORIGIN}/pages-5.xml`);
  });

  it('trims the whitespace around a loc value', async () => {
    const { impl } = fakeFetch({
      [`${ORIGIN}/sitemap.xml`]: {
        ok: true,
        body: `<urlset><url><loc>\n  ${ORIGIN}/spaced/\n</loc></url></urlset>`,
      },
    });

    const listing = await listSitemapUrls(ORIGIN, impl);

    expect(listing.urls).toEqual([`${ORIGIN}/spaced/`]);
  });

  it('lists a url declared by two sitemaps once', async () => {
    const { impl } = fakeFetch({
      [`${ORIGIN}/robots.txt`]: {
        ok: true,
        body: `Sitemap: ${ORIGIN}/one.xml\nSitemap: ${ORIGIN}/two.xml\n`,
      },
      [`${ORIGIN}/one.xml`]: urlset(`${ORIGIN}/shared/`),
      [`${ORIGIN}/two.xml`]: urlset(`${ORIGIN}/shared/`, `${ORIGIN}/other/`),
    });

    const listing = await listSitemapUrls(ORIGIN, impl);

    expect(listing.urls).toEqual([`${ORIGIN}/shared/`, `${ORIGIN}/other/`]);
  });

  it('reports the origin reachable with no urls when it answers but publishes no sitemap', async () => {
    const { impl } = fakeFetch({});

    const listing = await listSitemapUrls(ORIGIN, impl);

    expect(listing).toEqual({ urls: [], reachable: true });
  });

  it('reports the origin unreachable when nothing ever responds', async () => {
    const { impl } = fakeFetch({}, [ORIGIN]);

    const listing = await listSitemapUrls(ORIGIN, impl);

    expect(listing).toEqual({ urls: [], reachable: false });
  });

  it('uses the global fetch when no implementation is supplied', async () => {
    const { impl, requested } = fakeFetch({
      [`${ORIGIN}/sitemap.xml`]: urlset(`${ORIGIN}/global/`),
    });
    vi.stubGlobal('fetch', impl);

    const listing = await listSitemapUrls(ORIGIN);

    expect(listing.urls).toEqual([`${ORIGIN}/global/`]);
    expect(requested).toContain(`${ORIGIN}/robots.txt`);
  });
});
