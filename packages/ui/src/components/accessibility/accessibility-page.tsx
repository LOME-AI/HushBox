import * as React from 'react';
import { SettingsLayout } from '../settings-layout';
import { AccessibilityPanel } from './accessibility-panel';

const NAV_ITEMS = [{ value: 'accessibility', label: 'Accessibility' }] as const;

/**
 * Authenticated `/accessibility` page. Wraps the shared {@link AccessibilityPanel}
 * in a {@link SettingsLayout} so the page renders the standard nav landmark plus
 * the "Accessibility" heading. The nav has a single item today; `onChange` is a
 * deliberate no-op until additional sections (e.g. `/settings/general`) are added.
 */
export function AccessibilityPage(): React.JSX.Element {
  return (
    <SettingsLayout
      navItems={[...NAV_ITEMS]}
      activeValue="accessibility"
      onChange={() => {
        /* single-item nav, no-op */
      }}
      pageTitle="Accessibility"
    >
      <AccessibilityPanel />
    </SettingsLayout>
  );
}
