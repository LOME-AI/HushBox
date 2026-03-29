import * as React from 'react';
import { Card, CardContent } from '@hushbox/ui';
import { DollarSign, MessageSquare, Zap, TrendingDown } from 'lucide-react';
import type { UsageSummaryResponse } from '@hushbox/shared';
import { formatTokenCount } from './chart-utilities';

interface UsageKpiCardsProps {
  data: UsageSummaryResponse | undefined;
  isLoading: boolean;
}

function formatCost(value: string): string {
  const amount = Number.parseFloat(value);
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

function KpiSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="bg-muted h-4 w-20 animate-pulse rounded" data-testid="skeleton-block" />
      <div className="bg-muted h-7 w-24 animate-pulse rounded" data-testid="skeleton-block" />
    </div>
  );
}

interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  isLoading: boolean;
  testId: string;
}

function KpiCard({
  icon,
  label,
  value,
  isLoading,
  testId,
}: Readonly<KpiCardProps>): React.JSX.Element {
  return (
    <Card data-testid={testId}>
      <CardContent className="px-4 pt-3 pb-3">
        {isLoading ? (
          <KpiSkeleton />
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="text-foreground-muted">{icon}</div>
            <div>
              <p className="text-foreground-muted text-xs">{label}</p>
              <p className="text-foreground text-xl font-semibold tabular-nums">{value}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function UsageKpiCards({
  data,
  isLoading,
}: Readonly<UsageKpiCardsProps>): React.JSX.Element {
  const totalTokens = data
    ? data.totalInputTokens + data.totalOutputTokens + data.totalCachedTokens
    : 0;
  const avgCost =
    data && data.messageCount > 0
      ? (Number.parseFloat(data.totalSpent) / data.messageCount).toFixed(4)
      : '0';

  return (
    <div className="grid grid-cols-2 gap-3 px-0 sm:grid-cols-4" data-testid="usage-kpi-cards">
      <KpiCard
        icon={<DollarSign className="h-4 w-4" />}
        label="Total Spent"
        value={formatCost(data?.totalSpent ?? '0')}
        isLoading={isLoading}
        testId="kpi-total-spent"
      />
      <KpiCard
        icon={<MessageSquare className="h-4 w-4" />}
        label="Messages"
        value={String(data?.messageCount ?? 0)}
        isLoading={isLoading}
        testId="kpi-messages"
      />
      <KpiCard
        icon={<Zap className="h-4 w-4" />}
        label="Tokens Used"
        value={formatTokenCount(totalTokens)}
        isLoading={isLoading}
        testId="kpi-tokens"
      />
      <KpiCard
        icon={<TrendingDown className="h-4 w-4" />}
        label="Avg Cost/Msg"
        value={formatCost(avgCost)}
        isLoading={isLoading}
        testId="kpi-avg-cost"
      />
    </div>
  );
}
