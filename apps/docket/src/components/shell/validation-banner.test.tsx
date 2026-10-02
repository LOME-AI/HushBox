import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TEST_IDS } from '@/test-ids';
import { ValidationBanner } from './validation-banner';
import type { ValidationEntry } from '@hushbox/docket';

const entries: readonly ValidationEntry[] = [
  {
    id: 'DB-3',
    path: '/repo/docs/audits/2026-07-30/findings/DB-3.md',
    issues: [{ code: 'invalid-enum', field: 'severity', message: 'severity is not a known value' }],
  },
  {
    id: 'UI-7',
    path: '/repo/docs/audits/2026-07-30/findings/UI-7.md',
    issues: [{ code: 'missing-field', field: 'area', message: 'area is missing' }],
  },
];

describe('ValidationBanner', () => {
  it('stays out of the way when every finding parsed', () => {
    render(<ValidationBanner entries={[]} />);

    expect(screen.queryByTestId(TEST_IDS.validationBanner)).not.toBeInTheDocument();
  });

  it('counts the findings the format rejected', () => {
    render(<ValidationBanner entries={entries} />);

    expect(screen.getByTestId(TEST_IDS.validationBanner)).toHaveTextContent('2 findings');
  });

  it('names each finding and what is wrong with it', () => {
    render(<ValidationBanner entries={entries} />);

    expect(screen.getByText(/DB-3/)).toHaveTextContent('severity is not a known value');
    expect(screen.getByText(/UI-7/)).toHaveTextContent('area is missing');
  });

  it('counts a single rejected finding in the singular', () => {
    render(<ValidationBanner entries={[entries[0]!]} />);

    expect(screen.getByTestId(TEST_IDS.validationBanner)).toHaveTextContent(
      '1 finding could not be read and is missing from every section'
    );
  });

  it('reads as one sentence for more than one rejected finding', () => {
    render(<ValidationBanner entries={entries} />);

    expect(screen.getByTestId(TEST_IDS.validationBanner)).toHaveTextContent(
      '2 findings could not be read and are missing from every section'
    );
  });

  it('can be dismissed', () => {
    render(<ValidationBanner entries={entries} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByTestId(TEST_IDS.validationBanner)).not.toBeInTheDocument();
  });
});
