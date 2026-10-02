import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { TEST_IDS } from '@hushbox/shared';
import { SkipLink } from '@hushbox/ui';
import { renderRoute } from '@/test-utils/render';
import { Route } from './__root.js';

vi.mock('@/lib/env', () => ({ isDevAuthEnabled: () => true }));

const shellFault = vi.hoisted(() => ({ throws: false }));

// The topbar stands in for any shell fault: it renders outside every route, so
// no route error component can catch it — only the root boundary can. Wraps the
// real component so the shell tests below still exercise the real topbar.
vi.mock('@/components/shell/admin-topbar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/shell/admin-topbar')>();
  return {
    AdminTopbar: (): React.JSX.Element => {
      if (shellFault.throws) {
        throw new Error('topbar exploded');
      }
      return <actual.AdminTopbar />;
    },
  };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Outlet: (): React.JSX.Element => <div>Outlet Content</div>,
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

beforeEach(() => {
  // AdminNav parses VITE_WEB_URL (registry-defined in every mode); stub it so
  // the shell renders like a real build. Mirrors admin-nav.test.tsx.
  vi.stubEnv('VITE_WEB_URL', 'http://localhost:5173');
  shellFault.throws = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('root shell', () => {
  it('renders nav, topbar, and the routed outlet inside a main landmark', () => {
    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.adminShell)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminNav)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminTopbar)).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).toContainElement(screen.getByText('Outlet Content'));
  });

  it('renders a skip-to-content link as the first focusable element', () => {
    renderRoute(Route);

    const shell = screen.getByTestId(TEST_IDS.adminShell);
    const focusables = shell.querySelectorAll('a, button, input, [tabindex]');
    expect(focusables[0]).toBe(screen.getByRole('link', { name: /skip to content/i }));
  });

  it('points the skip link at the main content region', () => {
    renderRoute(Route);

    expect(screen.getByRole('link', { name: /skip to content/i })).toHaveAttribute('href', '#main');
  });

  it('renders the shared skip link', () => {
    renderRoute(Route);

    expect(screen.getByRole('link', { name: /skip to content/i }).outerHTML).toBe(
      renderToStaticMarkup(<SkipLink />)
    );
  });

  it('gives main a focusable target for the skip link', () => {
    renderRoute(Route);

    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(main).toHaveAttribute('tabindex', '-1');
  });

  it('positions the region that takes the shell overflow', () => {
    renderRoute(Route);

    const classes = screen.getByRole('main').className.split(/\s+/);
    // The premise first: without the overflow this says nothing.
    expect(
      classes,
      'the main region no longer takes the shell overflow, so the containing-block assertion below has lost its subject'
    ).toContain('overflow-y-auto');
    // An unpositioned overflow container is not the containing block for the
    // absolutely positioned content inside it, so that content's scrollable
    // overflow lands on the viewport and a fragment jump scrolls the whole
    // shell. The behaviour itself is held in `e2e/admin/growth-screen.spec.ts`,
    // which no unit environment can reach: it needs layout.
    expect(
      classes,
      'the region that takes the shell overflow is unpositioned, so out-of-flow content inside it resolves against the viewport'
    ).toContain('relative');
  });

  it('mounts the A11yProvider (its colorblind SVG defs render with the shell)', () => {
    renderRoute(Route);
    expect(document.querySelector('filter[id^="a11y-cb"], svg filter')).not.toBeNull();
  });
});

describe('root shell fault', () => {
  beforeEach(() => {
    // React logs caught render errors to console.error; silence the expected noise.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    shellFault.throws = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('degrades to a readable fallback carrying the fault message', () => {
    renderRoute(Route);

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByText('topbar exploded')).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.adminShell)).not.toBeInTheDocument();
  });

  it('renders the shell again when the fallback retry clears the error', async () => {
    renderRoute(Route);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    shellFault.throws = false;
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByTestId(TEST_IDS.adminShell)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
