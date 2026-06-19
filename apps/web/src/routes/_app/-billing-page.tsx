import * as React from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { BillingContent } from '@/components/billing/billing-content';

export function BillingPage(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Billing" right={<ThemeToggle />} />
      <BillingContent />
    </div>
  );
}
