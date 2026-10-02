import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { renderWithProviders } from '@/test-utils/render';
import { opCatalog } from '@/test-utils/op-catalog';
import { AdminNav } from './admin-nav.js';

/**
 * The nav renders the screens the CALLER's role is drawn, and the role rides
 * the ops catalog — so every render here answers that read. `render` is kept
 * for the cases that assert chrome rather than screens.
 */
function stubCatalog(role: 'operator' | 'growth-viewer'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ ...opCatalog('wallet.credit'), role }))
  );
}

beforeEach(() => {
  // VITE_WEB_URL is registry-defined in every mode; stub it so renders resolve
  // the web-app link like a real build. Individual tests override as needed.
  vi.stubEnv('VITE_WEB_URL', 'http://localhost:5173');
});

beforeEach(() => {
  stubCatalog('operator');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    Link: ({
      children,
      to,
      ...props
    }: {
      children: React.ReactNode;
      to: string;
    }): React.JSX.Element => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  };
});

describe('AdminNav', () => {
  it('is chrome: a nav tagged data-chrome', () => {
    renderWithProviders(<AdminNav />);
    const nav = screen.getByTestId(TEST_IDS.adminNav);
    expect(nav.tagName).toBe('NAV');
    expect(nav).toHaveAttribute('data-chrome', '');
  });

  it('fails fast when VITE_WEB_URL is missing (required var, parsed not cast)', () => {
    vi.stubEnv('VITE_WEB_URL', '');
    expect(() => renderWithProviders(<AdminNav />)).toThrow();
  });

  it('renders the shared brand logo linking to the web app chat', () => {
    vi.stubEnv('VITE_WEB_URL', 'http://localhost:5173');
    renderWithProviders(<AdminNav />);
    const nav = screen.getByTestId(TEST_IDS.adminNav);
    const link = within(nav).getByRole('link', { name: 'HushBox - Go to chat' });
    expect(link).toHaveAttribute('href', 'http://localhost:5173/chat');
    expect(within(link).getByTestId(TEST_IDS.logo)).toBeInTheDocument();
  });

  it('gives the sidebar header the shared app-header-height token', () => {
    renderWithProviders(<AdminNav />);
    const nav = screen.getByTestId(TEST_IDS.adminNav);
    const link = within(nav).getByRole('link', { name: 'HushBox - Go to chat' });
    const header = link.closest('div');
    expect(header?.className).toContain('min-h-[var(--app-header-height)]');
    expect(header?.className).not.toContain('h-11');
  });

  it('collapses to an icon rail below the breakpoint while keeping nav reachable', async () => {
    renderWithProviders(<AdminNav />);
    const nav = screen.getByTestId(TEST_IDS.adminNav);
    await within(nav).findByRole('link', { name: 'Dashboard' });
    // Rail behavior is class-driven: narrow width by default, full width from
    // the min-[900px] breakpoint up; labels stay in the accessibility tree
    // (sr-only) and every link carries a tooltip title.
    expect(nav.className).toContain('w-14');
    expect(nav.className).toContain('min-[900px]:w-52');
    const link = within(nav).getByRole('link', { name: 'Dashboard' });
    expect(link).toHaveAttribute('title', 'Dashboard');
  });

  it('gives nav links the token focus ring instead of the UA default', async () => {
    renderWithProviders(<AdminNav />);
    const nav = screen.getByTestId(TEST_IDS.adminNav);
    const link = await within(nav).findByRole('link', { name: 'Dashboard' });
    expect(link.className).toContain('focus-visible:ring-ring/50');
    expect(link.className).toContain('focus-visible:ring-[3px]');
  });

  it("hides every nav link's browser outline only while it has keyboard focus", async () => {
    renderWithProviders(<AdminNav />);
    const nav = screen.getByTestId(TEST_IDS.adminNav);
    await within(nav).findByRole('link', { name: 'Dashboard' });
    const suppressions = within(nav)
      .getAllByRole('link')
      .map((link) =>
        [...link.classList].filter((token) => /(^|:)outline-(none|hidden)$/.test(token))
      );
    expect(suppressions.length).toBeGreaterThan(1);
    expect(new Set(suppressions.map((tokens) => tokens.join(' ')))).toEqual(
      new Set(['focus-visible:outline-hidden'])
    );
  });

  it.each([
    ['Dashboard', '/'],
    ['Customer 360', '/customer-360'],
    ['Jobs', '/jobs'],
    ['Feedback', '/feedback'],
    ['Newsletter', '/newsletter'],
    ['Audit trail', '/audit'],
    ['Models', '/models'],
    ['SQL panel', '/sql'],
    ['Ops catalog', '/ops'],
  ])('links %s to %s', async (label, href) => {
    renderWithProviders(<AdminNav />);
    const nav = screen.getByTestId(TEST_IDS.adminNav);
    const link = await within(nav).findByRole('link', { name: label });
    expect(link).toHaveAttribute('href', href);
  });
});

describe('AdminNav role visibility', () => {
  it('draws the operator every screen', async () => {
    renderWithProviders(<AdminNav />);
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'SQL panel' })).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: 'Customer 360' })).toBeInTheDocument();
  });

  it('draws a read-only role none of the operator screens', async () => {
    stubCatalog('growth-viewer');
    renderWithProviders(<AdminNav />);
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'SQL panel' })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: 'Customer 360' })).not.toBeInTheDocument();
  });

  it('draws nothing before the role is known, so no screen flashes for a viewer', () => {
    renderWithProviders(<AdminNav />);
    expect(screen.queryByRole('link', { name: 'SQL panel' })).not.toBeInTheDocument();
  });
});
