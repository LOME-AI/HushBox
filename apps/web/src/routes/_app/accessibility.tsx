import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { TEST_IDS } from '@hushbox/shared';
import { AccessibilityPanel } from '@hushbox/ui/accessibility/panel';
import { PageHeader } from '@/components/shared/page-header';
import { PageBody } from '@/components/shared/page-body';
import { AccountNav } from '@/components/settings/account-nav';
import { AccessibilityPreview } from '@/components/accessibility/accessibility-preview';

function AccessibilityRoute(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Accessibility" />
      <PageBody
        testId={TEST_IDS.accessibilityContent}
        pinned={
          <>
            <AccountNav current="accessibility" />
            <AccessibilityPreview />
          </>
        }
      >
        <AccessibilityPanel host="app" />
      </PageBody>
    </div>
  );
}

export const Route = createFileRoute('/_app/accessibility')({
  component: AccessibilityRoute,
});
