import { z } from 'zod';
import { applyCors, getQueryParameter, handlePreflight, sendJson } from './http.ts';
import { listSitemapUrls } from './sitemap-lister.ts';
import type { CrawlView } from '../engine/index.ts';
import type { RequestLike, ResponseLike } from './http.ts';

/**
 * Protocol is the only constraint, deliberately: nothing narrows the host, and
 * `fetchRaw` re-requests each redirect hop without re-validating it, so any page
 * on a localhost origin can drive `/api/crawl` to read a local service or a
 * metadata endpoint and receive the body back. That is an accepted risk, not an
 * oversight — this tool is dev-only and the reader must already be a page the
 * developer opened locally, because the dev server binds loopback
 * (`../../vite.config.ts`, pinned by `./loopback-binding.test.ts`) and the one
 * origin that runs untrusted code locally cannot reach it: the sandbox CSP's
 * `connect-src` permits `'self'`, the sandbox origin those pages are served
 * from, and the two PyPI hosts only
 * (`apps/sandbox/public/_headers`, pinned by `apps/sandbox/src/headers.test.ts`).
 * Widening either of those two facts reopens the risk.
 */
const absoluteHttpUrl = z.string().refine(
  (value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'must be an absolute http(s) URL' }
);

interface CrawlDeps {
  analyzeImpl: (url: string) => Promise<CrawlView>;
}

/**
 * `GET /api/crawl?url=<absolute http(s) url>` → runs the engine and returns the
 * `CrawlView` as JSON. Always answers with structured JSON — never an HTML error
 * page — and never leaks an engine stack to the client.
 */
export async function handleCrawl(
  req: RequestLike,
  res: ResponseLike,
  deps: CrawlDeps
): Promise<void> {
  applyCors(req, res);
  if (handlePreflight(req, res)) {
    return;
  }

  const raw = getQueryParameter(req.url, 'url');
  const parsed = absoluteHttpUrl.safeParse(raw);
  if (!parsed.success) {
    sendJson(res, 400, {
      error: {
        code: 'invalid_url',
        message: 'Provide `url` as an absolute http(s) URL, e.g. ?url=http://localhost:4321/.',
      },
    });
    return;
  }

  try {
    const view = await deps.analyzeImpl(parsed.data);
    sendJson(res, 200, view);
  } catch (error) {
    // Dev-only tool server: a plain console line is fine, but log the message only
    // (no stack, no response body) and return an opaque error to the client.
    console.error('[crawler-api] analyze failed:', error instanceof Error ? error.message : error);
    sendJson(res, 502, {
      error: { code: 'analyze_failed', message: 'Failed to analyze the requested URL.' },
    });
  }
}

interface SitemapDeps {
  fetchImpl: typeof fetch;
  marketingOrigin: string | null;
  webOrigin: string | null;
}

interface SitemapTarget {
  label: string;
  origin: string;
  urls: string[];
  unreachable?: boolean;
}

/**
 * `GET /api/sitemap` → the local dev pages that populate the dashboard's page
 * picker. A target whose origin never responds is reported `unreachable: true`
 * with `urls: []` rather than failing the whole request; an unset port is skipped.
 */
export async function handleSitemap(
  req: RequestLike,
  res: ResponseLike,
  deps: SitemapDeps
): Promise<void> {
  applyCors(req, res);
  if (handlePreflight(req, res)) {
    return;
  }

  const configured = [
    { label: 'marketing', origin: deps.marketingOrigin },
    { label: 'web', origin: deps.webOrigin },
  ].filter((entry): entry is { label: string; origin: string } => entry.origin !== null);

  const targets: SitemapTarget[] = [];
  for (const { label, origin } of configured) {
    const { urls, reachable } = await listSitemapUrls(origin, deps.fetchImpl);
    targets.push(
      reachable ? { label, origin, urls } : { label, origin, urls: [], unreachable: true }
    );
  }

  sendJson(res, 200, { targets });
}
