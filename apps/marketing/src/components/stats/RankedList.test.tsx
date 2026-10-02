import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RankedList } from './RankedList';
import type { RankedModel } from './compute-stats';

const MODELS: readonly RankedModel[] = [
  {
    rank: 1,
    modelId: 'b/two',
    displayName: 'Two',
    provider: 'Bravo',
    sharePercent: 50,
    deltaPoints: -0.4,
    avgCostUsd: '0.002',
    color: 'var(--chart-1)',
  },
  {
    rank: 2,
    modelId: 'a/one',
    displayName: 'One',
    provider: 'Alpha',
    sharePercent: 40,
    deltaPoints: null,
    avgCostUsd: '0.01',
    color: 'var(--chart-2)',
  },
];

const OTHERS = { sharePercent: 10, deltaPoints: 1.5 };

describe('RankedList', () => {
  it('renders one row per model plus Others last', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText('Two')).toBeInTheDocument();
    expect(within(items[2]!).getByText('Others')).toBeInTheDocument();
  });

  it('renders rank numbers and share percentages', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    const items = screen.getAllByRole('listitem');
    expect(within(items[0]!).getByText('1')).toBeInTheDocument();
    expect(within(items[0]!).getByText('50.0%')).toBeInTheDocument();
    expect(within(items[2]!).getByText('10.0%')).toBeInTheDocument();
  });

  it('renders a signed delta badge when deltas are shown', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    expect(screen.getByText('-0.4')).toBeInTheDocument();
    expect(screen.getByText('+1.5')).toBeInTheDocument();
  });

  it('omits the delta badge for a null delta even when deltas are shown', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    const items = screen.getAllByRole('listitem');
    expect(within(items[1]!).queryByText(/^[+-]/)).not.toBeInTheDocument();
  });

  it('omits the Others row when its share is zero', () => {
    render(
      <RankedList
        models={MODELS}
        others={{ sharePercent: 0, deltaPoints: null }}
        showDelta={true}
      />
    );
    expect(screen.queryByText('Others')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('keeps the Others row when its share is nonzero', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    expect(screen.getByText('Others')).toBeInTheDocument();
  });

  it('renders positive deltas in default ink for light mode and success only in dark mode', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    const positive = screen.getByText('+1.5');
    expect(positive).toHaveClass('text-foreground', 'dark:text-success');
    expect(positive).not.toHaveClass('text-success');
  });

  it('omits all deltas when the window has none', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={false} />);
    expect(screen.queryByText('-0.4')).not.toBeInTheDocument();
    expect(screen.queryByText('+1.5')).not.toBeInTheDocument();
  });
  it('shows the provider as small muted text after the display name', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    const provider = screen.getByText('Bravo');
    expect(provider.tagName).toBe('SMALL');
    expect(provider).toHaveClass('text-muted-foreground', 'text-xs');
    expect(provider.parentElement).toHaveTextContent(/^TwoBravo$/);
  });

  it('shows the provider only once the list itself reaches the provider width', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    expect(screen.getByRole('list', { name: 'Model share ranking' })).toHaveClass('@container');
    expect(screen.getByText('Bravo')).toHaveClass('hidden', '@mkt-list-provider:inline');
  });

  it('gives the Others row no provider', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    const others = screen.getAllByRole('listitem')[2]!;
    expect(others.querySelector('small')).toBeNull();
  });

  it('renders a delta that rounds to zero in muted ink', () => {
    const flat: RankedModel = { ...MODELS[1]!, deltaPoints: 0.04 };
    render(<RankedList models={[flat]} others={OTHERS} showDelta={true} />);
    const zero = screen.getByText('+0.0');
    expect(zero).toHaveClass('text-muted-foreground');
    expect(zero).not.toHaveClass('dark:text-success');
  });

  it('lays every row on one line, the name giving way, while the list is wide enough', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    for (const row of screen.getAllByRole('listitem')) {
      expect(row).not.toHaveClass('flex-wrap');
    }
    expect(screen.getByText('Two')).toHaveClass('min-w-0', 'flex-1', 'truncate');
  });

  it('wraps every row at once, keyed on the list width, not on any one row', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    for (const row of screen.getAllByRole('listitem')) {
      expect(row).toHaveClass('@max-[11.7em]:flex-wrap');
    }
    const figures = screen.getByText('50.0%').parentElement!;
    expect(figures).toContainElement(screen.getByText('-0.4'));
    expect(figures).toHaveClass(
      'ml-auto',
      'shrink-0',
      '@max-[11.7em]:basis-full',
      '@max-[11.7em]:justify-end'
    );
  });

  it('draws each colour key from its model token without an svg', () => {
    const { container } = render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    expect(container.querySelector('svg')).toBeNull();
    const keys = container.querySelectorAll<HTMLElement>('[data-key]');
    expect(keys).toHaveLength(3);
    expect(keys[0]!.style.getPropertyValue('--key')).toBe('var(--chart-1)');
    expect(keys[0]).toHaveClass('bg-(--key)', 'forced-color-adjust-none', 'size-3');
  });

  it('sizes each delta to its own text, leaving the name every pixel the figures do not use', () => {
    render(<RankedList models={MODELS} others={OTHERS} showDelta={true} />);
    for (const delta of [screen.getByText('-0.4'), screen.getByText('+1.5')]) {
      expect([...delta.classList].filter((token) => /(^|:)(min-)?w-/.test(token))).toEqual([]);
    }
  });
});
