import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { BlockedReport } from './blocked-report';
import type { FindingJson, Progress } from '@hushbox/docket';

const STOPPED: Progress = {
  status: 'blocked',
  updated: '2026-08-01',
  verified: false,
  notes: [
    { at: '2026-07-31', by: 'agent', text: 'Started on the migration.' },
    { at: '2026-08-01', by: 'agent', text: 'The ruling names no owner.' },
  ],
};

function stalled(progress: Partial<Progress> = {}): FindingJson {
  return makeFinding({ id: 'A-1', state: 'ruled', progress: { ...STOPPED, ...progress } });
}

describe('BlockedReport', () => {
  it('gives the reason the agent recorded last', () => {
    render(<BlockedReport finding={stalled()} />);

    expect(screen.getByText('The ruling names no owner.')).toBeInTheDocument();
  });

  it('gives the whole run the agent stopped in the middle of', () => {
    render(<BlockedReport finding={stalled()} />);

    expect(screen.getByTestId(TEST_IDS.blockingNote)).toHaveTextContent(
      'Started on the migration.'
    );
  });

  /**
   * The reason and the answer to it are two different things to read, and the
   * reader writes the answer while looking at both. A reply folded into the
   * account would be read as part of what the agent said.
   */
  it('reads the replies apart from the account they answer', () => {
    render(
      <BlockedReport
        finding={stalled({
          notes: [
            ...STOPPED.notes,
            { at: '2026-08-02', by: 'human', text: 'The api slice owns it.' },
          ],
        })}
      />
    );

    expect(screen.getByTestId(TEST_IDS.blockingReplies)).toHaveTextContent(
      'The api slice owns it.'
    );
    expect(screen.getByTestId(TEST_IDS.blockingNote)).not.toHaveTextContent(
      'The api slice owns it.'
    );
  });

  it('still gives the agent’s reason once somebody has replied to it', () => {
    render(
      <BlockedReport
        finding={stalled({
          notes: [
            ...STOPPED.notes,
            { at: '2026-08-02', by: 'human', text: 'The api slice owns it.' },
          ],
        })}
      />
    );

    expect(screen.getByTestId(TEST_IDS.blockingNote)).toHaveTextContent(
      'The ruling names no owner.'
    );
  });

  /**
   * An agent can block through the CLI without writing a note, so a thread can
   * hold replies with no account to attribute them to. Dropping them would hide
   * that anything was said at all.
   */
  it('shows the replies on a block the agent never wrote a reason for', () => {
    render(
      <BlockedReport
        finding={stalled({
          notes: [{ at: '2026-08-02', by: 'human', text: 'The api slice owns it.' }],
        })}
      />
    );

    expect(screen.getByTestId(TEST_IDS.blockingReplies)).toHaveTextContent(
      'The api slice owns it.'
    );
    expect(screen.queryByTestId(TEST_IDS.blockingNote)).not.toBeInTheDocument();
  });

  it('offers no replies block rather than an empty one where nobody has replied', () => {
    render(<BlockedReport finding={stalled()} />);

    expect(screen.queryByTestId(TEST_IDS.blockingReplies)).not.toBeInTheDocument();
  });

  it('names whose account the reason is', () => {
    render(<BlockedReport finding={stalled()} />);

    expect(screen.getByTestId(TEST_IDS.blockingNote)).toHaveTextContent('agent');
  });

  it('says when the work last moved', () => {
    render(<BlockedReport finding={stalled()} />);

    expect(screen.getByTestId(TEST_IDS.blockedStamp)).toHaveTextContent('2026-08-01');
  });

  /**
   * The screen with the least on it: no reason, and no date either until this was
   * pinned. An agent blocking through the CLI without a note leaves exactly this
   * shape, and "when did this last move" is the only question left to ask of it.
   */
  it('still says when the work last moved where nobody wrote a reason', () => {
    render(<BlockedReport finding={stalled({ notes: [] })} />);

    expect(screen.getByTestId(TEST_IDS.blockedStamp)).toHaveTextContent('2026-08-01');
  });

  it('says nothing about when it moved on a finding that never reported', () => {
    render(<BlockedReport finding={stalled({ updated: null })} />);

    expect(screen.queryByTestId(TEST_IDS.blockedStamp)).not.toBeInTheDocument();
  });

  it('offers no reason block rather than an empty one when nothing was recorded', () => {
    render(<BlockedReport finding={stalled({ notes: [] })} />);

    expect(screen.queryByTestId(TEST_IDS.blockingNote)).not.toBeInTheDocument();
  });

  it('still gives the reason on a finding that never stamped a report', () => {
    render(<BlockedReport finding={stalled({ updated: null })} />);

    expect(screen.getByText('The ruling names no owner.')).toBeInTheDocument();
  });

  it('stays away altogether on a finding whose work never stopped', () => {
    render(<BlockedReport finding={stalled({ status: 'in-progress' })} />);

    expect(screen.queryByTestId(TEST_IDS.blockedStamp)).not.toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.blockingNote)).not.toBeInTheDocument();
  });
});
