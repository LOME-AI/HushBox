import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, Button } from '@lome-chat/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { requireAuth } from '@/lib/auth';
import { useStableBalance } from '@/hooks/use-stable-balance';
import { useTransactions } from '@/hooks/billing';
import { formatBalance } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { PaymentModal } from '@/components/billing/payment-modal';
import { FeeBreakdown } from '@/components/billing/fee-breakdown';
import { CostPieChart } from '@/components/billing/cost-pie-chart';

const TRANSACTIONS_PER_PAGE = 5;

export const Route = createFileRoute('/_app/billing')({
  beforeLoad: async () => {
    await requireAuth();
  },
  component: BillingPage,
});

export function BillingPage(): React.JSX.Element {
  const [showPaymentModal, setShowPaymentModal] = React.useState(false);
  const [page, setPage] = React.useState(0);
  const { displayBalance, isStable: isBalanceStable, refetch: refetchBalance } = useStableBalance();
  const { data: transactionsData, isLoading: transactionsLoading } = useTransactions({
    limit: TRANSACTIONS_PER_PAGE,
    offset: page * TRANSACTIONS_PER_PAGE,
    type: 'deposit', // Only show deposits (purchases)
  });

  const handlePaymentSuccess = (): void => {
    void refetchBalance();
  };

  // Filter to only deposits and calculate pagination
  const deposits = transactionsData?.transactions ?? [];
  const hasNextPage = Boolean(transactionsData?.nextCursor);
  const hasPrevPage = page > 0;

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Billing" right={<ThemeToggle />} />

      <div className="container mx-auto max-w-4xl flex-1 space-y-6 overflow-y-auto p-4">
        {/* Balance Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-[#ec4755]">Current Balance</CardTitle>
            <CardDescription>Your available credits for AI model usage</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                {!isBalanceStable ? (
                  <div className="bg-muted h-10 w-48 animate-pulse rounded" />
                ) : (
                  <p data-testid="balance-display" className="text-4xl font-bold">
                    {formatBalance(displayBalance)}
                  </p>
                )}
              </div>
              <Button
                onClick={() => {
                  setShowPaymentModal(true);
                }}
                size="lg"
              >
                Add Credits
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Transactions Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-[#ec4755]">Purchase History</CardTitle>
            <CardDescription>Your credit purchases</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Fixed height container for transaction list */}
            <div data-testid="transaction-list-container" className="h-[320px]">
              {transactionsLoading ? (
                <div className="flex h-full flex-col">
                  {Array.from({ length: TRANSACTIONS_PER_PAGE }).map((_, i) => (
                    <div
                      key={i}
                      data-testid="transaction-skeleton-row"
                      className="flex h-16 items-center justify-between"
                    >
                      <div className="space-y-2">
                        <div
                          data-testid="skeleton-block"
                          className="bg-muted h-5 w-40 animate-pulse rounded"
                        />
                        <div
                          data-testid="skeleton-block"
                          className="bg-muted h-4 w-32 animate-pulse rounded"
                        />
                      </div>
                      <div className="space-y-2 text-right">
                        <div
                          data-testid="skeleton-block"
                          className="bg-muted ml-auto h-5 w-16 animate-pulse rounded"
                        />
                        <div
                          data-testid="skeleton-block"
                          className="bg-muted ml-auto h-4 w-28 animate-pulse rounded"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : deposits.length === 0 && page === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <p className="text-muted-foreground">No purchases yet</p>
                </div>
              ) : (
                <div className="flex h-full flex-col">
                  {deposits.map((tx) => (
                    <div
                      key={tx.id}
                      className="flex h-16 items-center justify-between border-b last:border-0"
                    >
                      <div>
                        <p className="font-medium">{tx.description}</p>
                        <p className="text-muted-foreground text-sm">
                          {new Date(tx.createdAt).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-medium text-green-600">
                          +${parseFloat(tx.amount).toFixed(2)}
                        </p>
                        <p className="text-muted-foreground text-sm">
                          Balance: {formatBalance(tx.balanceAfter)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* Pagination - always visible when we have transactions */}
            {(deposits.length > 0 || page > 0) && (
              <div className="mt-4 flex items-center justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-28"
                  onClick={() => {
                    setPage((p) => Math.max(0, p - 1));
                  }}
                  disabled={!hasPrevPage}
                >
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Previous
                </Button>
                <span className="text-muted-foreground text-sm">Page {page + 1}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-28"
                  onClick={() => {
                    setPage((p) => p + 1);
                  }}
                  disabled={!hasNextPage}
                >
                  Next
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Fee Breakdown Card */}
        <Card>
          <CardContent className="pt-3">
            <div className="grid gap-8 md:grid-cols-2">
              <FeeBreakdown depositAmount={100} />
              <CostPieChart depositAmount={100} />
            </div>
            <p className="text-muted-foreground mt-4 text-xs italic">
              Actual costs vary based on your model selection and usage patterns.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Payment Modal */}
      <PaymentModal
        open={showPaymentModal}
        onOpenChange={setShowPaymentModal}
        onSuccess={handlePaymentSuccess}
      />
    </div>
  );
}
