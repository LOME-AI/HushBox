import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '@/lib/auth';
import { balanceQueryOptions } from '@/hooks/billing/billing';
import { BillingPage } from './-billing-page';

export const Route = createFileRoute('/_app/billing')({
  beforeLoad: async () => {
    await requireAuth();
  },
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(balanceQueryOptions());
  },
  component: BillingPage,
});
