import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { makeFinding, makeQuestion } from '@/test-utils/finding-fixture';
import { TEST_IDS } from '@/test-ids';
import { withAuditAddress } from '@/test-utils/audit-address';
import { paneBody, paneLead, paneList } from './pane-body';
import type { PaneDeps } from './pane-body';

function deps(overrides: Partial<PaneDeps> = {}): PaneDeps {
  return { put: vi.fn(), go: vi.fn(), onBulkRunning: vi.fn(), ...overrides };
}

describe('paneBody', () => {
  it('gives the dashboard section its own body', () => {
    const body = paneBody('dashboard', deps());
    render(body!([makeFinding({ id: 'A-1' })]), { wrapper: withAuditAddress });

    expect(screen.getByTestId(TEST_IDS.dashboardPane)).toBeInTheDocument();
  });

  it('lets the dashboard send the reader to another section', () => {
    const go = vi.fn();
    const body = paneBody('dashboard', deps({ go }));
    render(
      body!([
        makeFinding({
          id: 'A-1',
          state: 'ruled',
          progress: { status: 'blocked', updated: null, verified: false, notes: [] },
        }),
      ]),
      { wrapper: withAuditAddress }
    );

    fireEvent.click(screen.getByRole('button', { name: /Blocked/ }));

    expect(go).toHaveBeenCalledWith('blocked');
  });

  it('gives the progress section the board', () => {
    const body = paneBody('progress', deps());
    render(body!([makeFinding({ id: 'A-1', state: 'ruled' })]), { wrapper: withAuditAddress });

    expect(screen.getByTestId(TEST_IDS.progressBoard)).toBeInTheDocument();
  });

  /**
   * Dedicated is a queue like any other: the mark decides membership and the
   * shared queue does the rest, so it has no body, list or lead of its own.
   */
  it('leaves every state queue to the pane, so each keeps its card', () => {
    expect(paneBody('open', deps())).toBeUndefined();
    expect(paneBody('dedicated', deps())).toBeUndefined();
    expect(paneBody('questions', deps())).toBeUndefined();
    expect(paneBody('blocked', deps())).toBeUndefined();
    expect(paneBody('ruled', deps())).toBeUndefined();
    expect(paneBody('denied', deps())).toBeUndefined();
  });
});

describe('paneList', () => {
  it('hands the review list the finding the url names', () => {
    const list = paneList('ruled', deps());
    render(
      list!(
        [makeFinding({ id: 'A-1', state: 'ruled' }), makeFinding({ id: 'A-2', state: 'ruled' })],
        'A-2'
      ),
      { wrapper: withAuditAddress }
    );

    const marked = screen
      .getAllByTestId(TEST_IDS.ruledRow)
      .filter((row) => row.getAttribute('aria-current') === 'true');

    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent('A-2');
  });

  it('marks nothing when it is handed no finding', () => {
    const list = paneList('denied', deps());
    render(
      list!(
        [
          makeFinding({
            id: 'A-1',
            state: 'denied',
            denial: { by: 'audit', reason: null, at: '2026-07-30' },
          }),
        ],
        null
      ),
      { wrapper: withAuditAddress }
    );

    expect(
      screen.getAllByTestId(TEST_IDS.deniedRow).filter((r) => r.hasAttribute('aria-current'))
    ).toHaveLength(0);
  });

  it('gives the ruled section its review list', () => {
    const list = paneList('ruled', deps());
    render(list!([makeFinding({ id: 'A-1', state: 'ruled' })], null), {
      wrapper: withAuditAddress,
    });

    expect(screen.getByTestId(TEST_IDS.ruledPane)).toBeInTheDocument();
  });

  it('gives the denied section its split review list', () => {
    const list = paneList('denied', deps());
    render(
      list!(
        [
          makeFinding({
            id: 'A-1',
            state: 'denied',
            denial: { by: 'audit', reason: null, at: '2026-07-30' },
          }),
        ],
        null
      ),
      { wrapper: withAuditAddress }
    );

    expect(screen.getByTestId(TEST_IDS.deniedPane)).toBeInTheDocument();
  });

  it('leaves the rows to the pane everywhere else', () => {
    expect(paneList('open', deps())).toBeUndefined();
    expect(paneList('dedicated', deps())).toBeUndefined();
    expect(paneList('questions', deps())).toBeUndefined();
    expect(paneList('blocked', deps())).toBeUndefined();
    expect(paneList('dashboard', deps())).toBeUndefined();
    expect(paneList('progress', deps())).toBeUndefined();
  });
});

describe('paneLead', () => {
  it('gives the questions section its working surface above the queue', () => {
    const lead = paneLead('questions', deps());
    render(
      lead!([makeFinding({ id: 'A-1', questions: [makeQuestion({ text: 'which pool?' })] })]),
      { wrapper: withAuditAddress }
    );

    expect(screen.getByTestId(TEST_IDS.compiledQuestions)).toBeInTheDocument();
  });

  it('leaves every other section without one', () => {
    expect(paneLead('open', deps())).toBeUndefined();
    expect(paneLead('dedicated', deps())).toBeUndefined();
    expect(paneLead('blocked', deps())).toBeUndefined();
    expect(paneLead('dashboard', deps())).toBeUndefined();
    expect(paneLead('progress', deps())).toBeUndefined();
    expect(paneLead('ruled', deps())).toBeUndefined();
    expect(paneLead('denied', deps())).toBeUndefined();
  });
});
