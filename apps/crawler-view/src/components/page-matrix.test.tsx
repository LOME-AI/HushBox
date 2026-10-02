import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PageMatrix } from './page-matrix';
import type { SitemapResponse } from '../app/api';
import type { Audience, CrawlView, Finding } from '../engine';

function sitemapOf(urls: string[]): SitemapResponse {
  return { targets: [{ label: 'marketing', origin: 'http://localhost:4321', urls }] };
}

function crawlBody(verdict: Record<Audience, Finding[]>): string {
  const body = { verdict } satisfies Pick<CrawlView, 'verdict'>;
  return JSON.stringify(body);
}

const CLEAN = crawlBody({ ai: [], search: [], social: [] });

/** Every crawl answers immediately with the same body and status. */
function stubImmediateFetch(body: string, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((): Promise<Response> => Promise.resolve(new Response(body, { status })))
  );
}

/** Every crawl hangs until `release` is called, so the pool can be observed mid-flight. */
function stubHangingFetch(): { requested: string[]; release: () => Promise<void> } {
  const requested: string[] = [];
  const waiting: ((response: Response) => void)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string): Promise<Response> => {
      requested.push(input);
      return new Promise<Response>((resolve) => {
        waiting.push(resolve);
      });
    })
  );
  return {
    requested,
    release: async (): Promise<void> => {
      await act(async () => {
        for (const answer of waiting.splice(0)) {
          answer(new Response(CLEAN, { status: 200 }));
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PageMatrix', () => {
  it('explains that there is nothing to compare when no target lists pages', () => {
    render(<PageMatrix sitemap={sitemapOf([])} onSelectPage={vi.fn()} />);

    expect(screen.getByText(/No sitemap pages to compare/i)).toBeVisible();
  });

  it('explains that there is nothing to compare before the sitemap has loaded', () => {
    render(<PageMatrix sitemap={null} onSelectPage={vi.fn()} />);

    expect(screen.getByText(/No sitemap pages to compare/i)).toBeVisible();
  });

  it('counts the pages it is comparing', () => {
    stubHangingFetch();
    render(
      <PageMatrix
        sitemap={sitemapOf(['http://localhost:4321/', 'http://localhost:4321/pricing'])}
        onSelectPage={vi.fn()}
      />
    );

    expect(screen.getByText(/^2 pages\./)).toBeVisible();
  });

  it('gives every audience its own column', () => {
    stubHangingFetch();
    render(<PageMatrix sitemap={sitemapOf(['http://localhost:4321/'])} onSelectPage={vi.fn()} />);

    expect(screen.getByRole('columnheader', { name: 'AI answer bots' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Search engines' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Social previews' })).toBeVisible();
  });

  it('shows every cell as pending until its crawl answers', () => {
    stubHangingFetch();
    render(<PageMatrix sitemap={sitemapOf(['http://localhost:4321/'])} onSelectPage={vi.fn()} />);

    expect(screen.getAllByText('…')).toHaveLength(3);
  });

  it('reports the worst finding per audience once the crawl answers', async () => {
    stubImmediateFetch(
      crawlBody({
        ai: [
          { level: 'warn', message: 'Thin content.', bots: [] },
          { level: 'fail', message: 'Near-empty page.', bots: [] },
        ],
        search: [{ level: 'warn', message: 'No canonical.', bots: [] }],
        social: [],
      })
    );
    render(<PageMatrix sitemap={sitemapOf(['http://localhost:4321/'])} onSelectPage={vi.fn()} />);

    expect(await screen.findByText('FAIL')).toBeVisible();
    expect(screen.getByText('WARN')).toBeVisible();
    expect(screen.getByText('PASS')).toBeVisible();
  });

  it('marks a row whose crawl failed rather than leaving it pending', async () => {
    stubImmediateFetch(
      JSON.stringify({ error: { code: 'analyze_failed', message: 'unreachable' } }),
      502
    );
    render(<PageMatrix sitemap={sitemapOf(['http://localhost:4321/'])} onSelectPage={vi.fn()} />);

    expect(await screen.findAllByText('error')).toHaveLength(3);
  });

  it('opens a page on the dashboard when its row is clicked', async () => {
    stubImmediateFetch(CLEAN);
    const onSelectPage = vi.fn();
    render(
      <PageMatrix
        sitemap={sitemapOf(['http://localhost:4321/pricing'])}
        onSelectPage={onSelectPage}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'http://localhost:4321/pricing' }));

    await waitFor(() => {
      expect(onSelectPage).toHaveBeenCalledWith('http://localhost:4321/pricing');
    });
  });

  it('crawls at most four pages at a time', () => {
    const { requested } = stubHangingFetch();
    render(
      <PageMatrix
        sitemap={sitemapOf([
          'http://localhost:4321/a',
          'http://localhost:4321/b',
          'http://localhost:4321/c',
          'http://localhost:4321/d',
          'http://localhost:4321/e',
        ])}
        onSelectPage={vi.fn()}
      />
    );

    expect(requested).toHaveLength(4);
  });

  it('stops crawling the remaining pages when the matrix is closed', async () => {
    const { requested, release } = stubHangingFetch();
    const { unmount } = render(
      <PageMatrix
        sitemap={sitemapOf([
          'http://localhost:4321/a',
          'http://localhost:4321/b',
          'http://localhost:4321/c',
          'http://localhost:4321/d',
          'http://localhost:4321/e',
        ])}
        onSelectPage={vi.fn()}
      />
    );

    unmount();
    await release();

    expect(requested).toHaveLength(4);
  });

  it('works through every page when the matrix stays open', async () => {
    const { requested, release } = stubHangingFetch();
    render(
      <PageMatrix
        sitemap={sitemapOf([
          'http://localhost:4321/a',
          'http://localhost:4321/b',
          'http://localhost:4321/c',
          'http://localhost:4321/d',
          'http://localhost:4321/e',
        ])}
        onSelectPage={vi.fn()}
      />
    );

    await release();

    await waitFor(() => {
      expect(requested).toHaveLength(5);
    });
  });
});
