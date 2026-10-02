import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { RuledRow } from './ruled-row';
import type { PaneWrites } from '../pane-writes';
import type { FindingJson, Ruling } from '@hushbox/docket';

function writes(): PaneWrites {
  return { run: () => Promise.resolve(true), errorFor: () => null };
}

function ruling(overrides: Partial<Ruling> = {}): Ruling {
  return { option: 'A', text: null, note: null, at: '2026-07-30', ...overrides };
}

function ruled(overrides: Partial<FindingJson> = {}): FindingJson {
  return makeFinding({ id: 'A-1', state: 'ruled', ruling: ruling(), ...overrides });
}

describe('RuledRow', () => {
  it('marks the row the reader is on', () => {
    render(<RuledRow finding={ruled()} writes={writes()} selected />);

    expect(screen.getByTestId(TEST_IDS.ruledRow)).toHaveAttribute('aria-current', 'true');
  });

  it('leaves an unselected row unmarked', () => {
    render(<RuledRow finding={ruled()} writes={writes()} />);

    expect(screen.getByTestId(TEST_IDS.ruledRow)).not.toHaveAttribute('aria-current');
  });

  it('names the finding', () => {
    render(<RuledRow finding={ruled()} writes={writes()} />);

    expect(screen.getByText('A-1')).toBeInTheDocument();
  });

  it('shows the title', () => {
    render(
      <RuledRow finding={ruled({ title: 'The pool is torn down early' })} writes={writes()} />
    );

    expect(screen.getByText('The pool is torn down early')).toBeInTheDocument();
  });

  it('names the option that was chosen', () => {
    render(<RuledRow finding={ruled()} writes={writes()} />);

    expect(screen.getByText('Option A')).toBeInTheDocument();
  });

  it('renders a title the audit wrote in markdown, rather than showing its source', () => {
    const finding = ruled({
      title: 'A bare fetch slips past the rule',
      titleHtml: 'A bare <code>fetch</code> slips past the rule',
    });

    const { container } = render(<RuledRow finding={finding} writes={writes()} />);

    expect(container.querySelector('code')).toHaveTextContent('fetch');
  });

  it('names what the chosen option was, not only which letter it wore', () => {
    const finding = ruled({
      options: [
        {
          id: 'A',
          label: 'Pipeline owns post-response scheduling',
          recommended: true,
          dedicated: false,
          meta: null,
          html: '<p>why</p>',
        },
      ],
    });

    render(<RuledRow finding={finding} writes={writes()} />);

    expect(
      screen.getByText('Option A: Pipeline owns post-response scheduling')
    ).toBeInTheDocument();
  });

  it('shows a free-text ruling as the words the reader wrote', () => {
    const finding = ruled({ ruling: ruling({ option: 'other', text: 'do it the third way' }) });

    render(<RuledRow finding={finding} writes={writes()} />);

    expect(screen.getByText('do it the third way')).toBeInTheDocument();
  });

  it('does not label a free-text ruling with its internal option id', () => {
    const finding = ruled({ ruling: ruling({ option: 'other', text: 'do it the third way' }) });

    render(<RuledRow finding={finding} writes={writes()} />);

    expect(screen.queryByText('Option other')).not.toBeInTheDocument();
  });

  it('shows the note left with the ruling', () => {
    const finding = ruled({ ruling: ruling({ note: 'log the skipped pass' }) });

    render(<RuledRow finding={finding} writes={writes()} />);

    expect(screen.getByText('log the skipped pass')).toBeInTheDocument();
  });

  it('says where the implementation has got to', () => {
    const finding = ruled({
      progress: { status: 'in-progress', updated: null, verified: false, notes: [] },
    });

    render(<RuledRow finding={finding} writes={writes()} />);

    expect(screen.getByText('In progress')).toBeInTheDocument();
  });

  it('offers the way back to open', () => {
    render(<RuledRow finding={ruled()} writes={writes()} />);

    expect(screen.getByTestId(TEST_IDS.reopenFinding)).toBeInTheDocument();
  });

  it('keeps the evidence reachable without leaving the pane', () => {
    render(
      <RuledRow
        finding={ruled({ bodyHtml: '<p>The connection is torn down.</p>' })}
        writes={writes()}
      />
    );

    expect(screen.getByText('The connection is torn down.')).toBeInTheDocument();
  });

  it('renders a finding whose ruling was somehow lost without crashing', () => {
    render(<RuledRow finding={makeFinding({ id: 'A-1', state: 'ruled' })} writes={writes()} />);

    expect(screen.getByText('No ruling recorded')).toBeInTheDocument();
  });

  it('shows a paragraph-length title in full rather than dropping it', () => {
    const title = 'x'.repeat(738);

    render(<RuledRow finding={ruled({ title })} writes={writes()} />);

    expect(screen.getByTestId(TEST_IDS.ruledRow).textContent).toContain(title);
  });
});
