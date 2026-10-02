import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UrlBar } from './url-bar';
import type { SitemapResponse, SitemapTarget } from '../app/api';

function target(overrides: Partial<SitemapTarget>): SitemapTarget {
  return {
    label: 'marketing',
    origin: 'http://localhost:4321',
    urls: ['http://localhost:4321/', 'http://localhost:4321/pricing'],
    ...overrides,
  };
}

function sitemap(targets: SitemapTarget[]): SitemapResponse {
  return { targets };
}

describe('UrlBar', () => {
  it('reports each keystroke in the URL field to its owner', () => {
    const onChange = vi.fn();
    render(
      <UrlBar value="" onChange={onChange} onAnalyze={vi.fn()} sitemap={null} sitemapError={null} />
    );

    fireEvent.change(screen.getByLabelText('Page URL'), {
      target: { value: 'https://example.com/page' },
    });

    expect(onChange).toHaveBeenCalledWith('https://example.com/page');
  });

  it('analyzes the trimmed URL when the form is submitted', () => {
    const onAnalyze = vi.fn();
    render(
      <UrlBar
        value="  https://example.com/page  "
        onChange={vi.fn()}
        onAnalyze={onAnalyze}
        sitemap={null}
        sitemapError={null}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));

    expect(onAnalyze).toHaveBeenCalledWith('https://example.com/page');
  });

  it('refuses to analyze a blank URL', () => {
    const onAnalyze = vi.fn();
    render(
      <UrlBar
        value="   "
        onChange={vi.fn()}
        onAnalyze={onAnalyze}
        sitemap={null}
        sitemapError={null}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));

    expect(onAnalyze).not.toHaveBeenCalled();
  });

  it('groups the picker options by target, naming each origin', () => {
    render(
      <UrlBar
        value=""
        onChange={vi.fn()}
        onAnalyze={vi.fn()}
        sitemap={sitemap([
          target({}),
          target({ label: 'web', origin: 'http://localhost:5173', urls: [], unreachable: true }),
        ])}
        sitemapError={null}
      />
    );

    expect(screen.getByRole('group', { name: 'marketing (http://localhost:4321)' })).toBeVisible();
    expect(
      screen.getByRole('group', { name: 'web (unreachable: http://localhost:5173)' })
    ).toBeVisible();
    expect(screen.getByRole('option', { name: 'http://localhost:4321/pricing' })).toBeVisible();
  });

  it('offers no pages to pick when the sitemap has not loaded', () => {
    render(
      <UrlBar value="" onChange={vi.fn()} onAnalyze={vi.fn()} sitemap={null} sitemapError={null} />
    );

    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: 'Select a page…' })).toBeVisible();
  });

  it('sends a page picked from the sitemap straight into analysis', () => {
    const onChange = vi.fn();
    const onAnalyze = vi.fn();
    render(
      <UrlBar
        value=""
        onChange={onChange}
        onAnalyze={onAnalyze}
        sitemap={sitemap([target({})])}
        sitemapError={null}
      />
    );

    fireEvent.change(screen.getByLabelText('Pick a local page'), {
      target: { value: 'http://localhost:4321/pricing' },
    });

    expect(onChange).toHaveBeenCalledWith('http://localhost:4321/pricing');
    expect(onAnalyze).toHaveBeenCalledWith('http://localhost:4321/pricing');
  });

  it('ignores a re-selection of the picker placeholder', () => {
    const onAnalyze = vi.fn();
    render(
      <UrlBar
        value=""
        onChange={vi.fn()}
        onAnalyze={onAnalyze}
        sitemap={sitemap([target({})])}
        sitemapError={null}
      />
    );

    fireEvent.change(screen.getByLabelText('Pick a local page'), { target: { value: '' } });

    expect(onAnalyze).not.toHaveBeenCalled();
  });

  it('surfaces the reason the sitemap could not be loaded', () => {
    render(
      <UrlBar
        value=""
        onChange={vi.fn()}
        onAnalyze={vi.fn()}
        sitemap={null}
        sitemapError="connection refused"
      />
    );

    expect(screen.getByText(/Sitemap unavailable: connection refused/)).toBeVisible();
  });

  it('hides the sitemap error line when the sitemap loaded', () => {
    render(
      <UrlBar
        value=""
        onChange={vi.fn()}
        onAnalyze={vi.fn()}
        sitemap={sitemap([target({})])}
        sitemapError={null}
      />
    );

    expect(screen.queryByText(/Sitemap unavailable/)).toBeNull();
  });

  it('offers a path field for a reachable web origin that publishes no sitemap', () => {
    const onAnalyze = vi.fn();
    render(
      <UrlBar
        value=""
        onChange={vi.fn()}
        onAnalyze={onAnalyze}
        sitemap={sitemap([target({ label: 'web', origin: 'http://localhost:5173', urls: [] })])}
        sitemapError={null}
      />
    );

    fireEvent.change(screen.getByLabelText('Path on the web origin'), {
      target: { value: '/chat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    expect(onAnalyze).toHaveBeenCalledWith('http://localhost:5173/chat');
  });

  it('offers no path field when the web origin is unreachable', () => {
    render(
      <UrlBar
        value=""
        onChange={vi.fn()}
        onAnalyze={vi.fn()}
        sitemap={sitemap([
          target({ label: 'web', origin: 'http://localhost:5173', urls: [], unreachable: true }),
        ])}
        sitemapError={null}
      />
    );

    expect(screen.queryByLabelText('Path on the web origin')).toBeNull();
  });

  it('offers no path field when the web origin already publishes a sitemap', () => {
    render(
      <UrlBar
        value=""
        onChange={vi.fn()}
        onAnalyze={vi.fn()}
        sitemap={sitemap([
          target({
            label: 'web',
            origin: 'http://localhost:5173',
            urls: ['http://localhost:5173/'],
          }),
        ])}
        sitemapError={null}
      />
    );

    expect(screen.queryByLabelText('Path on the web origin')).toBeNull();
  });

  it('offers no path field when the sitemap names no web origin', () => {
    render(
      <UrlBar
        value=""
        onChange={vi.fn()}
        onAnalyze={vi.fn()}
        sitemap={sitemap([target({})])}
        sitemapError={null}
      />
    );

    expect(screen.queryByLabelText('Path on the web origin')).toBeNull();
  });
});
