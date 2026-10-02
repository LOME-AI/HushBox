import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { TEST_IDS } from '@hushbox/shared';
import settingsNavSection from './settings-nav.section';

async function renderSection(): Promise<void> {
  const rootRoute = createRootRoute({
    component: (): React.JSX.Element => <>{settingsNavSection.render()}</>,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(<RouterProvider router={router} />);
  await screen.findAllByTestId(TEST_IDS.settingsSectionNav);
}

describe('the Settings nav kit section', () => {
  it('is titled Settings nav under the settings catalog part', () => {
    expect(settingsNavSection.title).toBe('Settings nav');
    expect(settingsNavSection.part).toBe(5);
  });

  it('shows the row as the settings page draws it, with a section current', async () => {
    await renderSection();
    const [settingsRow] = screen.getAllByTestId(TEST_IDS.settingsSectionNav);
    expect(within(settingsRow!).getByRole('link', { name: 'Security' })).toHaveAttribute(
      'aria-current',
      'location'
    );
  });

  it('shows the row as the accessibility page draws it', async () => {
    await renderSection();
    const [, accessibilityRow] = screen.getAllByTestId(TEST_IDS.settingsSectionNav);
    expect(within(accessibilityRow!).getByRole('link', { name: 'Accessibility' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('pins each row in a page body band', async () => {
    await renderSection();
    for (const row of screen.getAllByTestId(TEST_IDS.settingsSectionNav)) {
      expect(row.closest('[data-page-pinned]')).not.toBeNull();
    }
  });
});
