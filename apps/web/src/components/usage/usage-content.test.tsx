import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { assignModelSwatches, modelSwatch } from '@/lib/utils/model-color';
import { UsageContent } from './usage-content';
import type { UseModelsStub } from '@/test-utils/models-hook-stub';

const { usageHooks, mockUseDecryptedConversations, swatchProbe } = vi.hoisted(() => {
  // The model ids the cost-by-model stub reports swatches for.
  const probe: { ids: readonly string[] } = { ids: [] };
  return {
    swatchProbe: probe,
    usageHooks: {
      useUsageSummary: vi.fn(),
      useSpendingOverTime: vi.fn(),
      useCostByModel: vi.fn(),
      useSpendingByConversation: vi.fn(),
      useUsageModels: vi.fn(),
    },
    mockUseDecryptedConversations: vi.fn(),
  };
});

vi.mock('@/hooks/billing/usage', () => usageHooks);

vi.mock('@/hooks/models/models', () => ({
  useModels: (): UseModelsStub => ({ data: undefined }),
}));

vi.mock('@/hooks/chat/chat', () => ({
  useDecryptedConversations: () => mockUseDecryptedConversations(),
}));

// Child components are stubbed so this test isolates UsageContent's own logic
// (date-range derivation, param memos, and range/model state wiring). The
// filters stub exposes buttons that drive the parent's setRange/setModel.
vi.mock('./usage-filters', () => ({
  UsageFilters: ({
    onRangeChange,
    onModelChange,
    availableModels,
  }: {
    onRangeChange: (r: string) => void;
    onModelChange: (m?: string) => void;
    availableModels: string[];
  }) => (
    <div data-testid="filters-stub">
      <button
        type="button"
        onClick={() => {
          onRangeChange('all');
        }}
        data-testid="set-all"
      />
      <button
        type="button"
        onClick={() => {
          onRangeChange('7d');
        }}
        data-testid="set-7d"
      />
      <button
        type="button"
        onClick={() => {
          onModelChange('GPT-4');
        }}
        data-testid="set-model"
      />
      <button
        type="button"
        onClick={() => {
          onModelChange();
        }}
        data-testid="clear-model"
      />
      <span data-testid="model-count">{availableModels.length}</span>
    </div>
  ),
}));

// The stubs surface the two error-path props so this test can pin the wiring
// between each query result and the section it feeds.
interface ChartStub {
  ({ isError, onRetry }: { isError?: boolean; onRetry?: () => void }): React.JSX.Element;
  displayName: string;
}

function chartStub(testId: string): ChartStub {
  const Stub = ({
    isError,
    onRetry,
  }: {
    isError?: boolean;
    onRetry?: () => void;
  }): React.JSX.Element => (
    <div data-testid={testId} data-error={String(isError === true)}>
      <button type="button" onClick={onRetry} data-testid={`${testId}-retry`} />
    </div>
  );
  Stub.displayName = `Stub-${testId}`;
  return Stub;
}

vi.mock('./usage-summary', () => ({ UsageSummary: chartStub('summary-stub') }));
vi.mock('./spending-over-time-chart', () => ({
  SpendingOverTimeChart: chartStub('spend-time-stub'),
}));
// Cost by Model stands in for every block that colours models: it reads the page's labels
// and reports the swatch of each probed model.
vi.mock('./cost-by-model-chart', async () => {
  const { useUsageModelLabels } = await import('./use-usage-model-labels');
  const Stub = chartStub('cost-model-stub');
  function CostByModelChart(
    props: Readonly<{ isError?: boolean; onRetry?: () => void }>
  ): React.JSX.Element {
    const { swatch } = useUsageModelLabels();
    return (
      <>
        <Stub {...props} />
        {swatchProbe.ids.map((id) => (
          <span key={id} data-testid="swatch-probe" data-swatch={swatch(id)} />
        ))}
      </>
    );
  }
  return { CostByModelChart };
});
vi.mock('./top-conversations', () => ({
  TopConversations: chartStub('spend-conv-stub'),
}));

beforeEach(() => {
  vi.clearAllMocks();
  for (const function_ of Object.values(usageHooks)) {
    function_.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  }
  usageHooks.useUsageModels.mockReturnValue({
    data: { models: ['GPT-4', 'Claude'] },
    isLoading: false,
    isError: false,
  });
  mockUseDecryptedConversations.mockReturnValue({ data: undefined });
  swatchProbe.ids = [];
});

/** Twelve model ids, and a pair of them that one swatch assignment over all twelve colours alike. */
function lifetimeWithCollision(): { lifetime: string[]; pair: [string, string] } {
  const lifetime = Array.from({ length: 12 }, (_, index) => `fictional/model-${String(index)}`);
  const assigned = assignModelSwatches(lifetime.toSorted((a, b) => a.localeCompare(b)));
  for (const first of lifetime) {
    const second = lifetime.find((id) => id !== first && assigned.get(id) === assigned.get(first));
    if (second !== undefined) return { lifetime, pair: [first, second] };
  }
  throw new Error('twelve models over eight swatches always share one');
}

/** Two model ids that share a swatch on their own. */
function ownCollision(): [string, string] {
  const byOwnSwatch = new Map<number, string>();
  for (let index = 0; ; index++) {
    const id = `fictional/own-${String(index)}`;
    const earlier = byOwnSwatch.get(modelSwatch(id));
    if (earlier !== undefined) return [earlier, id];
    byOwnSwatch.set(modelSwatch(id), id);
  }
}

function probedSwatches(): (string | null)[] {
  return screen.getAllByTestId('swatch-probe').map((probe) => probe.dataset['swatch'] ?? null);
}

describe('UsageContent', () => {
  it('renders the page body with every child section', () => {
    render(<UsageContent />);
    expect(screen.getByTestId(TEST_IDS.usageContent)).toBeInTheDocument();
    expect(screen.getByTestId('summary-stub')).toBeInTheDocument();
    expect(screen.getByTestId('spend-time-stub')).toBeInTheDocument();
    expect(screen.getByTestId('cost-model-stub')).toBeInTheDocument();
    expect(screen.getByTestId('spend-conv-stub')).toBeInTheDocument();
  });

  it('draws no token usage chart', () => {
    render(<UsageContent />);
    expect(screen.queryByTestId(TEST_IDS.tokenUsageChart)).not.toBeInTheDocument();
  });

  it('draws no balance history chart', () => {
    render(<UsageContent />);
    expect(screen.queryByTestId(TEST_IDS.balanceHistoryChart)).not.toBeInTheDocument();
  });

  it('orders the blocks filters, summary, spending, cost by model, top conversations', () => {
    render(<UsageContent />);
    const order = [
      'filters-stub',
      'summary-stub',
      'spend-time-stub',
      'cost-model-stub',
      'spend-conv-stub',
    ].map((id) => screen.getByTestId(id));
    for (const [index, block] of order.slice(1).entries()) {
      const previous = order[index];
      expect(previous?.compareDocumentPosition(block)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
  });

  it('pairs cost by model with top conversations in one row', () => {
    render(<UsageContent />);
    const pair = screen.getByTestId('cost-model-stub').parentElement;
    expect(screen.getByTestId('spend-conv-stub').parentElement).toBe(pair);
  });

  it('sets the pair side by side only where its container fits two columns', () => {
    render(<UsageContent />);
    const pair = screen.getByTestId('cost-model-stub').parentElement;
    expect(pair).toHaveClass('grid', '@usage-pair:grid-cols-2');
    expect(pair?.parentElement).toHaveClass('@container');
  });

  it('passes available models through to the filters', () => {
    render(<UsageContent />);
    expect(screen.getByTestId('model-count')).toHaveTextContent('2');
  });

  it('defaults available models to an empty list when none are loaded', () => {
    usageHooks.useUsageModels.mockReturnValue({ data: undefined, isLoading: false });
    render(<UsageContent />);
    expect(screen.getByTestId('model-count')).toHaveTextContent('0');
  });

  it('queries with a bounded date range for a preset range', () => {
    render(<UsageContent />);
    const [params] = usageHooks.useUsageSummary.mock.calls.at(-1) as [
      { startDate: string; endDate: string },
    ];
    // Default 30d preset yields a real computed start earlier than the end.
    expect(params.startDate < params.endDate).toBe(true);
    expect(params.startDate).not.toBe('2020-01-01');
  });

  it('uses the sentinel start date for the "all" range', () => {
    render(<UsageContent />);
    fireEvent.click(screen.getByTestId('set-all'));
    const [params] = usageHooks.useUsageSummary.mock.calls.at(-1) as [{ startDate: string }];
    expect(params.startDate).toBe('2020-01-01');
  });

  it('recomputes the range for a non-"all" preset', () => {
    render(<UsageContent />);
    fireEvent.click(screen.getByTestId('set-7d'));
    const [params] = usageHooks.useUsageSummary.mock.calls.at(-1) as [{ startDate: string }];
    expect(params.startDate).not.toBe('2020-01-01');
  });

  it('includes the model in time-series params when one is selected', () => {
    render(<UsageContent />);
    fireEvent.click(screen.getByTestId('set-model'));
    const [params] = usageHooks.useSpendingOverTime.mock.calls.at(-1) as [{ model?: string }];
    expect(params.model).toBe('GPT-4');
  });

  it('omits the model from time-series params when cleared', () => {
    render(<UsageContent />);
    fireEvent.click(screen.getByTestId('set-model'));
    fireEvent.click(screen.getByTestId('clear-model'));
    const [params] = usageHooks.useSpendingOverTime.mock.calls.at(-1) as [{ model?: string }];
    expect(params.model).toBeUndefined();
  });

  const failableSections = [
    ['useUsageSummary', 'summary-stub'],
    ['useSpendingOverTime', 'spend-time-stub'],
    ['useCostByModel', 'cost-model-stub'],
    ['useSpendingByConversation', 'spend-conv-stub'],
  ] as const;

  it.each(failableSections)('marks the section fed by %s as failed', (hookName, testId) => {
    usageHooks[hookName].mockReturnValue({ data: undefined, isLoading: false, isError: true });

    render(<UsageContent />);

    expect(screen.getByTestId(testId)).toHaveAttribute('data-error', 'true');
  });

  it.each(failableSections)('retries %s from its own section', (hookName, testId) => {
    const refetch = vi.fn();
    usageHooks[hookName].mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });

    render(<UsageContent />);
    fireEvent.click(screen.getByTestId(`${testId}-retry`));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('leaves the other sections unfailed when one query fails', () => {
    usageHooks.useUsageSummary.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });

    render(<UsageContent />);

    expect(screen.getByTestId('spend-time-stub')).toHaveAttribute('data-error', 'false');
    expect(screen.getByTestId('spend-conv-stub')).toHaveAttribute('data-error', 'false');
  });

  describe('model swatches', () => {
    it('repeats no swatch among the models a range shows when the account has used more than eight', () => {
      const { lifetime, pair } = lifetimeWithCollision();
      usageHooks.useUsageModels.mockReturnValue({ data: { models: lifetime }, isLoading: false });
      usageHooks.useCostByModel.mockReturnValue({
        data: { data: pair.map((model) => ({ model, provider: 'fictional', totalCost: '1' })) },
        isLoading: false,
        isError: false,
      });
      swatchProbe.ids = pair;

      render(<UsageContent />);

      expect(new Set(probedSwatches()).size).toBe(2);
    });

    it('keeps the lifetime model list for the filter', () => {
      const { lifetime, pair } = lifetimeWithCollision();
      usageHooks.useUsageModels.mockReturnValue({ data: { models: lifetime }, isLoading: false });
      usageHooks.useCostByModel.mockReturnValue({
        data: { data: pair.map((model) => ({ model, provider: 'fictional', totalCost: '1' })) },
        isLoading: false,
        isError: false,
      });

      render(<UsageContent />);

      expect(screen.getByTestId('model-count')).toHaveTextContent('12');
    });

    it('colours the models of every block from one set', () => {
      const pair = ownCollision();
      usageHooks.useSpendingOverTime.mockReturnValue({
        data: { data: [{ period: 'p', model: pair[0], totalCost: '1', count: 1 }] },
        isLoading: false,
        isError: false,
      });
      usageHooks.useSpendingByConversation.mockReturnValue({
        data: {
          data: [{ conversationId: 'c', totalSpent: '1', messageCount: 1, modelIds: [pair[1]] }],
        },
        isLoading: false,
        isError: false,
      });
      swatchProbe.ids = pair;

      render(<UsageContent />);

      const expected = assignModelSwatches(pair.toSorted((a, b) => a.localeCompare(b)));
      expect(probedSwatches()).toEqual(pair.map((id) => String(expected.get(id))));
    });
  });

  it('forwards conversation titles when conversations are decrypted', () => {
    mockUseDecryptedConversations.mockReturnValue({
      data: [{ id: 'c1', title: 'First' }],
    });
    // Re-render should not throw and still shows the spending-by-conversation section.
    render(<UsageContent />);
    expect(screen.getByTestId('spend-conv-stub')).toBeInTheDocument();
  });
});
