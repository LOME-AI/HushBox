import { fetchRaw } from './fetch-page.ts';
import { getPersona } from './personas.ts';
import { extractDocument } from './extract.ts';
import { checkImageReachable } from './og-image.ts';
import { analyzeRobots } from './robots.ts';
import { checkSitemap } from './sitemap.ts';
import { detectCloaking } from './cloaking.ts';
import { buildVerdict } from './verdict.ts';
import type { CrawlView, HttpInfo, OpenGraphInfo, RobotsInfo } from './types.ts';

interface AnalyzeOptions {
  fetchImpl?: typeof fetch;
}

/**
 * The crawler engine's single entry point. Fetches a URL exactly as a no-JS bot
 * would — one HTTP GET, no browser, no JavaScript — then extracts every crawler
 * signal and reduces them to an audience-grouped verdict. `fetchImpl` is the seam
 * that keeps the whole engine offline-testable.
 */
export async function analyzeUrl(url: string, options: AnalyzeOptions = {}): Promise<CrawlView> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `unsupported protocol: only http(s) URLs can be crawled, got ${parsedUrl.protocol}`
    );
  }

  const raw = await fetchRaw(url, getPersona('gptbot').userAgent, fetchImpl);
  const finalUrl = raw.finalUrl;
  const finalUrlParts = new URL(finalUrl);
  const origin = finalUrlParts.origin;
  const targetPath = `${finalUrlParts.pathname}${finalUrlParts.search}`;

  const extracted = extractDocument(raw.html, finalUrl);

  let openGraph: OpenGraphInfo = extracted.openGraph;
  if (openGraph.image !== null) {
    openGraph = {
      ...openGraph,
      imageStatus: await checkImageReachable(openGraph.image, fetchImpl),
    };
  }

  const [robotsAnalysis, cloaking] = await Promise.all([
    analyzeRobots(origin, targetPath, fetchImpl),
    detectCloaking(finalUrl, fetchImpl),
  ]);
  const sitemap = await checkSitemap(origin, finalUrl, robotsAnalysis.sitemaps, fetchImpl);

  const xRobotsTag = raw.headers.get('x-robots-tag');
  const http: HttpInfo = {
    status: raw.status,
    ok: raw.ok,
    finalUrl,
    redirectChain: raw.redirectChain,
    contentType: raw.headers.get('content-type'),
    xRobotsTag,
  };
  const robots: RobotsInfo = {
    fetched: robotsAnalysis.fetched,
    xRobotsTag,
    perPersona: robotsAnalysis.perPersona,
  };

  const base: Omit<CrawlView, 'verdict'> = {
    url,
    fetchedAt: new Date().toISOString(),
    http,
    head: extracted.head,
    openGraph,
    twitter: extracted.twitter,
    jsonLd: extracted.jsonLd,
    content: extracted.content,
    robots,
    sitemap,
    cloaking,
  };

  return { ...base, verdict: buildVerdict(base) };
}
