import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { ProgressCard } from './progress-card';
import type { ProgressActions } from './use-progress-actions';
import type { FindingJson, Progress } from '@hushbox/docket';

const PARAGRAPH_TITLE = `A title that is a paragraph. ${'word '.repeat(140)}end.`;

function tracked(
  progress: Partial<Progress> = {},
  overrides: Partial<FindingJson> = {}
): FindingJson {
  return makeFinding({
    id: 'A-1',
    state: 'ruled',
    progress: { status: 'not-started', updated: null, verified: false, notes: [], ...progress },
    ...overrides,
  });
}

function renderCard(finding: FindingJson = tracked()): ProgressActions & {
  errorFor: ReturnType<typeof vi.fn>;
} {
  const actions = {
    setStatus: vi.fn(),
    addNote: vi.fn(),
    setVerified: vi.fn(),
    errorFor: vi.fn().mockReturnValue(null),
  };
  render(<ProgressCard finding={finding} actions={actions} />);
  return actions;
}

describe('ProgressCard', () => {
  it('names the finding it tracks', () => {
    renderCard();

    expect(screen.getByTestId(TEST_IDS.progressCard)).toHaveTextContent('A-1');
  });

  it('shows the severity that made the finding worth tracking', () => {
    renderCard(tracked({}, { severity: 'critical' }));

    expect(screen.getByText('critical')).toBeInTheDocument();
  });

  it('says when the agent last reported on the work', () => {
    renderCard(tracked({ updated: '2026-08-01' }));

    expect(screen.getByText('2026-08-01')).toBeInTheDocument();
  });

  it('says nothing about a report on work no agent has touched', () => {
    renderCard(tracked({ updated: null }));

    expect(screen.getByTestId(TEST_IDS.progressCard)).not.toHaveTextContent(/last reported/u);
  });

  it('shows the area verbatim, placeholder or not', () => {
    renderCard(tracked({}, { area: 'unknown' }));

    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('renders a title the audit wrote in markdown, rather than showing its source', () => {
    renderCard(
      tracked(
        {},
        {
          title: 'A bare fetch slips past the rule',
          titleHtml: 'A bare <code>fetch</code> slips past the rule',
        }
      )
    );

    expect(screen.getByTestId(TEST_IDS.progressCard).querySelector('code')).toHaveTextContent(
      'fetch'
    );
  });

  it('keeps the whole title readable to a screen reader however long it is', () => {
    renderCard(tracked({}, { title: PARAGRAPH_TITLE }));

    expect(screen.getByTestId(TEST_IDS.progressCard)).toHaveTextContent(PARAGRAPH_TITLE);
  });

  it('shows the status the finding carries', () => {
    renderCard(tracked({ status: 'in-progress' }));

    expect(screen.getByTestId(TEST_IDS.progressStatus)).toHaveValue('in-progress');
  });

  it('sets the status the reader picks', () => {
    const actions = renderCard();

    fireEvent.change(screen.getByTestId(TEST_IDS.progressStatus), {
      target: { value: 'blocked' },
    });

    expect(actions.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'A-1' }),
      'blocked'
    );
  });

  it('ignores a status it does not recognise', () => {
    const actions = renderCard();

    fireEvent.change(screen.getByTestId(TEST_IDS.progressStatus), {
      target: { value: 'shipped' },
    });

    expect(actions.setStatus).not.toHaveBeenCalled();
  });

  it('offers verification only on finished work', () => {
    renderCard(tracked({ status: 'in-progress' }));

    expect(screen.queryByLabelText('Verified')).not.toBeInTheDocument();
  });

  it('keeps verification reachable once the work stops claiming done', () => {
    renderCard(tracked({ status: 'in-progress', verified: true }));

    expect(screen.getByLabelText('Verified')).toBeChecked();
  });

  it('lets the reader withdraw a verification the work no longer claims', () => {
    const actions = renderCard(tracked({ status: 'in-progress', verified: true }));

    fireEvent.click(screen.getByLabelText('Verified'));

    expect(actions.setVerified).toHaveBeenCalledWith(expect.objectContaining({ id: 'A-1' }), false);
  });

  it('records the reader verifying finished work', () => {
    const actions = renderCard(tracked({ status: 'done' }));

    fireEvent.click(screen.getByLabelText('Verified'));

    expect(actions.setVerified).toHaveBeenCalledWith(expect.objectContaining({ id: 'A-1' }), true);
  });

  it('takes a verification back', () => {
    const actions = renderCard(tracked({ status: 'done', verified: true }));

    fireEvent.click(screen.getByLabelText('Verified'));

    expect(actions.setVerified).toHaveBeenCalledWith(expect.objectContaining({ id: 'A-1' }), false);
  });

  it('marks work the reader has verified', () => {
    renderCard(tracked({ status: 'done', verified: true }));

    expect(screen.getByLabelText('Verified')).toBeChecked();
  });

  it('carries the note box with nothing clicked to reveal it', () => {
    renderCard();

    expect(screen.getByLabelText('Note on A-1')).toBeInTheDocument();
  });

  it('writes the note the reader types', () => {
    const actions = renderCard();

    fireEvent.change(screen.getByLabelText('Note on A-1'), {
      target: { value: 'waiting on the schema change' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));

    expect(actions.addNote).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'A-1' }),
      'waiting on the schema change'
    );
  });

  it('refuses to write an empty note', () => {
    renderCard();

    expect(screen.getByRole('button', { name: 'Add note' })).toBeDisabled();
  });

  it('empties the note box once the note is written', () => {
    renderCard();

    fireEvent.change(screen.getByLabelText('Note on A-1'), { target: { value: 'done looking' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));

    expect(screen.getByLabelText('Note on A-1')).toHaveValue('');
  });

  it('lets the reader throw a note away', () => {
    const actions = renderCard();

    fireEvent.change(screen.getByLabelText('Note on A-1'), { target: { value: 'never mind' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByLabelText('Note on A-1')).toHaveValue('');
    expect(actions.addNote).not.toHaveBeenCalled();
  });

  it('shows the notes already written against the finding', () => {
    renderCard(tracked({ notes: [{ at: '2026-07-31', by: 'agent', text: 'started' }] }));

    expect(screen.getByTestId(TEST_IDS.progressNote)).toHaveTextContent('started');
  });

  it('says why a write was refused', () => {
    const actions = {
      setStatus: vi.fn(),
      addNote: vi.fn(),
      setVerified: vi.fn(),
      errorFor: vi.fn().mockReturnValue('held by a writer'),
    };
    render(<ProgressCard finding={tracked()} actions={actions} />);

    expect(screen.getByTestId(TEST_IDS.progressError)).toHaveTextContent('held by a writer');
  });
});
