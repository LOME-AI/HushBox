import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Dashboard } from './dashboard';
import { analyzeUrl } from '../engine';
import { HEALTHY_PAGE } from '../engine/__fixtures__/pages';
import { mockFetch } from '../engine/__test-fixtures-mocks__/mock-fetch';
import type { SitemapResponse, SitemapTarget } from './api';

const PAGE_URL = 'https://example.com/';
const OTHER_URL = 'https://example.com/pricing';
const ROBOTS_TXT = 'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml';
const SITEMAP_XML = '<urlset><url><loc>https://example.com/</loc></url></urlset>';

// The package's one complete CrawlView belongs to the signal-tabs test. Running the
// real engine over the shared HTML fixture yields a view here instead of a second
// copy of that shape, which would drift from it.
const CRAWL_VIEW = await analyzeUrl(PAGE_URL, {
  fetchImpl: mockFetch(({ url }) => {
    if (url.pathname === '/robots.txt') {
      return new Response(ROBOTS_TXT, { status: 200 });
    }
    if (url.pathname === '/sitemap.xml') {
      return new Response(SITEMAP_XML, { status: 200 });
    }
    if (url.pathname === '/og.png' || url.pathname === '/tw.png') {
      return new Response(null, { status: 200 });
    }
    return new Response(HEALTHY_PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
  }),
});

const WEB_ORIGIN = 'http://localhost:5173';

const MARKETING_TARGET: SitemapTarget = {
  label: 'marketing',
  origin: 'http://localhost:4321',
  urls: ['http://localhost:4321/'],
};

const WEB_TARGET: SitemapTarget = {
  label: 'web',
  origin: WEB_ORIGIN,
  urls: [`${WEB_ORIGIN}/chat`],
};

const SITEMAP: SitemapResponse = { targets: [MARKETING_TARGET, WEB_TARGET] };

const MARKETING_ONLY: SitemapResponse = { targets: [MARKETING_TARGET] };

interface PendingRequest {
  readonly path: string;
  readonly resolve: (response: Response) => void;
  readonly reject: (error: unknown) => void;
}

interface FetchStub {
  readonly crawls: PendingRequest[];
  readonly sitemaps: PendingRequest[];
}

function requestedPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

/** Every request stays pending until a test settles it, so loading states are observable. */
function stubFetch(): FetchStub {
  const crawls: PendingRequest[] = [];
  const sitemaps: PendingRequest[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL): Promise<Response> => {
    const path = requestedPath(input);
    return new Promise<Response>((resolve, reject) => {
      (path.startsWith('/api/sitemap') ? sitemaps : crawls).push({ path, resolve, reject });
    });
  });
  return { crawls, sitemaps };
}

function requestAt(queue: PendingRequest[], index: number): PendingRequest {
  const request = queue[index];
  if (request === undefined) {
    throw new Error(`no request at index ${String(index)}`);
  }
  return request;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** A macrotask tick drains the promise chain `fetch` → `json()` → `setState`. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function settle(request: PendingRequest, response: Response): Promise<void> {
  await act(async () => {
    request.resolve(response);
    await tick();
  });
}

async function fail(request: PendingRequest, error: unknown): Promise<void> {
  await act(async () => {
    request.reject(error);
    await tick();
  });
}

function deepLink(url: string): void {
  globalThis.history.replaceState(null, '', `/?url=${encodeURIComponent(url)}`);
}

function analyzeFromBar(url: string): void {
  fireEvent.change(screen.getByLabelText('Page URL'), { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
}

beforeEach(() => {
  globalThis.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Dashboard', () => {
  it('renders the idle state and crawls nothing when no url is deep-linked', () => {
    const stub = stubFetch();

    render(<Dashboard />);

    expect(screen.getByText('Analyze a page')).toBeInTheDocument();
    expect(stub.crawls).toHaveLength(0);
  });

  it('treats a whitespace-only url parameter as no deep link', () => {
    globalThis.history.replaceState(null, '', '/?url=%20%20');
    const stub = stubFetch();

    render(<Dashboard />);

    expect(screen.getByText('Analyze a page')).toBeInTheDocument();
    expect(stub.crawls).toHaveLength(0);
  });

  it('shows the loading state for a deep-linked url while its crawl is in flight', () => {
    deepLink(PAGE_URL);
    const stub = stubFetch();

    render(<Dashboard />);

    expect(screen.getByText('Analyzing…')).toBeInTheDocument();
    expect(requestAt(stub.crawls, 0).path).toBe(`/api/crawl?url=${encodeURIComponent(PAGE_URL)}`);
  });

  it('renders the crawled view when a deep-linked crawl succeeds', async () => {
    deepLink(PAGE_URL);
    const stub = stubFetch();
    render(<Dashboard />);

    await settle(requestAt(stub.crawls, 0), json(CRAWL_VIEW));

    expect(screen.getByRole('tab', { name: 'Meta & structured data' })).toBeInTheDocument();
  });

  it('renders the error envelope when a deep-linked crawl fails', async () => {
    deepLink(PAGE_URL);
    const stub = stubFetch();
    render(<Dashboard />);

    await settle(
      requestAt(stub.crawls, 0),
      json({ error: { code: 'analyze_failed', message: 'Upstream refused.' } }, 502)
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Upstream refused.');
  });

  it('discards a deep-linked crawl that lands after a newer analysis replaced it', async () => {
    deepLink(PAGE_URL);
    const stub = stubFetch();
    render(<Dashboard />);
    analyzeFromBar(OTHER_URL);

    await settle(requestAt(stub.crawls, 0), json(CRAWL_VIEW));

    expect(screen.getByText('Analyzing…')).toBeInTheDocument();
    expect(screen.getByText(OTHER_URL)).toBeInTheDocument();
  });

  it('reflects the analyzed url into the query string', () => {
    stubFetch();
    render(<Dashboard />);

    analyzeFromBar(PAGE_URL);

    expect(new URLSearchParams(globalThis.location.search).get('url')).toBe(PAGE_URL);
  });

  it('renders the crawled view for a url analyzed from the bar', async () => {
    const stub = stubFetch();
    render(<Dashboard />);
    analyzeFromBar(PAGE_URL);

    await settle(requestAt(stub.crawls, 0), json(CRAWL_VIEW));

    expect(screen.getByRole('tab', { name: 'Meta & structured data' })).toBeInTheDocument();
  });

  it('renders the error envelope when an analysis from the bar fails', async () => {
    const stub = stubFetch();
    render(<Dashboard />);
    analyzeFromBar('nonsense');

    await settle(
      requestAt(stub.crawls, 0),
      json({ error: { code: 'invalid_url', message: 'Provide `url`.' } }, 400)
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Provide `url`.');
  });

  it('discards an analysis that lands after a newer one replaced it', async () => {
    const stub = stubFetch();
    render(<Dashboard />);
    analyzeFromBar(PAGE_URL);
    analyzeFromBar(OTHER_URL);

    await settle(requestAt(stub.crawls, 0), json(CRAWL_VIEW));

    expect(screen.getByText('Analyzing…')).toBeInTheDocument();
    expect(screen.getByText(OTHER_URL)).toBeInTheDocument();
  });

  it('lists the sitemap pages in the picker once the sitemap arrives', async () => {
    const stub = stubFetch();
    render(<Dashboard />);

    await settle(requestAt(stub.sitemaps, 0), json(SITEMAP));

    expect(screen.getByRole('option', { name: `${WEB_ORIGIN}/chat` })).toBeInTheDocument();
  });

  it('reports the failure message when the sitemap request fails', async () => {
    const stub = stubFetch();
    render(<Dashboard />);

    await fail(requestAt(stub.sitemaps, 0), new Error('connection refused'));

    expect(screen.getByText('Sitemap unavailable: connection refused')).toBeInTheDocument();
  });

  it('reports an unknown sitemap error when the failure carries no message', async () => {
    const stub = stubFetch();
    render(<Dashboard />);

    await fail(requestAt(stub.sitemaps, 0), 'not an error object');

    expect(screen.getByText('Sitemap unavailable: unknown error')).toBeInTheDocument();
  });

  it('discards a sitemap that arrives after unmount', async () => {
    const stub = stubFetch();
    const view = render(<Dashboard />);
    view.unmount();

    await settle(requestAt(stub.sitemaps, 0), json(SITEMAP));

    expect(view.container).toBeEmptyDOMElement();
  });

  it('discards a sitemap failure that arrives after unmount', async () => {
    const stub = stubFetch();
    const view = render(<Dashboard />);
    view.unmount();

    await fail(requestAt(stub.sitemaps, 0), new Error('connection refused'));

    expect(view.container).toBeEmptyDOMElement();
  });

  it('links back to the web app when the sitemap names a web origin', async () => {
    const stub = stubFetch();
    render(<Dashboard />);

    await settle(requestAt(stub.sitemaps, 0), json(SITEMAP));

    expect(screen.getByRole('link', { name: 'Back to /chat' })).toHaveAttribute(
      'href',
      `${WEB_ORIGIN}/chat`
    );
  });

  it('disables the way back when the sitemap names no web origin', async () => {
    const stub = stubFetch();
    render(<Dashboard />);

    await settle(requestAt(stub.sitemaps, 0), json(MARKETING_ONLY));

    expect(screen.getByRole('button', { name: 'Back to /chat' })).toBeDisabled();
  });

  it('swaps the crawled view for the page matrix on request', async () => {
    const stub = stubFetch();
    render(<Dashboard />);
    await settle(requestAt(stub.sitemaps, 0), json(SITEMAP));

    fireEvent.click(screen.getByRole('button', { name: 'Page matrix' }));

    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('returns to the dashboard from the page matrix on request', async () => {
    const stub = stubFetch();
    render(<Dashboard />);
    await settle(requestAt(stub.sitemaps, 0), json(SITEMAP));
    fireEvent.click(screen.getByRole('button', { name: 'Page matrix' }));

    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));

    expect(screen.getByText('Analyze a page')).toBeInTheDocument();
  });

  it('analyzes a page picked from the matrix on the dashboard', async () => {
    const stub = stubFetch();
    render(<Dashboard />);
    await settle(requestAt(stub.sitemaps, 0), json(SITEMAP));
    fireEvent.click(screen.getByRole('button', { name: 'Page matrix' }));

    fireEvent.click(screen.getByRole('button', { name: `${WEB_ORIGIN}/chat` }));

    expect(screen.getByText('Analyzing…')).toBeInTheDocument();
  });
});
