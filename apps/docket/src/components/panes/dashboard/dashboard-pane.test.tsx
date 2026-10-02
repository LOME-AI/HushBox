import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { DashboardPane } from './dashboard-pane';
import type { FindingJson } from '@hushbox/docket';

function ruledByAudit(id: string, overrides: Partial<FindingJson> = {}): FindingJson {
  return makeFinding({
    id,
    state: 'ruled',
    needsRuling: false,
    ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
    ...overrides,
  });
}

function renderPane(findings: readonly FindingJson[]): ReturnType<typeof vi.fn> {
  const onSection = vi.fn();
  render(<DashboardPane findings={findings} onSection={onSection} />);
  return onSection;
}

function tile(testId: string): string | null {
  return within(screen.getByTestId(testId)).getByTestId(`${testId}-value`).textContent;
}

describe('DashboardPane', () => {
  it('leads with what is still waiting on the reader', () => {
    renderPane([makeFinding({ id: 'A-1' }), makeFinding({ id: 'A-2' }), ruledByAudit('A-3')]);

    expect(tile(TEST_IDS.dashboardAwaiting)).toBe('2');
  });

  it('counts what the audit settled on its own apart from what the reader decided', () => {
    renderPane([
      ruledByAudit('A-1'),
      makeFinding({
        id: 'A-2',
        state: 'denied',
        denial: { by: 'human', reason: null, at: '2026-07-31' },
      }),
    ]);

    expect(tile(TEST_IDS.dashboardSettled)).toBe('1');
    expect(tile(TEST_IDS.dashboardDecided)).toBe('1');
  });

  it('says why a settled finding never reached the reader', () => {
    renderPane([ruledByAudit('A-1')]);

    expect(screen.getByText(/the audit settles what it can on sight/i)).toBeInTheDocument();
  });

  it('counts the ruled findings implementation is blocked on', () => {
    renderPane([
      ruledByAudit('A-1', {
        progress: { status: 'blocked', updated: null, verified: false, notes: [] },
      }),
    ]);

    expect(tile(TEST_IDS.dashboardBlocked)).toBe('1');
  });

  it('sends the reader to the queue the blocked figure counted', () => {
    const onSection = renderPane([
      ruledByAudit('A-1', {
        progress: { status: 'blocked', updated: null, verified: false, notes: [] },
      }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: /Blocked/ }));

    expect(onSection).toHaveBeenCalledWith('blocked');
  });

  it('counts the findings owed a session of their own', () => {
    renderPane([makeFinding({ id: 'A-1', dedicated: true }), makeFinding({ id: 'A-2' })]);

    expect(tile(TEST_IDS.dashboardDedicated)).toBe('1');
  });

  it('sends the reader to the queue the dedicated figure counted', () => {
    const onSection = renderPane([makeFinding({ id: 'A-1', dedicated: true })]);

    fireEvent.click(screen.getByRole('button', { name: /session/ }));

    expect(onSection).toHaveBeenCalledWith('dedicated');
  });

  it('leaves a figure with nowhere to go as a figure', () => {
    renderPane([makeFinding({ id: 'A-1' })]);

    expect(
      within(screen.getByTestId(TEST_IDS.dashboardAwaiting)).queryByRole('button')
    ).not.toBeInTheDocument();
  });

  it('breaks the remaining work down by severity', () => {
    renderPane([makeFinding({ id: 'A-1', severity: 'critical' })]);

    const row = within(screen.getByTestId(TEST_IDS.dashboardSeverity)).getByRole('row', {
      name: /critical/,
    });

    expect(row).toHaveTextContent('1');
  });

  it('names the severity breakdown’s scroll region for what it counts', () => {
    renderPane([makeFinding({ id: 'A-1', severity: 'critical' })]);

    expect(screen.getByRole('group', { name: 'Remaining by severity' })).toBe(
      screen.getByTestId(TEST_IDS.dashboardSeverity).parentElement
    );
  });

  it('names the area breakdown’s scroll region for what it counts', () => {
    renderPane([makeFinding({ id: 'A-1', area: 'unknown' })]);

    expect(screen.getByRole('group', { name: 'Remaining by area' })).toBe(
      screen.getByTestId(TEST_IDS.dashboardArea).parentElement
    );
  });

  it('breaks the remaining work down by area', () => {
    renderPane([makeFinding({ id: 'A-1', area: 'unknown' })]);

    const row = within(screen.getByTestId(TEST_IDS.dashboardArea)).getByRole('row', {
      name: /unknown/,
    });

    expect(row).toHaveTextContent('1');
  });

  it('says what its area counts are counted over, because the filter rail counts the same areas differently', () => {
    renderPane([makeFinding({ id: 'A-1', area: 'unknown' })]);

    expect(
      screen.getByText('Counted over what is awaiting you, in every section.')
    ).toBeInTheDocument();
  });

  it('drops the breakdowns when nothing is waiting on the reader', () => {
    renderPane([ruledByAudit('A-1')]);

    expect(screen.getByText('Nothing is waiting on you.')).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.dashboardSeverity)).not.toBeInTheDocument();
  });
});
