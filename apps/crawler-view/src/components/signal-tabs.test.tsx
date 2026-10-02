import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SignalTabs } from './signal-tabs';
import type {
  Audience,
  CrawlView,
  Finding,
  HeadInfo,
  HttpInfo,
  RobotsInfo,
  SitemapInfo,
} from '../engine';

const PASSING_VERDICT: Record<Audience, Finding[]> = {
  ai: [{ level: 'pass', message: 'No blocking issues.', bots: [] }],
  search: [{ level: 'pass', message: 'No blocking issues.', bots: [] }],
  social: [{ level: 'pass', message: 'No blocking issues.', bots: [] }],
};

const BASE: CrawlView = {
  url: 'https://example.test/page',
  fetchedAt: '2026-09-14',
  http: {
    status: 200,
    ok: true,
    finalUrl: 'https://example.test/page',
    redirectChain: [],
    contentType: 'text/html; charset=utf-8',
    xRobotsTag: null,
  },
  head: {
    title: 'Example page',
    metaDescription: 'An example page description.',
    robotsMeta: { index: true, follow: true, raw: null },
    canonical: 'https://example.test/page',
    canonicalIsCrossOrigin: false,
    viewport: 'width=device-width, initial-scale=1',
    hreflang: [],
    rssAlternate: null,
  },
  openGraph: {
    title: null,
    description: null,
    type: null,
    url: null,
    siteName: null,
    image: null,
    imageStatus: { checked: false, reachable: false, status: null },
  },
  twitter: { card: null, title: null, description: null, image: null },
  jsonLd: [],
  content: {
    h1Count: 1,
    headingOutline: [{ level: 1, text: 'Example heading' }],
    hasSkippedHeadingLevels: false,
    wordCount: 120,
    textToHtmlRatio: 0.4,
    links: { internal: 3, external: 1, nofollow: 0 },
    images: { total: 1, withAlt: 1 },
    textBlob: 'Readable prose a no-JavaScript crawler can ingest.',
  },
  robots: { fetched: true, xRobotsTag: null, perPersona: [] },
  sitemap: { checked: true, found: true, urlListed: true },
  cloaking: { checked: false, divergent: false, detail: null },
  verdict: PASSING_VERDICT,
};

function crawlView(overrides: Partial<CrawlView>): CrawlView {
  return { ...BASE, ...overrides };
}

function head(overrides: Partial<HeadInfo>): HeadInfo {
  return { ...BASE.head, ...overrides };
}

function http(overrides: Partial<HttpInfo>): HttpInfo {
  return { ...BASE.http, ...overrides };
}

function robots(overrides: Partial<RobotsInfo>): RobotsInfo {
  return { ...BASE.robots, ...overrides };
}

function sitemap(overrides: Partial<SitemapInfo>): SitemapInfo {
  return { ...BASE.sitemap, ...overrides };
}

/** The value a screen reader reads for a labelled row, found through its term. */
function rowValue(label: string): HTMLElement {
  const term = screen.getByText(label);
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement)) {
    throw new TypeError(`no value cell for row: ${label}`);
  }
  return value;
}

function openTab(name: string): void {
  fireEvent.mouseDown(screen.getByRole('tab', { name }));
}

describe('SignalTabs meta signals', () => {
  it('opens on the meta signals', () => {
    render(<SignalTabs view={BASE} />);

    expect(screen.getByRole('tab', { name: 'Meta & structured data' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(rowValue('Title')).toHaveTextContent('Example page');
  });

  it('reads the head signals the crawler received', () => {
    render(<SignalTabs view={BASE} />);

    expect(rowValue('Meta description')).toHaveTextContent('An example page description.');
    expect(rowValue('Canonical')).toHaveTextContent('https://example.test/page');
    expect(rowValue('Viewport')).toHaveTextContent('width=device-width, initial-scale=1');
  });

  it('calls a head value that is absent not set', () => {
    render(<SignalTabs view={crawlView({ head: head({ title: null }) })} />);

    expect(rowValue('Title')).toHaveTextContent('not set');
  });

  it('calls a head value that is present but empty not set', () => {
    render(<SignalTabs view={crawlView({ head: head({ metaDescription: '' }) })} />);

    expect(rowValue('Meta description')).toHaveTextContent('not set');
  });

  it('marks a canonical that points at another origin', () => {
    render(
      <SignalTabs
        view={crawlView({
          head: head({ canonical: 'https://other.test/page', canonicalIsCrossOrigin: true }),
        })}
      />
    );

    expect(rowValue('Canonical')).toHaveTextContent('cross-origin');
  });

  it('leaves a same-origin canonical unmarked', () => {
    render(<SignalTabs view={BASE} />);

    expect(rowValue('Canonical')).not.toHaveTextContent('cross-origin');
  });

  it('quotes the raw robots meta directive the page declared', () => {
    render(
      <SignalTabs
        view={crawlView({
          head: head({ robotsMeta: { index: false, follow: false, raw: 'noindex, nofollow' } }),
        })}
      />
    );

    expect(rowValue('Robots meta')).toHaveTextContent(
      'index=false, follow=false (noindex, nofollow)'
    );
  });

  it('reports the parsed robots meta flags when the page declared no directive', () => {
    render(<SignalTabs view={BASE} />);

    expect(rowValue('Robots meta')).toHaveTextContent('index=true, follow=true');
    expect(rowValue('Robots meta')).not.toHaveTextContent('(');
  });

  it('lists every hreflang alternate the head declares', () => {
    render(
      <SignalTabs
        view={crawlView({
          head: head({
            hreflang: [
              { lang: 'en', href: 'https://example.test/en' },
              { lang: 'fr', href: 'https://example.test/fr' },
            ],
          }),
        })}
      />
    );

    const value = rowValue('hreflang');
    expect(within(value).getByText('en: https://example.test/en')).toBeInTheDocument();
    expect(within(value).getByText('fr: https://example.test/fr')).toBeInTheDocument();
  });

  it('says none when the head declares no hreflang alternates', () => {
    render(<SignalTabs view={BASE} />);

    expect(rowValue('hreflang')).toHaveTextContent('none');
  });

  it('says so when the page carries no JSON-LD', () => {
    render(<SignalTabs view={BASE} />);

    expect(screen.getByText('No JSON-LD blocks found.')).toBeInTheDocument();
  });

  it('marks a JSON-LD block that parsed and names its types', () => {
    render(
      <SignalTabs
        view={crawlView({
          jsonLd: [{ raw: '{"@type":"Article"}', parsed: true, types: ['Article'], errors: [] }],
        })}
      />
    );

    expect(screen.getByText(/parsed/)).toBeInTheDocument();
    expect(screen.getByText('Article')).toBeInTheDocument();
  });

  it('marks a JSON-LD block that failed to parse and lists its errors', () => {
    render(
      <SignalTabs
        view={crawlView({
          jsonLd: [
            {
              raw: '{ oops',
              parsed: false,
              types: [],
              errors: ['Unexpected token o in JSON at position 2'],
            },
          ],
        })}
      />
    );

    expect(screen.getByText(/invalid/)).toBeInTheDocument();
    expect(screen.getByText('Unexpected token o in JSON at position 2')).toBeInTheDocument();
  });
});

describe('SignalTabs robots signals', () => {
  it('shows yes for each robots or sitemap flag the crawl found true', () => {
    render(<SignalTabs view={BASE} />);
    openTab('Robots & sitemap');

    expect(rowValue('robots.txt fetched')).toHaveTextContent('yes');
    expect(rowValue('Sitemap checked')).toHaveTextContent('yes');
    expect(rowValue('Sitemap found')).toHaveTextContent('yes');
    expect(rowValue('URL listed in sitemap')).toHaveTextContent('yes');
  });

  it('shows no for each robots or sitemap flag the crawl found false', () => {
    render(
      <SignalTabs
        view={crawlView({
          robots: robots({ fetched: false }),
          sitemap: sitemap({ checked: false, found: false, urlListed: false }),
        })}
      />
    );
    openTab('Robots & sitemap');

    expect(rowValue('robots.txt fetched')).toHaveTextContent('no');
    expect(rowValue('Sitemap checked')).toHaveTextContent('no');
    expect(rowValue('Sitemap found')).toHaveTextContent('no');
    expect(rowValue('URL listed in sitemap')).toHaveTextContent('no');
  });

  it('reads the X-Robots-Tag header back on the robots signals', () => {
    render(<SignalTabs view={crawlView({ http: http({ xRobotsTag: 'noarchive' }) })} />);
    openTab('Robots & sitemap');

    expect(rowValue('X-Robots-Tag')).toHaveTextContent('noarchive');
  });

  it('names a known persona with its audience', () => {
    render(
      <SignalTabs
        view={crawlView({
          robots: robots({
            perPersona: [{ personaId: 'gptbot', allowed: true, matchedRule: 'Allow: /' }],
          }),
        })}
      />
    );
    openTab('Robots & sitemap');

    const row = screen.getByRole('row', { name: /GPTBot/ });
    expect(within(row).getByText('AI answer bots')).toBeInTheDocument();
  });

  it('falls back to the raw identifier for a persona the registry does not know', () => {
    render(
      <SignalTabs
        view={crawlView({
          robots: robots({
            perPersona: [{ personaId: 'ghostbot', allowed: true, matchedRule: null }],
          }),
        })}
      />
    );
    openTab('Robots & sitemap');

    const row = screen.getByRole('row', { name: /ghostbot/ });
    expect(within(row).getAllByRole('cell')[1]).toBeEmptyDOMElement();
  });

  it('marks a persona robots.txt permits as allowed', () => {
    render(
      <SignalTabs
        view={crawlView({
          robots: robots({
            perPersona: [{ personaId: 'googlebot', allowed: true, matchedRule: 'Allow: /' }],
          }),
        })}
      />
    );
    openTab('Robots & sitemap');

    const row = screen.getByRole('row', { name: /Googlebot/ });
    expect(within(row).getByText(/ALLOWED/)).toBeInTheDocument();
  });

  it('marks a persona robots.txt disallows as blocked', () => {
    render(
      <SignalTabs
        view={crawlView({
          robots: robots({
            perPersona: [{ personaId: 'googlebot', allowed: false, matchedRule: 'Disallow: /' }],
          }),
        })}
      />
    );
    openTab('Robots & sitemap');

    const row = screen.getByRole('row', { name: /Googlebot/ });
    expect(within(row).getByText(/BLOCKED/)).toBeInTheDocument();
  });

  it('quotes the robots.txt rule that decided a persona', () => {
    render(
      <SignalTabs
        view={crawlView({
          robots: robots({
            perPersona: [{ personaId: 'bingbot', allowed: false, matchedRule: 'Disallow: /docs' }],
          }),
        })}
      />
    );
    openTab('Robots & sitemap');

    const row = screen.getByRole('row', { name: /Bingbot/ });
    expect(within(row).getByText('Disallow: /docs')).toBeInTheDocument();
  });

  it('says none when no robots.txt rule matched a persona', () => {
    render(
      <SignalTabs
        view={crawlView({
          robots: robots({
            perPersona: [{ personaId: 'bingbot', allowed: true, matchedRule: null }],
          }),
        })}
      />
    );
    openTab('Robots & sitemap');

    const row = screen.getByRole('row', { name: /Bingbot/ });
    expect(within(row).getByText('none')).toBeInTheDocument();
  });
});

describe('SignalTabs HTTP signals', () => {
  it('reports a response the server served', () => {
    render(<SignalTabs view={BASE} />);
    openTab('HTTP');

    expect(rowValue('Status')).toHaveTextContent('200 (ok)');
    expect(rowValue('Final URL')).toHaveTextContent('https://example.test/page');
    expect(rowValue('Content-Type')).toHaveTextContent('text/html; charset=utf-8');
  });

  it('reports a response the server refused', () => {
    render(
      <SignalTabs view={crawlView({ http: http({ status: 503, ok: false, contentType: null }) })} />
    );
    openTab('HTTP');

    expect(rowValue('Status')).toHaveTextContent('503 (not ok)');
    expect(rowValue('Content-Type')).toHaveTextContent('not set');
  });

  it('lists every redirect hop the crawler followed', () => {
    render(
      <SignalTabs
        view={crawlView({
          http: http({
            redirectChain: [
              { from: 'https://example.test', to: 'https://example.test/page', status: 301 },
            ],
          }),
        })}
      />
    );
    openTab('HTTP');

    expect(rowValue('Redirect chain')).toHaveTextContent(
      '301: https://example.test -> https://example.test/page'
    );
  });

  it('says none when the response took no redirects', () => {
    render(<SignalTabs view={BASE} />);
    openTab('HTTP');

    expect(rowValue('Redirect chain')).toHaveTextContent('none');
  });
});

describe('SignalTabs crawler view', () => {
  it('renders the no-JavaScript frame on the crawler signals', () => {
    render(<SignalTabs view={BASE} />);
    openTab('Crawler view');

    expect(screen.getByTitle('No-JavaScript crawler view')).toBeInTheDocument();
  });
});
