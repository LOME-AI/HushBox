import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { FindingPalette } from './finding-palette';

const corpus = [
  makeFinding({ id: 'AI-1', title: 'the pool is torn down early' }),
  makeFinding({ id: 'DB-3', title: 'the ledger trigger is deferrable' }),
];

describe('FindingPalette', () => {
  it('stays out of the way while closed', () => {
    render(<FindingPalette open={false} onClose={vi.fn()} findings={corpus} onJump={vi.fn()} />);

    expect(screen.queryByTestId(TEST_IDS.findingPalette)).toBeNull();
  });

  it('lists the audit when it opens', () => {
    render(<FindingPalette open={true} onClose={vi.fn()} findings={corpus} onJump={vi.fn()} />);

    expect(screen.getAllByTestId(TEST_IDS.paletteOption)).toHaveLength(2);
  });

  it('narrows to what was typed', () => {
    render(<FindingPalette open={true} onClose={vi.fn()} findings={corpus} onJump={vi.fn()} />);

    fireEvent.change(screen.getByTestId(TEST_IDS.paletteInput), { target: { value: 'ledger' } });

    expect(screen.getAllByTestId(TEST_IDS.paletteOption).length).toBeGreaterThan(0);
    expect(screen.queryByText('the pool is torn down early')).toBeNull();
  });

  it('says so when nothing matches, instead of leaving an empty box open', () => {
    render(<FindingPalette open={true} onClose={vi.fn()} findings={corpus} onJump={vi.fn()} />);

    fireEvent.change(screen.getByTestId(TEST_IDS.paletteInput), { target: { value: 'zzzz' } });

    expect(screen.queryAllByTestId(TEST_IDS.paletteOption)).toHaveLength(0);
    expect(screen.getByText('No finding matches that search')).toBeInTheDocument();
    expect(
      screen.getByText('Try part of a finding id, or a word from its title.')
    ).toBeInTheDocument();
  });

  it('leaves nothing behind to press when it has nothing to offer', () => {
    const onJump = vi.fn();
    render(<FindingPalette open={true} onClose={vi.fn()} findings={corpus} onJump={onJump} />);
    fireEvent.change(screen.getByTestId(TEST_IDS.paletteInput), { target: { value: 'zzzz' } });

    fireEvent.keyDown(screen.getByTestId(TEST_IDS.paletteInput), { key: 'Enter' });

    expect(onJump).not.toHaveBeenCalled();
  });

  it('jumps to the finding that was chosen', () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    render(<FindingPalette open={true} onClose={onClose} findings={corpus} onJump={onJump} />);

    fireEvent.click(screen.getAllByTestId(TEST_IDS.paletteOption)[1]!);

    expect(onJump).toHaveBeenCalledWith('DB-3');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
