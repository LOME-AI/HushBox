import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { UnblockBox } from './unblock-box';
import type { FindingJson, Progress } from '@hushbox/docket';

const STOPPED: Progress = {
  status: 'blocked',
  updated: '2026-08-01',
  verified: false,
  notes: [{ at: '2026-08-01', by: 'agent', text: 'The ruling names no owner.' }],
};

function stalled(progress: Partial<Progress> = {}): FindingJson {
  return makeFinding({ id: 'A-1', state: 'ruled', progress: { ...STOPPED, ...progress } });
}

/**
 * The mark is the card's, so the box is given one and reports the reader's
 * answer back. Rendering it through here keeps every case honest about which
 * of the two it is exercising.
 */
function renderBox(
  overrides: {
    readonly finding?: FindingJson;
    readonly focused?: number | null;
    readonly dedicated?: boolean;
  } = {}
): {
  onUnblock: ReturnType<typeof vi.fn<(note: string) => void>>;
  onDedicated: ReturnType<typeof vi.fn<(dedicated: boolean) => void>>;
} {
  const onUnblock = vi.fn<(note: string) => void>();
  const onDedicated = vi.fn<(dedicated: boolean) => void>();
  render(
    <UnblockBox
      finding={overrides.finding ?? stalled()}
      focused={overrides.focused ?? null}
      dedicated={overrides.dedicated ?? false}
      onDedicated={onDedicated}
      onUnblock={onUnblock}
      onDrafting={vi.fn()}
    />
  );
  return { onUnblock, onDedicated };
}

describe('UnblockBox', () => {
  it('offers the box the answer is written in', () => {
    renderBox();

    expect(screen.getByLabelText('Answer the block')).toBeInTheDocument();
  });

  it('sends the answer the reader wrote', () => {
    const { onUnblock } = renderBox();

    fireEvent.change(screen.getByLabelText('Answer the block'), {
      target: { value: 'the api slice owns it' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Answer and unblock' }));

    expect(onUnblock).toHaveBeenCalledWith('the api slice owns it');
  });

  it('offers the mark beside the answer', () => {
    const { onDedicated } = renderBox();

    fireEvent.click(screen.getByTestId(TEST_IDS.unblockDedicated));

    expect(onDedicated).toHaveBeenCalledWith(true);
  });

  /** The box is the human's answer to a mark an agent made, so it shows it. */
  it('shows the mark the card is holding', () => {
    renderBox({ dedicated: true });

    expect(screen.getByTestId(TEST_IDS.unblockDedicated)).toBeChecked();
  });

  it('reports the mark being taken back off', () => {
    const { onDedicated } = renderBox({ dedicated: true });

    fireEvent.click(screen.getByTestId(TEST_IDS.unblockDedicated));

    expect(onDedicated).toHaveBeenCalledWith(false);
  });

  /**
   * Unblocking on silence would hand the finding back carrying the same
   * question, so there is nothing to send until something has been written.
   */
  it('sends nothing from an empty box', () => {
    renderBox();

    expect(screen.getByRole('button', { name: 'Answer and unblock' })).toBeDisabled();
  });

  it('takes the caret when the console’s keyboard sends the reader here', () => {
    renderBox({ focused: 1 });

    expect(screen.getByLabelText('Answer the block')).toHaveFocus();
  });

  it('stays away on a finding whose work never stopped', () => {
    renderBox({ finding: stalled({ status: 'in-progress' }) });

    expect(screen.queryByLabelText('Answer the block')).not.toBeInTheDocument();
  });

  it('stays away on a finding nobody has ruled, whose status is a stale field', () => {
    renderBox({ finding: makeFinding({ id: 'A-1', state: 'open', progress: STOPPED }) });

    expect(screen.queryByLabelText('Answer the block')).not.toBeInTheDocument();
  });
});
