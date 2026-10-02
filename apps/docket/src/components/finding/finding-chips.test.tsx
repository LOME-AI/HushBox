import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { FindingChips } from './finding-chips';

const corpus = [
  makeFinding({ id: 'AI-1', state: 'open' }),
  makeFinding({ id: 'AI-5', state: 'denied' }),
];

describe('FindingChips', () => {
  it('names the relationship', () => {
    render(<FindingChips label="Related" ids={['AI-5']} findings={corpus} onJump={vi.fn()} />);

    expect(screen.getByText('Related')).toBeInTheDocument();
  });

  it('shows each partner with the state it is in', () => {
    render(<FindingChips label="Related" ids={['AI-5']} findings={corpus} onJump={vi.fn()} />);

    const [chip] = screen.getAllByTestId(TEST_IDS.findingChip);
    expect(chip).toHaveTextContent('AI-5');
    expect(chip).toHaveTextContent('denied');
  });

  it('jumps to the partner when the chip is taken', () => {
    const onJump = vi.fn();
    render(<FindingChips label="Related" ids={['AI-5']} findings={corpus} onJump={onJump} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.findingChip));

    expect(onJump).toHaveBeenCalledWith('AI-5');
  });

  it('shows an id the audit does not hold without offering a jump', () => {
    render(<FindingChips label="Related" ids={['GONE-1']} findings={corpus} onJump={vi.fn()} />);

    expect(screen.getByText('GONE-1')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing when there is no relationship to show', () => {
    const { container } = render(
      <FindingChips label="Related" ids={[]} findings={corpus} onJump={vi.fn()} />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
