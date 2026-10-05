import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { CostPill } from '@/components/chat/message/cost-pill';

/** Opens the pill's breakdown and returns it. */
async function openBreakdown(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: /^Cost / }));
  return screen.getByRole('dialog', { name: 'This reply' });
}

/** The breakdown's rows as label and value pairs, in reading order. */
function rowsOf(breakdown: HTMLElement): string[][] {
  const labels = within(breakdown).getAllByRole('term');
  const values = within(breakdown).getAllByRole('definition');
  return labels.map((label, index) => [label.textContent, values[index]?.textContent ?? '']);
}

describe('CostPill', () => {
  it('shows a NanoUSD wire cost with sub-cent precision', () => {
    render(<CostPill cost="1360000" />);

    expect(screen.getByTestId(TEST_IDS.messageCost)).toHaveTextContent('$0.00136');
  });

  it('shows a zero cost as $0.00', () => {
    render(<CostPill cost="0" />);

    expect(screen.getByTestId(TEST_IDS.messageCost)).toHaveTextContent('$0.00');
  });

  it('shows a very small cost with full precision', () => {
    render(<CostPill cost="21000" />);

    expect(screen.getByTestId(TEST_IDS.messageCost)).toHaveTextContent('$0.000021');
  });

  it('strips trailing zeros from the figure', () => {
    render(<CostPill cost="15000000" />);

    expect(screen.getByTestId(TEST_IDS.messageCost)).toHaveTextContent('$0.015');
  });

  it('carries nothing but the figure as its text', () => {
    render(<CostPill cost="1360000" />);

    expect(screen.getByTestId(TEST_IDS.messageCost).textContent).toBe('$0.00136');
  });

  it('renders nothing and does not throw for a non-canonical cost string', () => {
    expect(() => render(<CostPill cost="0.01" />)).not.toThrow();

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('names the figure and what pressing it shows', () => {
    render(<CostPill cost="1360000" />);

    expect(
      screen.getByRole('button', { name: 'Cost $0.00136, show breakdown' })
    ).toBeInTheDocument();
  });

  it('is the button the breakdown opens from', () => {
    render(<CostPill cost="1360000" />);

    expect(screen.getByTestId(TEST_IDS.messageCost)).toBe(
      screen.getByRole('button', { name: /^Cost / })
    );
  });

  it('reports the breakdown shut until pressed', () => {
    render(<CostPill cost="1360000" />);

    expect(screen.getByRole('button', { name: /^Cost / })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('opens a breakdown named This reply', async () => {
    render(<CostPill cost="1360000" />);

    expect(await openBreakdown()).toBeInTheDocument();
  });

  it('reports the breakdown open while it shows', async () => {
    render(<CostPill cost="1360000" />);
    await openBreakdown();

    expect(screen.getByRole('button', { name: /^Cost / })).toHaveAttribute('aria-expanded', 'true');
  });

  it('lists input tokens, output tokens and the cost when the reply carries its tokens', async () => {
    render(<CostPill cost="11800000" inputTokens={1862} outputTokens={412} />);

    expect(rowsOf(await openBreakdown())).toEqual([
      ['Input', '1,862 tokens'],
      ['Output', '412 tokens'],
      ['Cost', '$0.0118'],
    ]);
  });

  it('lists the cost alone when the reply carries no tokens', async () => {
    render(<CostPill cost="11800000" />);

    expect(rowsOf(await openBreakdown())).toEqual([['Cost', '$0.0118']]);
  });

  it('lists a token count the reply carries without the one it lacks', async () => {
    render(<CostPill cost="11800000" outputTokens={412} />);

    expect(rowsOf(await openBreakdown())).toEqual([
      ['Output', '412 tokens'],
      ['Cost', '$0.0118'],
    ]);
  });

  it('lists a recorded zero token count', async () => {
    render(<CostPill cost="11800000" inputTokens={0} outputTokens={412} />);

    expect(rowsOf(await openBreakdown())[0]).toEqual(['Input', '0 tokens']);
  });

  it('heads the anchored breakdown with its name', async () => {
    render(<CostPill cost="1360000" />);

    expect(within(await openBreakdown()).getByText('This reply')).toBeInTheDocument();
  });

  it('keeps the cost figure the only one counted as the reply cost while open', async () => {
    render(<CostPill cost="1360000" inputTokens={10} outputTokens={20} />);
    await openBreakdown();

    expect(screen.getAllByTestId(TEST_IDS.messageCost)).toHaveLength(1);
  });
});
