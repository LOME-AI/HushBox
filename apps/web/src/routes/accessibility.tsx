import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AccessibilityPage } from '@hushbox/ui/accessibility';

function AccessibilityRoute(): React.JSX.Element {
  return <AccessibilityPage />;
}

export const Route = createFileRoute('/accessibility')({
  component: AccessibilityRoute,
});
