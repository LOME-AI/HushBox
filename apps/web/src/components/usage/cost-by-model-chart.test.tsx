import * as React from 'react';
import { render, renderHook, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-time';
import { CostByModelChart } from './cost-by-model-chart';
import { UsageModelSet, useUsageModelLabels } from './use-usage-model-labels';
import type { CostByModelResponse, Model } from '@hushbox/shared';
import type { UseModelsStub } from '@/test-utils/models-hook-stub';

const { catalogRef } = vi.hoisted(() => {
  const catalog: { current: Model[] | undefined } = { current: undefined };
  return { catalogRef: catalog };
});

vi.mock('@/hooks/models/models', () => ({
  useModels: (): UseModelsStub => ({
    data:
      catalogRef.current === undefined
        ? undefined
        : { models: catalogRef.current, premiumIds: new Set<string>() },
  }),
}));

function catalogModel(id: string, name: string): Model {
  return {
    id,
    name,
    provider: 'Fictional',
    description: 'Text generation model.',
    modality: 'text',
    supportedParameters: [],
    contextLength: 128_000,
    created: OLD_RELEASE_SECONDS,
    maxOutputTokens: 4096,
    pricing: { inputPerToken: '10000', outputPerToken: '30000' },
  };
}

type Row = CostByModelResponse['data'][number];

function makeData(
  rows: Pick<Row, 'model' | 'provider' | 'totalCost' | 'messageCount'>[]
): CostByModelResponse {
  return {
    data: rows.map((r) => ({
      totalInputTokens: 100,
      totalOutputTokens: 200,
      ...r,
    })),
  };
}

const LARGE = 'fictional/large-4.1';
const SMALL = 'fictional/small-2.5';
const UNLISTED = 'fictional/unlisted';

// Money crosses the wire as canonical nano-USD integer strings
// (`serializeNanoUSD`), never as dollars: 1500000000 nano is $1.50. The server
// sends the rows largest cost first.
const SAMPLE_DATA = makeData([
  { model: LARGE, provider: 'openai', totalCost: '2000000000', messageCount: 5 },
  { model: SMALL, provider: 'anthropic', totalCost: '1500000000', messageCount: 10 },
]);

// Two rows that share a model id, told apart only by their provider.
const TWO_PROVIDERS_ONE_MODEL = makeData([
  { model: LARGE, provider: 'openai', totalCost: '1500000000', messageCount: 10 },
  { model: LARGE, provider: 'azure', totalCost: '500000000', messageCount: 4 },
]);

const PAGE_MODELS = [LARGE, SMALL, UNLISTED];

function pageWrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <UsageModelSet value={PAGE_MODELS}>{children}</UsageModelSet>;
}

function renderChart(
  props: Partial<React.ComponentProps<typeof CostByModelChart>> = {}
): ReturnType<typeof render> {
  return render(<CostByModelChart data={SAMPLE_DATA} isLoading={false} {...props} />, {
    wrapper: pageWrapper,
  });
}

function rows(): HTMLElement[] {
  return within(screen.getByTestId(TEST_IDS.costByModelChart)).getAllByRole('listitem');
}

function rowNames(): (string | null)[] {
  return rows().map((row) => row.querySelector('[data-slot="bar-name"]')?.textContent ?? null);
}

function fillWidths(): string[] {
  return rows().map(
    (row) => row.querySelector<HTMLElement>('[data-slot="bar-fill"]')?.style.width ?? ''
  );
}

describe('CostByModelChart', () => {
  beforeEach(() => {
    catalogRef.current = [
      catalogModel(LARGE, 'Large Model 4.1'),
      catalogModel(SMALL, 'Small Model 2.5'),
    ];
  });

  describe('loading state', () => {
    it('renders skeleton when loading', () => {
      renderChart({ data: undefined, isLoading: true });
      expect(screen.getByTestId(TEST_IDS.skeletonBlock)).toBeInTheDocument();
    });

    it('does not render empty message when loading', () => {
      renderChart({ data: undefined, isLoading: true });
      expect(screen.queryByText('No usage data for this period')).not.toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('renders empty message when data is undefined', () => {
      renderChart({ data: undefined });
      expect(screen.getByText('No usage data for this period')).toBeInTheDocument();
    });

    it('renders empty message when data array is empty', () => {
      renderChart({ data: makeData([]) });
      expect(screen.getByText('No usage data for this period')).toBeInTheDocument();
    });

    it('does not render skeleton when not loading', () => {
      renderChart({ data: undefined });
      expect(screen.queryByTestId(TEST_IDS.skeletonBlock)).not.toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('replaces the empty message with a retryable error', () => {
      renderChart({ data: undefined, isError: true, onRetry: vi.fn() });

      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this chart");
      expect(screen.queryByText('No usage data for this period')).not.toBeInTheDocument();
    });
  });

  describe('the bar list', () => {
    it('keeps the block test id', () => {
      renderChart();
      expect(screen.getByTestId(TEST_IDS.costByModelChart)).toBeInTheDocument();
    });

    it('names its list role outright, since WebKit drops it from a list drawn without markers', () => {
      renderChart();
      expect(screen.getByTestId(TEST_IDS.costByModelChart).querySelector('ul')).toHaveAttribute(
        'role',
        'list'
      );
    });

    it('heads the block with its title', () => {
      renderChart();
      expect(screen.getByRole('heading', { level: 2, name: 'Cost by Model' })).toBeInTheDocument();
    });

    it('draws one row per model the server returns', () => {
      renderChart();
      expect(rows()).toHaveLength(2);
    });

    it('keeps the rows in the order the server sends them', () => {
      renderChart({
        data: makeData([
          { model: SMALL, provider: 'anthropic', totalCost: '1500000000', messageCount: 1 },
          { model: LARGE, provider: 'openai', totalCost: '2000000000', messageCount: 1 },
        ]),
      });
      expect(rowNames()).toEqual(['Small Model 2.5', 'Large Model 4.1']);
    });

    it('names each model by its catalog display name', () => {
      renderChart();
      expect(rowNames()).toEqual(['Large Model 4.1', 'Small Model 2.5']);
    });

    it('names a model the catalog does not list by its id', () => {
      renderChart({
        data: makeData([
          { model: UNLISTED, provider: 'openai', totalCost: '1000000000', messageCount: 1 },
        ]),
      });
      expect(rowNames()).toEqual([UNLISTED]);
    });

    it('follows each name with its provider when one model is billed through two providers', () => {
      renderChart({ data: TWO_PROVIDERS_ONE_MODEL });
      expect(rowNames()).toEqual(['Large Model 4.1 (openai)', 'Large Model 4.1 (azure)']);
    });

    it('leaves a model billed through one provider unsuffixed beside a duplicated one', () => {
      renderChart({
        data: makeData([
          { model: LARGE, provider: 'openai', totalCost: '3000000000', messageCount: 1 },
          { model: SMALL, provider: 'anthropic', totalCost: '2000000000', messageCount: 1 },
          { model: LARGE, provider: 'azure', totalCost: '1000000000', messageCount: 1 },
        ]),
      });
      expect(rowNames()).toEqual([
        'Large Model 4.1 (openai)',
        'Small Model 2.5',
        'Large Model 4.1 (azure)',
      ]);
    });

    it('wraps a long name onto more lines rather than clipping it', () => {
      renderChart();
      const name = rows()[0]?.querySelector('[data-slot="bar-name"] > :last-child');
      expect(name).toHaveClass('wrap-anywhere');
      expect(name).not.toHaveClass('truncate');
    });

    it("marks each row with its model's page swatch", () => {
      renderChart();
      const labels = renderHook(() => useUsageModelLabels(), { wrapper: pageWrapper }).result
        .current;
      const [large, small] = rows();
      expect(large?.querySelector('[data-slot="swatch"]')).toHaveClass(
        `bg-model-${String(labels.swatch(LARGE))}`
      );
      expect(small?.querySelector('[data-slot="swatch"]')).toHaveClass(
        `bg-model-${String(labels.swatch(SMALL))}`
      );
    });

    it("fills each row's track in its model's page swatch", () => {
      renderChart();
      const labels = renderHook(() => useUsageModelLabels(), { wrapper: pageWrapper }).result
        .current;
      const [large] = rows();
      const fill = large?.querySelector<HTMLElement>('[data-slot="bar-fill"]');
      expect(fill).toHaveClass('bg-(--bar-swatch)');
      expect(fill?.style.getPropertyValue('--bar-swatch')).toBe(
        `var(--model-${String(labels.swatch(LARGE))})`
      );
    });

    it('fills the largest cost track to the full width', () => {
      renderChart();
      expect(fillWidths()[0]).toBe('100%');
    });

    it('fills every other track in proportion to the largest cost', () => {
      renderChart();
      expect(fillWidths()[1]).toBe('75%');
    });

    it('rounds a proportion to a tenth of a percent', () => {
      renderChart({
        data: makeData([
          { model: LARGE, provider: 'openai', totalCost: '3000000000', messageCount: 1 },
          { model: SMALL, provider: 'anthropic', totalCost: '1000000000', messageCount: 1 },
        ]),
      });
      expect(fillWidths()).toEqual(['100%', '33.3%']);
    });

    it('draws empty tracks when every cost is zero', () => {
      renderChart({
        data: makeData([{ model: LARGE, provider: 'openai', totalCost: '0', messageCount: 1 }]),
      });
      expect(fillWidths()).toEqual(['0%']);
    });

    it('draws an empty track for a zero cost beside a larger one', () => {
      renderChart({
        data: makeData([
          { model: LARGE, provider: 'openai', totalCost: '1000000000', messageCount: 1 },
          { model: SMALL, provider: 'anthropic', totalCost: '0', messageCount: 1 },
        ]),
      });
      expect(fillWidths()).toEqual(['100%', '0%']);
    });

    it('hides the track from assistive technology', () => {
      renderChart();
      const [large] = rows();
      expect(large?.querySelector('[data-slot="bar-track"]')).toHaveAttribute(
        'aria-hidden',
        'true'
      );
    });

    it('prints each amount in dollars to four places', () => {
      renderChart();
      const amounts = rows().map(
        (row) => row.querySelector('[data-slot="bar-amount"]')?.textContent
      );
      expect(amounts).toEqual(['$2.0000', '$1.5000']);
    });

    it('sets each amount in mono', () => {
      renderChart();
      const [large] = rows();
      expect(large?.querySelector('[data-slot="bar-amount"]')).toHaveClass('font-mono');
    });

    it('reads each row as its name and its amount', () => {
      renderChart();
      expect(rows()[0]).toHaveTextContent('Large Model 4.1$2.0000');
    });

    it('draws no chart surface', () => {
      const { container } = renderChart();
      expect(container.querySelector('.recharts-surface')).toBeNull();
      expect(container.querySelector('[data-chart]')).toBeNull();
      expect(screen.queryByRole('img')).toBeNull();
    });
  });
});
