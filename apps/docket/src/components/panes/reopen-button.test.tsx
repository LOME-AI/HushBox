import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { ReopenButton } from './reopen-button';
import type { PaneWrites } from './pane-writes';
import type { FindingJson, ProgressNote } from '@hushbox/docket';

function writes(overrides: Partial<PaneWrites> = {}): PaneWrites {
  return { run: () => Promise.resolve(true), errorFor: () => null, ...overrides };
}

function note(text: string): ProgressNote {
  return { at: '2026-07-30', by: 'agent', text };
}

function ruled(overrides: Partial<FindingJson> = {}): FindingJson {
  return makeFinding({
    id: 'A-1',
    state: 'ruled',
    ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
    ...overrides,
  });
}

describe('ReopenButton', () => {
  it('warns before discarding a ruling nobody has worked on yet', () => {
    const run = vi.fn(() => Promise.resolve(true));
    render(<ReopenButton finding={ruled()} writes={writes({ run })} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.reopenFinding));

    expect(run).not.toHaveBeenCalled();
    expect(screen.getByTestId(TEST_IDS.confirmAccept)).toBeInTheDocument();
  });

  it('says only that the ruling is archived where there is no work to lose', () => {
    render(<ReopenButton finding={ruled()} writes={writes()} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.reopenFinding));

    expect(screen.queryByText(/progress note/u)).toBeNull();
    expect(screen.queryByText(/notes are kept/u)).toBeNull();
    expect(
      screen.getByText("The decision is archived into the finding's history, not lost.")
    ).toBeInTheDocument();
  });

  it('says the notes survive the reopen', () => {
    const finding = ruled({
      progress: { status: 'blocked', updated: null, verified: false, notes: [note('one')] },
    });
    render(<ReopenButton finding={finding} writes={writes()} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.reopenFinding));

    expect(screen.getByText(/notes are kept/u)).toBeInTheDocument();
  });

  it('says the status and the verification do not survive it', () => {
    const finding = ruled({
      progress: { status: 'blocked', updated: null, verified: true, notes: [note('one')] },
    });
    render(<ReopenButton finding={finding} writes={writes()} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.reopenFinding));

    expect(
      screen.getByText(/status and verification return to their defaults/u)
    ).toBeInTheDocument();
  });

  it('warns before discarding a ruling work has been done against', () => {
    const finding = ruled({
      progress: { status: 'in-progress', updated: null, verified: false, notes: [note('started')] },
    });
    const run = vi.fn(() => Promise.resolve(true));
    render(<ReopenButton finding={finding} writes={writes({ run })} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.reopenFinding));

    expect(run).not.toHaveBeenCalled();
    expect(screen.getByTestId(TEST_IDS.confirmAccept)).toBeInTheDocument();
  });

  it('names how many notes are at stake', () => {
    const finding = ruled({
      progress: {
        status: 'in-progress',
        updated: null,
        verified: false,
        notes: [note('one'), note('two')],
      },
    });
    render(<ReopenButton finding={finding} writes={writes()} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.reopenFinding));

    expect(
      screen.getByText('It is marked In progress, with 2 progress notes.')
    ).toBeInTheDocument();
  });

  it('names a single note without pluralising it', () => {
    const finding = ruled({
      progress: { status: 'done', updated: null, verified: false, notes: [note('one')] },
    });
    render(<ReopenButton finding={finding} writes={writes()} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.reopenFinding));

    expect(screen.getByText('It is marked Done, with 1 progress note.')).toBeInTheDocument();
  });

  it('reopens once the warning is accepted', async () => {
    const finding = ruled({
      progress: { status: 'done', updated: null, verified: false, notes: [note('one')] },
    });
    const run = vi.fn(() => Promise.resolve(true));
    render(<ReopenButton finding={finding} writes={writes({ run })} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.reopenFinding));
    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));

    await waitFor(() => {
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: 'A-1' }), 'reopen', {});
    });
  });

  it('leaves the ruling alone when the warning is refused', () => {
    const finding = ruled({
      progress: { status: 'done', updated: null, verified: false, notes: [note('one')] },
    });
    const run = vi.fn(() => Promise.resolve(true));
    render(<ReopenButton finding={finding} writes={writes({ run })} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.reopenFinding));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(run).not.toHaveBeenCalled();
  });

  it('says what the work is on verified work, rather than naming zero notes', () => {
    const finding = ruled({
      progress: { status: 'done', updated: null, verified: true, notes: [] },
    });
    render(<ReopenButton finding={finding} writes={writes()} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.reopenFinding));

    expect(
      screen.getByText('It is marked Done and verified, with no progress notes.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/0 progress notes/u)).toBeNull();
  });

  it('warns when work has started even without a note', () => {
    const finding = ruled({
      progress: { status: 'in-progress', updated: null, verified: false, notes: [] },
    });
    render(<ReopenButton finding={finding} writes={writes()} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.reopenFinding));

    expect(screen.getByTestId(TEST_IDS.confirmAccept)).toBeInTheDocument();
  });

  it('says a finding with nothing to choose from goes back for options', () => {
    const finding = ruled({
      options: [],
      progress: { status: 'done', updated: null, verified: false, notes: [note('one')] },
    });
    render(<ReopenButton finding={finding} writes={writes()} />);

    fireEvent.click(screen.getByTestId(TEST_IDS.reopenFinding));

    expect(
      screen.getByText('It carries no options, so it goes back to the audit for them.')
    ).toBeInTheDocument();
  });

  it('shows a refusal against the finding it belongs to', () => {
    render(
      <ReopenButton
        finding={ruled()}
        writes={writes({
          errorFor: (id) => (id === 'A-1' ? 'only a decided finding reopens' : null),
        })}
      />
    );

    expect(screen.getByTestId(TEST_IDS.paneError)).toHaveTextContent(
      'only a decided finding reopens'
    );
  });
});
