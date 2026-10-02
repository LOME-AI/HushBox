import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { UsageSummary } from './usage-summary';
import type { UsageSummaryResponse } from '@hushbox/shared';

function makeSummary(overrides: Partial<UsageSummaryResponse> = {}): UsageSummaryResponse {
  const summary: UsageSummaryResponse = {
    // Money crosses the wire as canonical nano-USD integer strings
    // (`serializeNanoUSD`), never as dollars: 12500000000 nano is $12.50.
    totalSpent: '12500000000',
    messageCount: 20,
    totalInputTokens: 1000,
    totalOutputTokens: 2000,
    totalCachedTokens: 500,
    ...overrides,
  };
  return summary;
}

function total(): HTMLElement {
  return screen.getByTestId(TEST_IDS.usageTotalSpent);
}

/** A fact in the summary line, found by the words after its figure. */
function fact(words: string): HTMLElement {
  return within(screen.getByTestId(TEST_IDS.usageSummary)).getByText(words);
}

describe('UsageSummary', () => {
  describe('loading state', () => {
    it('marks the summary busy while loading', () => {
      render(<UsageSummary data={undefined} isLoading={true} />);
      expect(screen.getByRole('group', { name: 'Summary' })).toHaveAttribute('aria-busy', 'true');
    });

    it('does not render the total while loading', () => {
      render(<UsageSummary data={makeSummary()} isLoading={true} />);
      expect(screen.queryByTestId(TEST_IDS.usageTotalSpent)).not.toBeInTheDocument();
    });

    it('does not render the facts line while loading', () => {
      render(<UsageSummary data={makeSummary()} isLoading={true} />);
      expect(screen.queryByText(/messages$/)).not.toBeInTheDocument();
    });
  });

  describe('with data', () => {
    it('renders the summary container', () => {
      render(<UsageSummary data={makeSummary()} isLoading={false} />);
      expect(screen.getByTestId(TEST_IDS.usageSummary)).toBeInTheDocument();
    });

    it('labels the total "Total Spent"', () => {
      render(<UsageSummary data={makeSummary()} isLoading={false} />);
      expect(
        within(screen.getByTestId(TEST_IDS.usageSummary)).getByText('Total Spent')
      ).toBeInTheDocument();
    });

    it('formats total spent above one cent with two decimals', () => {
      render(<UsageSummary data={makeSummary({ totalSpent: '12500000000' })} isLoading={false} />);
      expect(total()).toHaveTextContent('$12.50');
    });

    it('sets the total in the mono face', () => {
      render(<UsageSummary data={makeSummary()} isLoading={false} />);
      expect(total()).toHaveClass('font-mono');
    });

    it('formats a sub-cent total spent with four decimals', () => {
      render(<UsageSummary data={makeSummary({ totalSpent: '4200000' })} isLoading={false} />);
      expect(total()).toHaveTextContent('$0.0042');
    });

    it('rounds a total of exactly one and a half cents up', () => {
      render(<UsageSummary data={makeSummary({ totalSpent: '15000000' })} isLoading={false} />);
      expect(total()).toHaveTextContent('$0.02');
    });

    it('rounds a sub-cent total on an exact half of its last place up', () => {
      render(<UsageSummary data={makeSummary({ totalSpent: '150000' })} isLoading={false} />);
      expect(total()).toHaveTextContent('$0.0002');
    });

    it('rounds a negative total on an exact half away from zero', () => {
      render(<UsageSummary data={makeSummary({ totalSpent: '-15000000' })} isLoading={false} />);
      expect(total()).toHaveTextContent('-$0.02');
    });

    it('formats a zero total spent as $0.00', () => {
      render(<UsageSummary data={makeSummary({ totalSpent: '0' })} isLoading={false} />);
      expect(total()).toHaveTextContent('$0.00');
    });

    it('renders the message count', () => {
      render(<UsageSummary data={makeSummary({ messageCount: 20 })} isLoading={false} />);
      expect(fact('messages')).toHaveTextContent(/^20 messages$/);
    });

    it('names a single message in the singular', () => {
      render(<UsageSummary data={makeSummary({ messageCount: 1 })} isLoading={false} />);
      expect(fact('message')).toHaveTextContent(/^1 message$/);
    });

    it('sums input, output, and cached tokens', () => {
      render(
        <UsageSummary
          data={makeSummary({
            totalInputTokens: 1000,
            totalOutputTokens: 2000,
            totalCachedTokens: 500,
          })}
          isLoading={false}
        />
      );
      // 3500 formats as 3.5K
      expect(fact('tokens used')).toHaveTextContent(/^3\.5K tokens used$/);
    });

    it('computes average cost per message', () => {
      render(
        <UsageSummary
          data={makeSummary({ totalSpent: '10000000000', messageCount: 20 })}
          isLoading={false}
        />
      );
      // $10 over 20 messages is $0.50 each: above a cent, so two decimals.
      expect(fact('per message')).toHaveTextContent(/^\$0\.50 per message$/);
    });

    it('renders a sub-cent average cost per message with four decimals', () => {
      render(
        <UsageSummary
          data={makeSummary({ totalSpent: '4200000', messageCount: 2 })}
          isLoading={false}
        />
      );
      // $0.0042 over 2 messages is $0.0021 each.
      expect(fact('per message')).toHaveTextContent(/^\$0\.0021 per message$/);
    });

    it('rounds an average of exactly one and a half cents per message up', () => {
      render(
        <UsageSummary
          data={makeSummary({ totalSpent: '30000000', messageCount: 2 })}
          isLoading={false}
        />
      );
      expect(fact('per message')).toHaveTextContent(/^\$0\.02 per message$/);
    });

    it('sets each figure in the facts line in the mono face', () => {
      render(<UsageSummary data={makeSummary()} isLoading={false} />);
      for (const words of ['messages', 'tokens used', 'per message']) {
        expect(within(fact(words)).getByText(/^[$\d]/)).toHaveClass('font-mono');
      }
    });
  });

  describe('failed query', () => {
    it('replaces every figure with a retryable error state', () => {
      render(<UsageSummary data={undefined} isLoading={false} isError={true} onRetry={vi.fn()} />);

      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load your usage totals");
      expect(screen.queryByTestId(TEST_IDS.usageTotalSpent)).not.toBeInTheDocument();
      expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    });

    it('keeps the summary container around the error', () => {
      render(<UsageSummary data={undefined} isLoading={false} isError={true} onRetry={vi.fn()} />);
      expect(
        within(screen.getByTestId(TEST_IDS.usageSummary)).getByRole('alert')
      ).toBeInTheDocument();
    });

    it('refetches the query when retry is pressed', async () => {
      const onRetry = vi.fn();
      const user = userEvent.setup();
      render(<UsageSummary data={undefined} isLoading={false} isError={true} onRetry={onRetry} />);

      await user.click(screen.getByRole('button', { name: 'Retry' }));

      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });

  describe('undefined data (not loading)', () => {
    it('falls back to zeroed figures', () => {
      render(<UsageSummary data={undefined} isLoading={false} />);
      expect(total()).toHaveTextContent('$0.00');
      expect(fact('messages')).toHaveTextContent(/^0 messages$/);
      expect(fact('tokens used')).toHaveTextContent(/^0 tokens used$/);
      expect(fact('per message')).toHaveTextContent(/^\$0\.00 per message$/);
    });

    it('avoids divide-by-zero when message count is zero', () => {
      render(
        <UsageSummary
          data={makeSummary({ totalSpent: '10000000000', messageCount: 0 })}
          isLoading={false}
        />
      );
      expect(fact('per message')).toHaveTextContent(/^\$0\.00 per message$/);
    });
  });
});
