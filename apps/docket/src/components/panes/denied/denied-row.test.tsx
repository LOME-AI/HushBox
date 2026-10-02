import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { DeniedRow } from './denied-row';
import type { PaneWrites } from '../pane-writes';
import type { Denial, FindingJson } from '@hushbox/docket';

function writes(): PaneWrites {
  return { run: () => Promise.resolve(true), errorFor: () => null };
}

function denied(overrides: Partial<Denial> = {}, finding: Partial<FindingJson> = {}): FindingJson {
  return makeFinding({
    id: 'A-1',
    state: 'denied',
    denial: { by: 'human', reason: null, at: '2026-07-30', ...overrides },
    ...finding,
  });
}

describe('DeniedRow', () => {
  it('marks the row the reader is on', () => {
    render(<DeniedRow finding={denied()} writes={writes()} selected />);

    expect(screen.getByTestId(TEST_IDS.deniedRow)).toHaveAttribute('aria-current', 'true');
  });

  it('leaves an unselected row unmarked', () => {
    render(<DeniedRow finding={denied()} writes={writes()} />);

    expect(screen.getByTestId(TEST_IDS.deniedRow)).not.toHaveAttribute('aria-current');
  });

  it('names the finding', () => {
    render(<DeniedRow finding={denied()} writes={writes()} />);

    expect(screen.getByText('A-1')).toBeInTheDocument();
  });

  it('shows the reason the finding was refused', () => {
    render(
      <DeniedRow finding={denied({ reason: 'the cost is not worth it' })} writes={writes()} />
    );

    expect(screen.getByText('the cost is not worth it')).toBeInTheDocument();
  });

  it('says outright when no reason was recorded', () => {
    render(<DeniedRow finding={denied()} writes={writes()} />);

    expect(screen.getByText('No reason recorded')).toBeInTheDocument();
  });

  it('offers the way back to open', () => {
    render(<DeniedRow finding={denied()} writes={writes()} />);

    expect(screen.getByTestId(TEST_IDS.reopenFinding)).toBeInTheDocument();
  });

  it('keeps the evidence reachable without leaving the pane', () => {
    render(
      <DeniedRow finding={denied({}, { bodyHtml: '<p>Refuted because.</p>' })} writes={writes()} />
    );

    expect(screen.getByText('Refuted because.')).toBeInTheDocument();
  });

  it('renders a finding whose denial was somehow lost without crashing', () => {
    render(<DeniedRow finding={makeFinding({ id: 'A-1', state: 'denied' })} writes={writes()} />);

    expect(screen.getByText('No reason recorded')).toBeInTheDocument();
  });

  it('renders a title the audit wrote in markdown, rather than showing its source', () => {
    const finding = denied(
      {},
      {
        title: 'A bare fetch slips past the rule',
        titleHtml: 'A bare <code>fetch</code> slips past the rule',
      }
    );

    const { container } = render(<DeniedRow finding={finding} writes={writes()} />);

    expect(container.querySelector('code')).toHaveTextContent('fetch');
  });

  it('shows a paragraph-length title in full rather than dropping it', () => {
    const title = 'x'.repeat(738);

    render(<DeniedRow finding={denied({}, { title })} writes={writes()} />);

    expect(screen.getByTestId(TEST_IDS.deniedRow).textContent).toContain(title);
  });
});
