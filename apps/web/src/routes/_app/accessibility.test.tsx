import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type AnyRouter,
} from '@tanstack/react-router';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { PageShell } from '@/components/shared/page-shell';
import { renderWithProviders } from '@/test-utils/render';
import { Route } from './accessibility';

// The panel's internals are out of scope for this route, and its subpath pulls
// the speech engine, so the whole subpath is replaced. The provider stack that
// renderWithProviders mounts comes from `@hushbox/ui/accessibility`, a different
// module, and stays real.
vi.mock('@hushbox/ui/accessibility/panel', () => ({
  AccessibilityPanel: ({ host }: Readonly<{ host: string }>): React.JSX.Element => (
    <section data-testid="accessibility-panel-mock" data-host={host}>
      Panel
    </section>
  ),
}));

const REPLY =
  'Sourdough at 75% hydration means 750 g of water for every kilogram of flour. Start at 70% if the dough feels hard to shape, and read the hydration guide for the full method.';

function page(): React.ComponentType {
  const Page = Route.options.component;
  if (Page === undefined) throw new Error('the route has no component');
  return Page;
}

/** Mounts the page at /accessibility under a memory router whose other routes are the nav's targets. */
async function renderPage(options: Readonly<{ inShell?: boolean }> = {}): Promise<AnyRouter> {
  const Page = page();
  const rootRoute = createRootRoute({ component: Outlet });
  const accessibility = createRoute({
    getParentRoute: () => rootRoute,
    path: ROUTES.ACCESSIBILITY,
    component: () =>
      options.inShell === true ? (
        <PageShell>
          <Page />
        </PageShell>
      ) : (
        <Page />
      ),
  });
  const targets = [ROUTES.SETTINGS, ROUTES.BILLING, ROUTES.USAGE].map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => <p>Elsewhere</p> })
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([accessibility, ...targets]),
    history: createMemoryHistory({ initialEntries: [ROUTES.ACCESSIBILITY] }),
  });
  renderWithProviders(<RouterProvider router={router} />);
  await screen.findByTestId(TEST_IDS.accessibilityContent);
  return router;
}

function pinnedBand(): HTMLElement {
  const band = screen
    .getByTestId(TEST_IDS.accessibilityContent)
    .querySelector('[data-page-pinned]');
  if (!(band instanceof HTMLElement)) throw new Error('the page has no pinned band');
  return band;
}

function preview(): HTMLElement {
  return screen.getByTestId(TEST_IDS.accessibilityPreview);
}

describe('/accessibility route', () => {
  it('renders the AccessibilityPanel below the header', async () => {
    await renderPage();
    expect(screen.getByTestId('accessibility-panel-mock')).toBeInTheDocument();
  });

  it('lays the panel out as the app does', async () => {
    await renderPage();
    expect(screen.getByTestId('accessibility-panel-mock')).toHaveAttribute('data-host', 'app');
  });

  it('keeps the panel out of the pinned band', async () => {
    await renderPage();
    expect(pinnedBand()).not.toContainElement(screen.getByTestId('accessibility-panel-mock'));
  });
});

describe('/accessibility pinned band', () => {
  it('pins the settings link row', async () => {
    await renderPage();
    expect(pinnedBand()).toContainElement(screen.getByTestId(TEST_IDS.settingsSectionNav));
  });

  it('marks Accessibility as the current page in the link row', async () => {
    await renderPage();
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(nav).getByRole('link', { name: 'Accessibility' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('marks no other link in the row current', async () => {
    await renderPage();
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    const current = within(nav)
      .getAllByRole('link')
      .filter((link) => link.hasAttribute('aria-current'));
    expect(current.map((link) => link.textContent)).toEqual(['Accessibility']);
  });

  it('pins the preview after the link row', async () => {
    await renderPage();
    const nav = screen.getByTestId(TEST_IDS.settingsSectionNav);
    expect(pinnedBand()).toContainElement(preview());
    expect(nav.compareDocumentPosition(preview()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('/accessibility preview content', () => {
  it('labels itself Preview', async () => {
    await renderPage();
    expect(screen.getByRole('region', { name: 'Preview' })).toBe(preview());
  });

  it('names Claude Sonnet 4.5 by Anthropic', async () => {
    await renderPage();
    const nameplate = within(preview()).getByTestId(TEST_IDS.modelNametag).parentElement
      ?.parentElement;
    expect(nameplate).toHaveTextContent('Claude Sonnet 4.5Anthropic');
  });

  it('shows the sample reply word for word', async () => {
    await renderPage();
    const paragraphs = [...preview().querySelectorAll('p')].map((p) => p.textContent);
    expect(paragraphs).toEqual([REPLY]);
  });

  it('links the hydration guide', async () => {
    await renderPage();
    expect(within(preview()).getByRole('link', { name: 'hydration guide' })).toBeInTheDocument();
  });

  it('shows Loaf weight holding 900 g', async () => {
    await renderPage();
    expect(within(preview()).getByLabelText('Loaf weight')).toHaveValue('900 g');
  });

  it('offers Cancel then Save recipe', async () => {
    await renderPage();
    const names = within(preview())
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(names).toEqual(['Cancel', 'Save recipe']);
  });
});

describe('/accessibility preview controls', () => {
  it('stays on the page when the link is followed', async () => {
    const user = userEvent.setup();
    const router = await renderPage();
    const before = router.state.location.href;

    await user.click(within(preview()).getByRole('link', { name: 'hydration guide' }));

    expect(router.state.location.href).toBe(before);
  });

  it.each(['Cancel', 'Save recipe'])('stays on the page when %s is pressed', async (name) => {
    const user = userEvent.setup();
    const router = await renderPage();
    const before = router.state.location.href;

    await user.click(within(preview()).getByRole('button', { name }));

    expect(router.state.location.href).toBe(before);
  });

  it.each(['Cancel', 'Save recipe'])(
    'leaves the preview as drawn when %s is pressed',
    async (name) => {
      const user = userEvent.setup();
      await renderPage();
      const before = preview().outerHTML;

      await user.click(within(preview()).getByRole('button', { name }));

      expect(preview().outerHTML).toBe(before);
    }
  );
});

describe('/accessibility page header', () => {
  it('renders its title as the one h1, in the page shell header', async () => {
    await renderPage({ inShell: true });

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Accessibility');
    expect(document.querySelector('header')).toContainElement(heading);
  });

  it('draws no theme toggle of its own', async () => {
    await renderPage();

    expect(screen.queryByTestId(TEST_IDS.themeToggle)).not.toBeInTheDocument();
  });
});
