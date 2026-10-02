import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@/test-ids';
import { ProgressNotes } from './progress-notes';
import type { ProgressNote } from '@hushbox/docket';

const NOTES: readonly ProgressNote[] = [
  { at: '2026-07-30', by: 'agent', text: 'started on it' },
  { at: '2026-07-31', by: 'human', text: 'waiting on the schema change' },
];

describe('ProgressNotes', () => {
  it('reads oldest first, so the newest note is the last thing said', () => {
    render(<ProgressNotes notes={NOTES} />);

    const texts = screen.getAllByTestId(TEST_IDS.progressNote).map((note) => note.textContent);

    expect(texts[0]).toContain('started on it');
    expect(texts[1]).toContain('waiting on the schema change');
  });

  it('says who wrote each note', () => {
    render(<ProgressNotes notes={NOTES} />);

    expect(screen.getAllByTestId(TEST_IDS.progressNote)[1]).toHaveTextContent('human');
  });

  it('gives each note stamp a machine-readable date attribute', () => {
    render(<ProgressNotes notes={NOTES} />);

    const stamp = screen.getByText('2026-07-31');

    expect(stamp).toHaveAttribute('datetime', '2026-07-31');
  });

  // The datetime assertion reaches the newest note; this one covers a note at the head of the
  // list, so neither subsumes the other.
  it('shows the day a note was written', () => {
    render(<ProgressNotes notes={[{ at: '2026-07-30', by: 'agent', text: 'migrated' }]} />);

    expect(screen.getByText('2026-07-30')).toBeInTheDocument();
  });

  it('renders nothing when no note has been written', () => {
    render(<ProgressNotes notes={[]} />);

    expect(screen.queryByTestId(TEST_IDS.progressNote)).not.toBeInTheDocument();
  });
});
