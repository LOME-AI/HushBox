import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LinkPreviewPanel } from './link-preview-panel';
import type { OpenGraphInfo } from '../engine';

function openGraph(overrides: Partial<OpenGraphInfo>): OpenGraphInfo {
  return {
    title: 'A Title',
    description: 'A description.',
    type: 'article',
    url: 'https://example.com/',
    siteName: 'Example',
    image: 'https://example.com/og.png',
    imageStatus: { checked: true, reachable: true, status: 200 },
    ...overrides,
  };
}

describe('LinkPreviewPanel', () => {
  it('shows an explicit broken-image state when the og:image is unreachable', () => {
    render(
      <LinkPreviewPanel
        openGraph={openGraph({ imageStatus: { checked: true, reachable: false, status: 404 } })}
      />
    );

    expect(screen.getByText(/Image unreachable/i)).toBeInTheDocument();
    expect(screen.getByText(/status 404/i)).toBeInTheDocument();
  });

  it('falls back to explicit placeholders when og fields are missing', () => {
    render(
      <LinkPreviewPanel openGraph={openGraph({ title: null, description: null, image: null })} />
    );

    expect(screen.getByText('(no og:title)')).toBeInTheDocument();
    expect(screen.getByText('No og:image')).toBeInTheDocument();
  });

  it('renders the og:image when it is reachable', () => {
    render(<LinkPreviewPanel openGraph={openGraph({})} />);

    expect(screen.getByRole('img', { name: 'Open Graph preview' })).toHaveAttribute(
      'src',
      'https://example.com/og.png'
    );
  });

  it('renders the og:image when reachability was never checked', () => {
    render(
      <LinkPreviewPanel
        openGraph={openGraph({ imageStatus: { checked: false, reachable: false, status: null } })}
      />
    );

    expect(screen.getByRole('img', { name: 'Open Graph preview' })).toBeInTheDocument();
  });

  it('names a transport failure when the image check returned no status', () => {
    render(
      <LinkPreviewPanel
        openGraph={openGraph({ imageStatus: { checked: true, reachable: false, status: null } })}
      />
    );

    expect(screen.getByText(/Image unreachable/i)).toBeInTheDocument();
    expect(screen.getByText('network error')).toBeInTheDocument();
  });

  it('omits the site name row when the page declares no og:site_name', () => {
    render(<LinkPreviewPanel openGraph={openGraph({ siteName: null })} />);

    expect(screen.queryByText('Example')).toBeNull();
  });

  it('shows the site name when the page declares one', () => {
    render(<LinkPreviewPanel openGraph={openGraph({})} />);

    expect(screen.getByText('Example')).toBeInTheDocument();
  });

  it('omits the canonical url row when the page declares no og:url', () => {
    render(<LinkPreviewPanel openGraph={openGraph({ url: null })} />);

    expect(screen.queryByText('https://example.com/')).toBeNull();
  });

  it('shows the canonical url when the page declares one', () => {
    render(<LinkPreviewPanel openGraph={openGraph({})} />);

    expect(screen.getByText('https://example.com/')).toBeInTheDocument();
  });
});
