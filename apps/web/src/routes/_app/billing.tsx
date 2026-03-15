import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '@/lib/auth';
import { PageHeader } from '@/components/shared/page-header';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { BillingContent } from '@/components/billing/billing-content';

export const Route = createFileRoute('/_app/billing')({
  beforeLoad: async () => {
    await requireAuth();
  },
  component: BillingPage,
});

export function BillingPage(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Billing" right={<ThemeToggle />} />
      <BillingContent />
    </div>
  );
}
