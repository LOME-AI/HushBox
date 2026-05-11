import * as React from 'react';
import { AccessibilityPanel } from './accessibility-panel';

/**
 * `/accessibility` page body. Drop this inside the host app's chrome — it
 * renders the heading + panel without owning the page chrome itself, so the
 * authenticated-app sidebar persists.
 */
export function AccessibilityPage(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <h1 className="mb-4 text-2xl font-semibold">Accessibility</h1>
        <AccessibilityPanel />
      </div>
    </div>
  );
}
