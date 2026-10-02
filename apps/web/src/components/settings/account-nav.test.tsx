import * as React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { AccountNav } from '@/components/settings/account-nav';
import { PageBody } from '@/components/shared/page-body';
import type { SettingsSectionId } from '@/hooks/ui/use-section-in-view';

const LINK_NAMES = [
  'Account',
  'Security',
  'Preferences',
  'Notifications',
  'Legal',
  'Danger zone',
  'Accessibility',
  'Billing',
  'Usage',
];

async function renderAt(path: string, ui: React.ReactNode): Promise<void> {
  const rootRoute = createRootRoute({ component: Outlet });
  const page = (): React.JSX.Element => <>{ui}</>;
  const routes = [ROUTES.SETTINGS, ROUTES.ACCESSIBILITY, ROUTES.BILLING, ROUTES.USAGE].map(
    (routePath) =>
      createRoute({ getParentRoute: () => rootRoute, path: routePath, component: page })
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  await screen.findByTestId(TEST_IDS.settingsSectionNav);
}

function nav(): HTMLElement {
  return screen.getByTestId(TEST_IDS.settingsSectionNav);
}

function link(name: string): HTMLElement {
  return within(nav()).getByRole('link', { name });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AccountNav', () => {
  it('is a navigation landmark named Settings', async () => {
    await renderAt(ROUTES.SETTINGS, <AccountNav current="account" />);
    expect(nav()).toBe(screen.getByRole('navigation', { name: 'Settings' }));
  });

  it('links the six sections, then Accessibility, Billing and Usage, in that order', async () => {
    await renderAt(ROUTES.SETTINGS, <AccountNav current="account" />);
    const names = within(nav())
      .getAllByRole('link')
      .map((element) => element.textContent);
    expect(names).toEqual(LINK_NAMES);
  });

  it('separates the sections from the other pages with a hidden divider', async () => {
    await renderAt(ROUTES.SETTINGS, <AccountNav current="account" />);
    const divider = link('Danger zone').nextElementSibling;
    expect(divider).toHaveAttribute('aria-hidden', 'true');
    expect(divider?.nextElementSibling).toBe(link('Accessibility'));
  });

  it('turns the divider into a line break below 768', async () => {
    await renderAt(ROUTES.SETTINGS, <AccountNav current="account" />);
    const divider = link('Danger zone').nextElementSibling;
    expect(divider?.className).toContain('max-md:basis-full');
  });

  it('marks the section in view as the current location on the settings page', async () => {
    await renderAt(ROUTES.SETTINGS, <AccountNav current="security" />);
    expect(link('Security')).toHaveAttribute('aria-current', 'location');
    const others = LINK_NAMES.filter((name) => name !== 'Security');
    for (const name of others) expect(link(name)).not.toHaveAttribute('aria-current');
  });

  it('points each section link at its section on the settings page', async () => {
    await renderAt(ROUTES.SETTINGS, <AccountNav current="account" />);
    expect(link('Account')).toHaveAttribute('href', '#account');
    expect(link('Danger zone')).toHaveAttribute('href', '#danger');
  });

  it('marks Accessibility as the current page on the accessibility page', async () => {
    await renderAt(ROUTES.ACCESSIBILITY, <AccountNav current="accessibility" />);
    expect(link('Accessibility')).toHaveAttribute('aria-current', 'page');
    const others = LINK_NAMES.filter((name) => name !== 'Accessibility');
    for (const name of others) expect(link(name)).not.toHaveAttribute('aria-current');
  });

  it('opens each section on the settings page from the accessibility page', async () => {
    await renderAt(ROUTES.ACCESSIBILITY, <AccountNav current="accessibility" />);
    expect(link('Account')).toHaveAttribute('href', `${ROUTES.SETTINGS}#account`);
    expect(link('Legal')).toHaveAttribute('href', `${ROUTES.SETTINGS}#legal`);
  });

  it('links the other pages by their routes', async () => {
    await renderAt(ROUTES.SETTINGS, <AccountNav current="account" />);
    expect(link('Accessibility')).toHaveAttribute('href', ROUTES.ACCESSIBILITY);
    expect(link('Billing')).toHaveAttribute('href', ROUTES.BILLING);
    expect(link('Usage')).toHaveAttribute('href', ROUTES.USAGE);
  });

  it('draws the current link as the filled pill', async () => {
    await renderAt(ROUTES.SETTINGS, <AccountNav current="legal" />);
    expect(link('Legal').className).toContain('bg-primary');
    expect(link('Legal').className).toContain('text-primary-foreground');
    expect(link('Account').className).not.toContain('bg-primary');
  });

  it('sets every link, current or not, in the UI type size', async () => {
    await renderAt(ROUTES.SETTINGS, <AccountNav current="legal" />);
    for (const name of LINK_NAMES) expect(link(name).className.split(' ')).toContain('text-ui');
  });

  it('carries its own gutter and hairline below 768, where the band has no box', async () => {
    await renderAt(ROUTES.SETTINGS, <AccountNav current="account" />);
    const classes = nav().className.split(' ');
    expect(classes).toEqual(
      expect.arrayContaining(['max-md:px-4', 'max-md:py-2.5', 'max-md:border-b', 'border-border'])
    );
  });

  it('grows each link to the touch target on a coarse pointer', async () => {
    await renderAt(ROUTES.SETTINGS, <AccountNav current="account" />);
    for (const name of LINK_NAMES) expect(link(name).className).toContain('pointer-coarse:h-11');
  });

  it('reaches every link by Tab in the order it shows them', async () => {
    const user = userEvent.setup();
    await renderAt(ROUTES.SETTINGS, <AccountNav current="account" />);
    const reached: (string | null)[] = [];
    while (reached.length < LINK_NAMES.length) {
      await user.tab();
      reached.push(document.activeElement?.textContent ?? null);
    }
    expect(reached).toEqual(LINK_NAMES);
  });

  it('scrolls its section below the band when a section link is chosen', async () => {
    const user = userEvent.setup();
    const sections: readonly SettingsSectionId[] = ['account', 'security'];
    await renderAt(
      ROUTES.SETTINGS,
      <PageBody pinned={<AccountNav current="account" />}>
        {sections.map((id) => (
          <section key={id} id={id}>
            {id}
          </section>
        ))}
      </PageBody>
    );
    const scroller = screen.getByTestId('page-body');
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
    vi.spyOn(document.querySelector('#security')!, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 400, 800, 200)
    );
    const scrollTo = vi.spyOn(scroller, 'scrollTo');
    await user.click(link('Security'));
    expect(scrollTo).toHaveBeenCalledWith({ top: 400 - 16, behavior: 'smooth' });
  });

  it('takes the next Tab inside the section a section link was chosen from the keyboard', async () => {
    const user = userEvent.setup();
    await renderAt(
      ROUTES.SETTINGS,
      <PageBody pinned={<AccountNav current="account" />}>
        <section id="account">
          <button type="button">Account action</button>
        </section>
        <section id="security">
          <button type="button">Security action</button>
        </section>
      </PageBody>
    );
    link('Security').focus();
    await user.keyboard('{Enter}');
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Security action' }));
  });

  it("replaces the browser's own jump to the section", async () => {
    await renderAt(ROUTES.SETTINGS, <AccountNav current="account" />);
    const notPrevented = fireEvent.click(link('Preferences'));
    expect(notPrevented).toBe(false);
  });
});
