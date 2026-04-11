import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '@/lib/auth';
import { PageHeader } from '@/components/shared/page-header';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { UsageContent } from '@/components/usage/usage-content';
import { balanceQueryOptions } from '@/hooks/billing';

export const Route = createFileRoute('/_app/usage')({
  beforeLoad: async () => {
    await requireAuth();
  },
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(balanceQueryOptions());
  },
  component: UsagePage,
});

export function UsagePage(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Usage" right={<ThemeToggle />} />
      <UsageContent />
    </div>
  );
}
