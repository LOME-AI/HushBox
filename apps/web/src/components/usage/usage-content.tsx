import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import {
  useUsageSummary,
  useSpendingOverTime,
  useCostByModel,
  useSpendingByConversation,
  useUsageModels,
} from '@/hooks/billing/usage';
import { useDecryptedConversations } from '@/hooks/chat/chat';
import { PageBody } from '@/components/shared/page-body';
import { UsageFilters, type DateRangePreset } from './usage-filters';
import { UsageSummary } from './usage-summary';
import { UsageModelSet } from './use-usage-model-labels';
import { SpendingOverTimeChart } from './spending-over-time-chart';
import { CostByModelChart } from './cost-by-model-chart';
import { TopConversations } from './top-conversations';

const PRESET_DAYS: Record<Exclude<DateRangePreset, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

function getDateRange(preset: DateRangePreset): { startDate: string; endDate: string } {
  const end = new Date();
  /* v8 ignore next -- toISOString() always contains 'T', so split()[0] is never undefined; the ?? '' satisfies noUncheckedIndexedAccess */
  const endDate = end.toISOString().split('T')[0] ?? '';

  if (preset === 'all') {
    return { startDate: '2020-01-01', endDate };
  }

  const days = PRESET_DAYS[preset];
  const start = new Date();
  start.setDate(start.getDate() - days);
  /* v8 ignore next -- toISOString() always contains 'T', so split()[0] is never undefined; the ?? '' satisfies noUncheckedIndexedAccess */
  return { startDate: start.toISOString().split('T')[0] ?? '', endDate };
}

/**
 * Each failed section retries only its own query: they run independently, so
 * a partial outage leaves the sections that did load untouched.
 */
function retry(query: { refetch: () => Promise<unknown> }): () => void {
  return () => {
    void query.refetch();
  };
}

export function UsageContent(): React.JSX.Element {
  const [range, setRange] = React.useState<DateRangePreset>('30d');
  const [model, setModel] = React.useState<string | undefined>();

  const dateRange = React.useMemo(() => getDateRange(range), [range]);
  const timeSeriesParams = React.useMemo(
    () => ({ ...dateRange, ...(model !== undefined && { model }) }),
    [dateRange, model]
  );

  const { data: modelsData } = useUsageModels();
  const { data: conversations } = useDecryptedConversations();
  const summary = useUsageSummary(dateRange);
  const spendingOverTime = useSpendingOverTime(timeSeriesParams);
  const costByModel = useCostByModel(dateRange);
  const spendingByConversation = useSpendingByConversation(dateRange);

  // Every model a block shows for the range, so the page assigns their colours once.
  const pageModels = React.useMemo(
    () => [
      ...new Set([
        ...(spendingOverTime.data?.data ?? []).map((point) => point.model),
        ...(costByModel.data?.data ?? []).map((row) => row.model),
        ...(spendingByConversation.data?.data ?? []).flatMap((row) => row.modelIds),
      ]),
    ],
    [spendingOverTime.data, costByModel.data, spendingByConversation.data]
  );

  return (
    <PageBody testId={TEST_IDS.usageContent} className="flex flex-col gap-8">
      <UsageFilters
        range={range}
        onRangeChange={setRange}
        model={model}
        onModelChange={setModel}
        availableModels={modelsData?.models ?? []}
      />

      <UsageModelSet value={pageModels}>
        <UsageSummary
          data={summary.data}
          isLoading={summary.isLoading}
          isError={summary.isError}
          onRetry={retry(summary)}
        />

        <SpendingOverTimeChart
          data={spendingOverTime.data}
          isLoading={spendingOverTime.isLoading}
          isError={spendingOverTime.isError}
          onRetry={retry(spendingOverTime)}
        />

        <div className="@container">
          <div className="@usage-pair:grid-cols-2 grid items-start gap-x-10 gap-y-8">
            <CostByModelChart
              data={costByModel.data}
              isLoading={costByModel.isLoading}
              isError={costByModel.isError}
              onRetry={retry(costByModel)}
            />
            <TopConversations
              data={spendingByConversation.data}
              isLoading={spendingByConversation.isLoading}
              isError={spendingByConversation.isError}
              onRetry={retry(spendingByConversation)}
              {...(conversations && {
                conversationTitles: conversations.map((c) => ({ id: c.id, title: c.title })),
              })}
            />
          </div>
        </div>
      </UsageModelSet>
    </PageBody>
  );
}
