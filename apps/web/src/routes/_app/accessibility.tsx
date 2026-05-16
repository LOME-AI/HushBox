import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AccessibilityPanel } from '@hushbox/ui/accessibility';
import { PageHeader } from '@/components/shared/page-header';
import { PageBody } from '@/components/shared/page-body';
import { ThemeToggle } from '@/components/shared/theme-toggle';

function AccessibilityRoute(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Accessibility" right={<ThemeToggle />} />
      <PageBody testId="accessibility-content">
        <AccessibilityPanel />
      </PageBody>
    </div>
  );
}

export const Route = createFileRoute('/_app/accessibility')({
  component: AccessibilityRoute,
});
