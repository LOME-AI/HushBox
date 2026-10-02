import * as React from 'react';
import { CostBreakdown } from '@hushbox/ui';
import { Button, ButtonRow, ButtonStack } from '@hushbox/ui/button';
import { ChevronLeft, ChevronRight, CircleCheck, Icon } from '@hushbox/ui/icons';
import {
  AsyncRegion,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  type SkeletonShape,
} from '@hushbox/ui/surface';
import { TEST_IDS, nanoUSD, parseNanoUSD, serializeNanoUSD } from '@hushbox/shared';
import { useStableBalance } from '@/hooks/billing/use-stable-balance';
import { useTransactions } from '@/hooks/billing/billing';
import { formatBalance } from '@/lib/billing/format';
import { PaymentModal } from '@/components/billing/payment-modal';
import { PageBody } from '@/components/shared/page-body';
import { ManageOnlineButton } from '@/components/billing/manage-online-button';
import { isPaymentDisabled } from '@/capacitor/platform';
import type { BalanceTransactionResponse, NanoUSD } from '@hushbox/shared';
import type { CompletedCharge } from '@/components/billing/payment-form';

const TRANSACTIONS_PER_PAGE = 5;

const SIMPLE_TRANSACTION_LABELS: Record<string, string> = {
  clawback: 'Balance adjustment',
  promo: 'Promotional credit',
};

const BALANCE_PLACEHOLDER: readonly SkeletonShape[] = [{ kind: 'block', height: 'sm' }];

const TRANSACTIONS_PLACEHOLDER: readonly SkeletonShape[] = Array.from(
  { length: TRANSACTIONS_PER_PAGE },
  (): SkeletonShape => ({ kind: 'block', height: 'sm' })
);

function getTransactionDisplay(tx: BalanceTransactionResponse): string {
  if (tx.type === 'charge') {
    const totalChars = (tx.inputCharacters ?? 0) + (tx.outputCharacters ?? 0);
    return `AI response: ${tx.model ?? 'unknown'} (${String(totalChars)} chars)`;
  }
  if (tx.type === 'deposit' || tx.type === 'refund') {
    const label = tx.type === 'deposit' ? 'Deposit' : 'Refund';
    return `${label} of ${formatBalance(tx.amount)}`;
  }
  return SIMPLE_TRANSACTION_LABELS[tx.type] ?? tx.type;
}

function TransactionRows({
  deposits,
  page,
}: {
  readonly deposits: readonly BalanceTransactionResponse[];
  readonly page: number;
}): React.JSX.Element {
  if (deposits.length === 0 && page === 0) {
    return (
      <div className="flex min-h-80 items-center justify-center">
        <p className="text-muted-foreground">No purchases yet</p>
      </div>
    );
  }
  return (
    <ul className="divide-border flex flex-col divide-y">
      {deposits.map((tx) => (
        <li
          key={tx.id}
          data-testid={TEST_IDS.transactionRow}
          className="flex min-h-16 items-center justify-between gap-4 py-2"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="font-medium">{getTransactionDisplay(tx)}</p>
            <p className="text-muted-foreground text-sm">
              {new Date(tx.createdAt).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
            </p>
          </div>
          <p className="text-success-text font-medium whitespace-nowrap tabular-nums">
            +{formatBalance(tx.amount)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function Pager({
  page,
  hasNextPage,
  onPageChange,
}: {
  readonly page: number;
  readonly hasNextPage: boolean;
  readonly onPageChange: (page: number) => void;
}): React.JSX.Element {
  return (
    // The row stretches the label's line box to the row's height and sets the text at its
    // top, so the line is made as tall as the small buttons, touch floor included.
    <div className="text-muted-foreground text-sm leading-8 pointer-coarse:leading-11">
      <ButtonRow>
        <Button
          variant="outline"
          size="sm"
          className="text-foreground"
          disabled={page === 0}
          onClick={() => {
            onPageChange(page - 1);
          }}
        >
          <Icon icon={ChevronLeft} />
          Previous
        </Button>
        {/* A bare text node: the row's member and count rules select elements only, so the
            label sits between the buttons while they keep the two-button width rule. */}
        {`Page ${String(page + 1)}`}
        <Button
          variant="outline"
          size="sm"
          className="text-foreground"
          disabled={!hasNextPage}
          onClick={() => {
            onPageChange(page + 1);
          }}
        >
          Next
          <Icon icon={ChevronRight} />
        </Button>
      </ButtonRow>
    </div>
  );
}

function BalanceCard({
  displayBalance,
  isStable,
  added,
  actions,
}: {
  readonly displayBalance: string;
  readonly isStable: boolean;
  readonly added: NanoUSD | null;
  readonly actions: React.ReactNode;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle level={2}>Current Balance</CardTitle>
        <CardDescription>Your available credits for AI model usage</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <AsyncRegion
          status={isStable ? 'ready' : 'pending'}
          label="Current balance"
          placeholder={BALANCE_PLACEHOLDER}
        >
          <p
            data-testid={TEST_IDS.balanceDisplay}
            className="text-foreground font-sans text-4xl font-bold tabular-nums"
          >
            {formatBalance(displayBalance)}
          </p>
          {added !== null && (
            <p
              data-testid={TEST_IDS.balanceAdded}
              role="status"
              className="text-success-text mt-1.5 inline-flex items-center gap-1.5 text-sm font-medium"
            >
              <Icon icon={CircleCheck} className="text-success" />
              {`+${formatBalance(serializeNanoUSD(added))} added to your balance`}
            </p>
          )}
        </AsyncRegion>
        {actions}
      </CardContent>
    </Card>
  );
}

function PurchaseHistoryCard(): React.JSX.Element {
  const [page, setPage] = React.useState(0);
  const { data, isLoading } = useTransactions({
    limit: TRANSACTIONS_PER_PAGE,
    offset: page * TRANSACTIONS_PER_PAGE,
    type: 'deposit',
  });
  const deposits = data?.transactions ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle level={2}>Purchase History</CardTitle>
        <CardDescription>Your credit purchases</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div data-testid={TEST_IDS.transactionListContainer} className="min-h-80">
          <AsyncRegion
            status={isLoading ? 'pending' : 'ready'}
            label="Purchase history"
            placeholder={TRANSACTIONS_PLACEHOLDER}
          >
            <TransactionRows deposits={deposits} page={page} />
          </AsyncRegion>
        </div>
        {(deposits.length > 0 || page > 0) && (
          <Pager page={page} hasNextPage={Boolean(data?.nextCursor)} onPageChange={setPage} />
        )}
      </CardContent>
    </Card>
  );
}

function AddCreditsAction({
  paymentDisabled,
  onAddCredits,
}: {
  readonly paymentDisabled: boolean;
  readonly onAddCredits: () => void;
}): React.JSX.Element {
  return (
    <ButtonStack>
      {paymentDisabled ? (
        <ManageOnlineButton />
      ) : (
        <Button block size="lg" onClick={onAddCredits}>
          Add Credits
        </Button>
      )}
    </ButtonStack>
  );
}

interface BillingContentProps {
  surface: 'app' | 'portal';
  /**
   * The portal's actions, drawn in place of Add Credits once a purchase completes in this
   * visit. `openPayment` opens this component's own payment modal.
   */
  purchasedActions?: (actions: { openPayment: () => void }) => React.ReactNode;
}

export function BillingContent({
  surface,
  purchasedActions,
}: Readonly<BillingContentProps>): React.JSX.Element {
  const paymentDisabled = isPaymentDisabled();
  const onPortal = surface === 'portal';
  const [showPaymentModal, setShowPaymentModal] = React.useState(false);
  const [addedThisVisit, setAddedThisVisit] = React.useState<NanoUSD | null>(null);
  const {
    displayBalance,
    isStable: isBalanceStable,
    refetch: refetchBalance,
  } = useStableBalance(onPortal ? { enabled: true } : undefined);

  const handlePaymentSuccess = (charge: CompletedCharge): void => {
    void refetchBalance();
    const charged = parseNanoUSD(charge.amountNanoUsd);
    setAddedThisVisit((sum) => nanoUSD(BigInt(sum ?? 0n) + BigInt(charged)));
  };

  const openPayment = (): void => {
    setShowPaymentModal(true);
  };

  const added = onPortal ? addedThisVisit : null;
  const actions =
    added !== null && purchasedActions !== undefined ? (
      purchasedActions({ openPayment })
    ) : (
      <AddCreditsAction paymentDisabled={paymentDisabled} onAddCredits={openPayment} />
    );

  return (
    <>
      <PageBody testId={TEST_IDS.billingContent} className="space-y-6">
        <BalanceCard
          displayBalance={displayBalance}
          isStable={isBalanceStable}
          added={added}
          actions={actions}
        />

        <PurchaseHistoryCard />

        <Card>
          <CardContent className="flex flex-col gap-6">
            <CostBreakdown depositAmount={100} headingLevel={2} />
            <p className="text-muted-foreground text-xs italic">
              Actual costs vary based on your model selection and usage patterns.
            </p>
          </CardContent>
        </Card>
      </PageBody>

      {!paymentDisabled && (
        <PaymentModal
          open={showPaymentModal}
          onOpenChange={setShowPaymentModal}
          onSuccess={handlePaymentSuccess}
        />
      )}
    </>
  );
}
