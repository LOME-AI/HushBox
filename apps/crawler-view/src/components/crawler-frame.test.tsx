import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CrawlerFrame } from './crawler-frame';
import type { ContentInfo } from '../engine';

function content(overrides: Partial<ContentInfo>): ContentInfo {
  return {
    h1Count: 1,
    headingOutline: [{ level: 1, text: 'Welcome' }],
    hasSkippedHeadingLevels: false,
    wordCount: 120,
    textToHtmlRatio: 0.4,
    links: { internal: 2, external: 1, nofollow: 0 },
    images: { total: 1, withAlt: 1 },
    textBlob: 'Readable prose a crawler can ingest.',
    ...overrides,
  };
}

function frameSource(): string {
  return screen.getByTitle('No-JavaScript crawler view').getAttribute('srcdoc') ?? '';
}

describe('CrawlerFrame', () => {
  it('rebuilds the captured heading outline at its captured levels', () => {
    render(
      <CrawlerFrame
        content={content({
          headingOutline: [
            { level: 1, text: 'Welcome' },
            { level: 2, text: 'Details' },
          ],
        })}
      />
    );

    expect(frameSource()).toContain('<h1>Welcome</h1>');
    expect(frameSource()).toContain('<h2>Details</h2>');
  });

  it('renders the captured body text as the frame paragraph', () => {
    render(
      <CrawlerFrame content={content({ textBlob: 'Readable prose a crawler can ingest.' })} />
    );

    expect(frameSource()).toContain('<p>Readable prose a crawler can ingest.</p>');
  });

  it('renders an empty body when the page yielded no crawlable text', () => {
    render(<CrawlerFrame content={content({ headingOutline: [], textBlob: '   ' })} />);

    expect(frameSource()).toContain('<body></body>');
  });

  it('escapes captured markup so the frame cannot reconstruct live elements', () => {
    render(
      <CrawlerFrame
        content={content({
          headingOutline: [{ level: 1, text: '<script>alert("x")</script>' }],
          textBlob: 'a & b',
        })}
      />
    );

    expect(frameSource()).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(frameSource()).toContain('<p>a &amp; b</p>');
  });

  it('denies the frame every sandbox permission, scripts included', () => {
    render(<CrawlerFrame content={content({})} />);

    expect(screen.getByTitle('No-JavaScript crawler view')).toHaveAttribute('sandbox', '');
  });
});
