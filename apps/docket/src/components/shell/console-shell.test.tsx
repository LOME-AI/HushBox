import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { makeFinding, makeQuestion } from '@/test-utils/finding-fixture';
import { stubIntersectionObserver } from '@/test-utils/intersection-observer';
import { TEST_IDS } from '@/test-ids';
import { ConsoleShell } from './console-shell';
import type { Snapshot } from '@/server/audit-service';
import type { FindingJson, Severity, ValidationEntry } from '@hushbox/docket';

const LONG_TITLE = `${'a very long sentence that keeps going '.repeat(20)}end`;

const findings = [
  makeFinding({ id: 'A-1', severity: 'critical', state: 'open', area: 'packages/db' }),
  makeFinding({ id: 'A-2', severity: 'low', state: 'open', area: 'unknown', title: LONG_TITLE }),
  makeFinding({ id: 'A-3', severity: 'low', state: 'open', questions: [makeQuestion()] }),
  makeFinding({ id: 'A-4', severity: 'medium', state: 'ruled' }),
  makeFinding({ id: 'A-5', severity: 'medium', state: 'denied' }),
  makeFinding({
    id: 'A-6',
    severity: 'medium',
    state: 'ruled',
    ruling: { option: 'A', text: null, note: null, at: '2026-07-31' },
    progress: {
      status: 'blocked',
      updated: '2026-08-01',
      verified: false,
      notes: [{ at: '2026-08-01', by: 'agent', text: 'The ruling names no owner.' }],
    },
  }),
];

function snapshotOf(validation: readonly ValidationEntry[] = []): Snapshot {
  return {
    audit: {
      layout_version: 1,
      date: '2026-07-30',
      title: 'Codebase audit',
      scope: 'The whole repository',
      body: '',
    },
    name: '2026-07-30',
    findings,
    validation,
    audits: ['2026-07-30'],
  };
}

function rowIds(): string[] {
  return screen
    .getAllByTestId(TEST_IDS.findingRow)
    .map((row) => row.querySelector('.font-mono')?.textContent ?? '');
}

function legend(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
}

/**
 * The card the reader is on, out of the stack the pane mounts around it. Every
 * assertion about what the reader sees or acts on is scoped to this one: the
 * cards either side of it carry the same controls with the same names, and an
 * unscoped query would answer from whichever the queue happened to put first.
 */
function readerCard(): HTMLElement {
  const card = screen
    .getAllByTestId(TEST_IDS.findingCard)
    .find((element) => element.getAttribute('aria-current') === 'true');
  if (card === undefined) throw new Error('no card is marked as the one the reader is on');
  return card;
}

describe('ConsoleShell', () => {
  beforeEach(() => {
    globalThis.history.replaceState({}, '', '/');
    globalThis.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('opens on the open section', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(rowIds()).toEqual(['A-1', 'A-2']);
  });

  it('counts the whole audit as decided work', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(screen.getByText('3 of 6 decided')).toBeInTheDocument();
  });

  it('routes each section to its own findings', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Questions/ }));

    expect(rowIds()).toEqual(['A-3']);
  });

  it('collects the rulings an agent could not carry out in their own queue', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Blocked/ }));

    expect(rowIds()).toEqual(['A-6']);
  });

  it('stops offering a blocked ruling in the review list implementers are handed', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Ruled/ }));

    const rows = screen.getAllByTestId(TEST_IDS.ruledRow);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('A-4');
  });

  it('gives the decided sections their review lists instead of rows', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Denied/ }));

    expect(screen.getByTestId(TEST_IDS.deniedPane)).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.findingRow)).not.toBeInTheDocument();
  });

  it('still reaches the card for a decided finding, where a write reports itself', () => {
    globalThis.history.replaceState({}, '', '/?view=focus');
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Denied/ }));

    expect(readerCard()).toBeInTheDocument();
  });

  it('tracks the ruled findings on a board', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Progress/ }));

    expect(screen.getByTestId(TEST_IDS.progressBoard)).toBeInTheDocument();
    expect(screen.getAllByTestId(TEST_IDS.progressCard).map((card) => card.textContent)).toEqual([
      expect.stringContaining('A-6'),
      expect.stringContaining('A-4'),
    ]);
  });

  it('sums the whole audit on the dashboard', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Dashboard/ }));

    expect(screen.getByTestId(TEST_IDS.dashboardPane)).toBeInTheDocument();
    expect(screen.getByTestId(`${TEST_IDS.dashboardAwaiting}-value`)).toHaveTextContent('3');
  });

  it('counts the stuck work on the dashboard and opens the queue holding it', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Dashboard/ }));
    expect(screen.getByTestId(`${TEST_IDS.dashboardBlocked}-value`)).toHaveTextContent('1');

    fireEvent.click(
      within(screen.getByTestId(TEST_IDS.dashboardBlocked)).getByText('Blocked').closest('button')!
    );

    expect(rowIds()).toEqual(['A-6']);
  });

  it('counts what is still to be decided on the dashboard tab', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Dashboard/ })).toHaveTextContent('3');
  });

  it('narrows the dashboard with the filters', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Dashboard/ }));
    fireEvent.click(screen.getByRole('button', { name: 'critical' }));

    expect(screen.getByTestId(`${TEST_IDS.dashboardAwaiting}-value`)).toHaveTextContent('1');
  });

  it('narrows the queue by a rail filter', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'critical' }));

    expect(rowIds()).toEqual(['A-1']);
  });

  it('composes a rail filter with the search', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'low' }));
    fireEvent.change(screen.getByTestId(TEST_IDS.searchInput), { target: { value: 'A-2' } });

    expect(rowIds()).toEqual(['A-2']);
  });

  it('counts the sections over the filtered set', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'critical' }));

    expect(screen.getByRole('button', { name: /Open/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /Denied/ })).toHaveTextContent('0');
  });

  it('offers every area the audit uses, placeholder included', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(screen.getByRole('option', { name: 'unknown (1)' })).toBeInTheDocument();
  });

  it('counts an area over the section on screen, so the number is what the pane will show', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(screen.queryByRole('option', { name: /apps\/api/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Questions/ }));

    expect(screen.getByRole('option', { name: 'apps/api (1)' })).toBeInTheDocument();
  });

  it('hands the count it promised to the pane', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Questions/ }));
    fireEvent.change(screen.getByTestId(TEST_IDS.areaFilter), { target: { value: 'apps/api' } });

    expect(rowIds()).toEqual(['A-3']);
  });

  it('puts the whole view in the url', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Questions/ }));
    fireEvent.click(screen.getByRole('button', { name: 'low' }));

    expect(globalThis.location.search).toBe('?section=questions&severity=low');
  });

  it('reproduces a shared view from the url', () => {
    globalThis.history.replaceState({}, '', '/?section=questions&severity=low&focus=A-3');

    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(rowIds()).toEqual(['A-3']);
    expect(screen.getByTestId(TEST_IDS.findingRow)).toHaveAttribute('aria-current', 'true');
  });

  it('ignores a value the url should not have carried', () => {
    globalThis.history.replaceState({}, '', '/?section=archive&severity=urgent');

    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(rowIds()).toEqual(['A-1', 'A-2']);
  });

  it('records the focused finding so the link lands on it', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getAllByTestId(TEST_IDS.findingRow)[1]!);

    expect(globalThis.location.search).toBe('?focus=A-2&view=focus');
  });

  it('sends the reader to the top of a section they switch to', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getAllByTestId(TEST_IDS.findingRow)[0]!);
    fireEvent.click(screen.getByRole('button', { name: /Ruled/ }));

    expect(globalThis.location.search).toBe('?section=ruled&view=focus');
  });

  it('keeps a paragraph-length title from breaking the queue', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(screen.getByText(LONG_TITLE).className).toContain('line-clamp-2');
  });

  it('switches to focus mode and puts it in the url with the rest of the view', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));

    expect(within(readerCard()).getByTestId(TEST_IDS.focusedFinding)).toBeInTheDocument();
    expect(globalThis.location.search).toBe('?view=focus');
  });

  it('opens in the view the url names', () => {
    globalThis.history.replaceState({}, '', '/?view=focus');

    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(within(readerCard()).getByTestId(TEST_IDS.focusedFinding)).toBeInTheDocument();
  });

  // The console read this from browser storage before the url carried it, and
  // a reader whose browser still holds that value must see what their url says.
  it('opens on the list whatever an old browser saved', () => {
    globalThis.localStorage.setItem('docket.view-mode', 'focus');

    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(rowIds()).toEqual(['A-1', 'A-2']);
    expect(screen.queryAllByTestId(TEST_IDS.findingCard)).toHaveLength(0);
  });

  it('leaves a Back out of the view the reader switched away from', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);
    const depth = globalThis.history.length;

    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));

    expect(globalThis.history.length).toBe(depth + 1);
  });

  it('tells the reader when a filter, not the audit, emptied the section', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.change(screen.getByTestId(TEST_IDS.searchInput), { target: { value: 'nothing' } });

    expect(screen.getByText('No finding matches these filters')).toBeInTheDocument();
  });

  it('clears every filter at once from the empty section', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.change(screen.getByTestId(TEST_IDS.searchInput), { target: { value: 'nothing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(rowIds()).toEqual(['A-1', 'A-2']);
    expect(globalThis.location.search).toBe('');
  });

  it('clears every filter at once from the rail', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'critical' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    expect(rowIds()).toEqual(['A-1', 'A-2']);
  });

  it('surfaces a finding the format rejected', () => {
    render(
      <ConsoleShell
        onAudit={vi.fn()}
        snapshot={snapshotOf([
          {
            id: 'BAD-1',
            path: '/repo/docs/audits/2026-07-30/findings/BAD-1.md',
            issues: [
              { code: 'malformed-yaml', field: null, message: 'frontmatter is not readable' },
            ],
          },
        ])}
      />
    );

    expect(screen.getByTestId(TEST_IDS.validationBanner)).toBeInTheDocument();
  });

  it('keeps admitting it is one finding short after the banner is dismissed', () => {
    render(
      <ConsoleShell
        onAudit={vi.fn()}
        snapshot={snapshotOf([
          {
            id: 'BAD-1',
            path: '/repo/docs/audits/2026-07-30/findings/BAD-1.md',
            issues: [
              { code: 'malformed-yaml', field: null, message: 'frontmatter is not readable' },
            ],
          },
        ])}
      />
    );

    fireEvent.click(
      within(screen.getByTestId(TEST_IDS.validationBanner)).getByRole('button', { name: 'Dismiss' })
    );

    expect(screen.queryByTestId(TEST_IDS.validationBanner)).not.toBeInTheDocument();
    expect(screen.getByText(/3 of 6 decided/u)).toHaveTextContent('3 of 6 decided, 1 unreadable');
  });

  it('lets a keyboard reader skip the chrome', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
  });

  it('puts the ruling card in focus mode', () => {
    globalThis.history.replaceState({}, '', '/?view=focus');
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(readerCard()).toBeInTheDocument();
  });

  it('puts the ruling controls in reach of a blocked finding', () => {
    globalThis.history.replaceState({}, '', '/?view=focus');
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Blocked/ }));

    expect(within(readerCard()).getByTestId(TEST_IDS.reopenFinding)).toBeInTheDocument();
  });

  it('puts the agent’s account of the hold-up beside those controls', () => {
    globalThis.history.replaceState({}, '', '/?view=focus');
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Blocked/ }));

    expect(within(readerCard()).getByText('The ruling names no owner.')).toBeInTheDocument();
  });

  /**
   * The shell is the one place holding both halves of the address — the audit
   * the reader asked for and the one the server actually served — so it is
   * where every call site below it learns which audit it is writing to.
   */
  it('addresses a write to the audit the server served when the url names none', async () => {
    globalThis.history.replaceState({}, '', '/?view=focus');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { finding: makeFinding({ id: 'A-1', state: 'denied' }), undoToken: 't1' },
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(within(readerCard()).getByRole('button', { name: 'Deny without a reason' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/audits/2026-07-30/finding/A-1/deny',
        expect.anything()
      );
    });
    vi.unstubAllGlobals();
  });

  it('addresses a write to the audit the url names', async () => {
    globalThis.history.replaceState({}, '', '/?view=focus&audit=2026-08-01');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { finding: makeFinding({ id: 'A-1', state: 'denied' }), undoToken: 't1' },
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ConsoleShell
        snapshot={{ ...snapshotOf(), audits: ['2026-07-30', '2026-08-01'] }}
        onAudit={vi.fn()}
      />
    );

    fireEvent.click(within(readerCard()).getByRole('button', { name: 'Deny without a reason' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/audits/2026-08-01/finding/A-1/deny',
        expect.anything()
      );
    });
    vi.unstubAllGlobals();
  });

  it('lands the reader back on the finding a successful undo restored', async () => {
    globalThis.history.replaceState({}, '', '/?view=focus');
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(
          Response.json(
            { finding: makeFinding({ id: 'A-1', state: 'denied' }), undoToken: 't1' },
            { status: 200 }
          )
        )
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          Response.json(
            { finding: makeFinding({ id: 'A-1', state: 'open' }), undoToken: 't2' },
            { status: 200 }
          )
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    // Deny A-1, which advances the card to A-2 and leaves A-1's toast on screen.
    fireEvent.click(within(readerCard()).getByRole('button', { name: 'Deny without a reason' }));
    const banner = await screen.findByText('Denied A-1');
    const toast = banner.closest('[data-sonner-toast]');

    fireEvent.click(within(toast as HTMLElement).getByRole('button', { name: 'Undo' }));

    // The reader must end up looking at the finding they just restored, in the
    // pane it returned to — not the pane it was leaving.
    await screen.findByText('A-1');
    expect(readerCard()).toHaveTextContent('A-1');
    expect(globalThis.location.search).not.toContain('section=denied');
    vi.unstubAllGlobals();
  });

  it('says which finding an undo moved the reader to', async () => {
    globalThis.history.replaceState({}, '', '/?view=focus');
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(
          Response.json(
            { finding: makeFinding({ id: 'A-1', state: 'denied' }), undoToken: 't1' },
            { status: 200 }
          )
        )
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          Response.json(
            { finding: makeFinding({ id: 'A-1', state: 'open' }), undoToken: 't2' },
            { status: 200 }
          )
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    // Denying advances the card past A-1, so the undo is what moves the reader
    // back to it: the move nothing else in the console reports.
    fireEvent.click(within(readerCard()).getByRole('button', { name: 'Deny without a reason' }));
    const banner = await screen.findByText('Denied A-1');
    const toast = banner.closest('[data-sonner-toast]');

    fireEvent.click(within(toast as HTMLElement).getByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Queue position' })).toHaveTextContent(
        'Moved to A-1.'
      );
    });
    vi.unstubAllGlobals();
  });

  it('shows a refused undo on a card that is on screen, not on the one that moved away', async () => {
    globalThis.history.replaceState({}, '', '/?view=focus');
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(
          Response.json(
            { finding: makeFinding({ id: 'A-1', state: 'denied' }), undoToken: 'spent' },
            { status: 200 }
          )
        )
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          Response.json(
            { error: { code: 'not-found', message: 'unknown undo token' } },
            { status: 404 }
          )
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    // Deny A-1, which advances the card to A-2 and leaves A-1's toast on screen.
    fireEvent.click(within(readerCard()).getByRole('button', { name: 'Deny without a reason' }));
    await screen.findByText('Denied A-1');

    // The undo is refused. It targets A-1, which is no longer the card on screen.
    // The toast's own Undo, not the card footer's: that is what carries A-1's token.
    const toast = screen.getByText('Denied A-1').closest('[data-sonner-toast]');
    fireEvent.click(within(toast as HTMLElement).getByRole('button', { name: 'Undo' }));

    await screen.findByText('unknown undo token');
    expect(screen.getByTestId(TEST_IDS.writeError)).toHaveTextContent('unknown undo token');
    vi.unstubAllGlobals();
  });

  it('steps down the queue from the card', () => {
    globalThis.history.replaceState({}, '', '/?view=focus');
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: 'j' });

    expect(globalThis.location.search).toContain('focus=A-2');
  });

  it('opens the finding the reader clicks', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getAllByTestId(TEST_IDS.findingRow)[1]!);

    expect(readerCard()).toHaveTextContent('A-2');
  });

  it('leaves a Back out of the finding the reader opened', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);
    const depth = globalThis.history.length;

    fireEvent.click(screen.getAllByTestId(TEST_IDS.findingRow)[1]!);

    expect(globalThis.history.length).toBe(depth + 1);
  });

  it('takes a Back out of a finding to the queue it was opened from', async () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);
    fireEvent.click(screen.getAllByTestId(TEST_IDS.findingRow)[1]!);
    expect(readerCard()).toHaveTextContent('A-2');

    act(() => {
      globalThis.history.back();
    });

    await waitFor(() => {
      expect(screen.queryAllByTestId(TEST_IDS.findingCard)).toHaveLength(0);
    });
    expect(rowIds()).toEqual(['A-1', 'A-2']);
  });

  it('leaves a Back out of the section the reader left', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);
    const depth = globalThis.history.length;

    fireEvent.click(screen.getByRole('button', { name: /Questions/ }));

    expect(globalThis.history.length).toBe(depth + 1);
  });

  it('keeps stepping the queue out of the history stack', () => {
    globalThis.history.replaceState({}, '', '/?view=focus');
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);
    const depth = globalThis.history.length;

    fireEvent.keyDown(document.body, { key: 'j' });
    fireEvent.keyDown(document.body, { key: 'j' });

    expect(globalThis.history.length).toBe(depth);
  });

  it('drops an area the url asked for that no finding carries, rather than offering it', () => {
    globalThis.history.replaceState({}, '', '/?area=packages/nowhere');

    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(screen.getByLabelText('Area')).toHaveValue('');
    expect(screen.queryByText('packages/nowhere (0)')).not.toBeInTheDocument();
    expect(screen.getByText(/no area "packages\/nowhere"/)).toBeInTheDocument();
  });

  it('names a toggle the url asked for in a spelling it could not read', () => {
    globalThis.history.replaceState({}, '', '/?warning=true');

    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(
      screen.getByText(/The warning filter is on or off, and "true" is neither/)
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Has a warning')).not.toBeChecked();
  });

  it('steps to the next finding without spending a history entry on it', () => {
    globalThis.history.replaceState({}, '', '/?view=focus');
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);
    const depth = globalThis.history.length;

    fireEvent.keyDown(document.body, { key: 'j' });

    expect(readerCard()).toHaveTextContent('A-2');
    expect(globalThis.history.length).toBe(depth);
  });

  it('stops the counts reading as current when the audit server goes away', () => {
    const dropped: (() => void)[] = [];
    class StubEventSource {
      addEventListener(type: string, listener: () => void): void {
        if (type === 'error') dropped.push(listener);
      }
      close(): void {
        // The path under test is the drop, not the teardown.
      }
    }
    vi.stubGlobal('EventSource', StubEventSource);
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    act(() => {
      for (const listener of dropped) listener();
    });

    expect(screen.getByText(/Not live\./)).toHaveAttribute('role', 'status');
  });

  it('does not re-filter the audit for a render that changed neither it nor the filters', () => {
    globalThis.history.replaceState({}, '', '/?severity=critical');
    const base = makeFinding({ id: 'A-9', severity: 'low', state: 'open' });
    let reads = 0;
    const counted = {
      ...base,
      get severity(): Severity {
        reads += 1;
        return base.severity;
      },
    } as FindingJson;
    render(<ConsoleShell snapshot={{ ...snapshotOf(), findings: [counted] }} onAudit={vi.fn()} />);
    const mounted = reads;

    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));

    expect(reads).toBe(mounted);
  });

  // The console opens on the list, so a keyboard that only works once the
  // reader has found the mode toggle is a keyboard nobody reaches.
  describe('the keyboard in list mode', () => {
    it('selects the head of the queue on the first step', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.keyDown(document.body, { key: 'j' });

      expect(globalThis.location.search).toContain('focus=A-1');
    });

    it('walks on down the queue', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.keyDown(document.body, { key: 'j' });
      fireEvent.keyDown(document.body, { key: 'j' });

      expect(globalThis.location.search).toContain('focus=A-2');
    });

    it('walks back up the queue', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.keyDown(document.body, { key: 'j' });
      fireEvent.keyDown(document.body, { key: 'j' });
      fireEvent.keyDown(document.body, { key: 'k' });

      expect(globalThis.location.search).toContain('focus=A-1');
    });

    it('takes the keyboard to the row it stepped to, so Tab goes on from there', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.keyDown(document.body, { key: 'j' });

      const selected = screen
        .getAllByTestId(TEST_IDS.findingRow)
        .find((row) => row.getAttribute('aria-current') === 'true');
      expect(selected).toBeDefined();
      expect(document.activeElement).toBe(selected);
    });

    /**
     * The pane stacks the queue, so a step no longer swaps what is on screen:
     * the card stepped to was already there, above or below the last one. The
     * keyboard goes to it rather than to the pane, or a Tab after a step
     * restarts at the top of a document holding several cards.
     */
    it('takes the keyboard to the card in focus mode, which is what it stepped to', () => {
      globalThis.history.replaceState({}, '', '/?view=focus');
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.keyDown(document.body, { key: 'j' });

      expect(document.activeElement).toBe(readerCard());
    });

    it('steps the blocked queue with the keys every other queue is worked with', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.click(screen.getByRole('button', { name: /Blocked/ }));
      fireEvent.keyDown(document.body, { key: 'j' });

      expect(globalThis.location.search).toContain('focus=A-6');
    });

    it('takes the keyboard to the blocked row it stepped to, as it does elsewhere', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.click(screen.getByRole('button', { name: /Blocked/ }));
      fireEvent.keyDown(document.body, { key: 'j' });

      const selected = screen
        .getAllByTestId(TEST_IDS.findingRow)
        .find((row) => row.getAttribute('aria-current') === 'true');
      expect(selected).toBeDefined();
      expect(document.activeElement).toBe(selected);
    });

    /**
     * The bug this closes: a reader scrolls down to a finding, presses a digit,
     * and rules the one `j` last landed on instead. The keyboard has to follow
     * the reader's eyes, and their eyes are wherever they scrolled to.
     */
    it('aims the keyboard at the finding the reader scrolled to', () => {
      const stub = stubIntersectionObserver();
      globalThis.history.replaceState({}, '', '/?view=focus');
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);
      const next = document.querySelector('[data-finding="A-2"]');
      expect(next).not.toBeNull();

      stub.show(next === null ? [] : [next]);

      expect(readerCard()).toHaveTextContent('A-2');
      stub.restore();
    });

    it('follows the reader’s scrolling into the url, so a reload opens where they were', () => {
      const stub = stubIntersectionObserver();
      globalThis.history.replaceState({}, '', '/?view=focus');
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);
      const next = document.querySelector('[data-finding="A-2"]');

      stub.show(next === null ? [] : [next]);

      expect(globalThis.location.search).toContain('focus=A-2');
      stub.restore();
    });

    /**
     * The whole stack binds these keys on the window. One card answering is the
     * property the stack rests on: the alternative is a keystroke acting on
     * every finding on screen at once.
     */
    it('aims a ruling key at the card the reader is on and no other', () => {
      globalThis.history.replaceState({}, '', '/?view=focus');
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.keyDown(document.body, { key: 'd' });

      expect(within(readerCard()).getByLabelText('Reason for denying')).toHaveFocus();
    });

    it('gives the card the keyboard can be put on somewhere to hold it', () => {
      globalThis.history.replaceState({}, '', '/?view=focus');
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      // Without this the focus above is a no-op outside the test dom: a browser
      // refuses focus to an element that cannot hold it, and the reader's Tab
      // silently restarts at the top of the document.
      expect(readerCard()).toHaveAttribute('tabindex', '-1');
    });

    it('waits with nothing to say, so the region is already there when it speaks', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      expect(screen.getByRole('status', { name: 'Queue position' })).toBeEmptyDOMElement();
    });

    it('says where the step landed', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.keyDown(document.body, { key: 'j' });

      expect(screen.getByRole('status', { name: 'Queue position' })).toHaveTextContent(
        'A-1. 1 of 2.'
      );
    });

    it('says where the step back landed', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.keyDown(document.body, { key: 'j' });
      fireEvent.keyDown(document.body, { key: 'j' });
      fireEvent.keyDown(document.body, { key: 'k' });

      expect(screen.getByRole('status', { name: 'Queue position' })).toHaveTextContent(
        'A-1. 1 of 2.'
      );
    });

    it('opens the palette', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.keyDown(document.body, { key: 'k', metaKey: true });

      expect(screen.getByTestId(TEST_IDS.findingPalette)).toBeInTheDocument();
    });

    it('reaches the search field', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.keyDown(document.body, { key: '/' });

      expect(document.activeElement).toBe(screen.getByTestId(TEST_IDS.searchInput));
    });

    it('opens the shortcut legend', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.keyDown(document.body, { key: '?', shiftKey: true });

      expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    });

    it('opens the shortcut legend from the control that names it, not only from the key', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.click(screen.getByRole('button', { name: /keyboard shortcuts/i }));

      expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    });

    it('names the queue steps in the legend where a queue exists', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.keyDown(document.body, { key: '?', shiftKey: true });

      expect(within(legend()).getByText('Next finding')).toBeInTheDocument();
    });

    it('leaves the queue steps out of the legend on a section that shows none', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /Progress/ }));

      fireEvent.keyDown(document.body, { key: '?', shiftKey: true });

      expect(within(legend()).queryByText('Next finding')).toBeNull();
    });

    it('names the ruling keys of the finding on screen', () => {
      globalThis.history.replaceState({}, '', '/?view=focus&focus=A-1');
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.keyDown(document.body, { key: '?', shiftKey: true });

      expect(within(legend()).getByText('Deny')).toBeInTheDocument();
    });

    it('gives the console back when the legend is dismissed', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);
      fireEvent.keyDown(document.body, { key: '?', shiftKey: true });

      fireEvent.keyDown(legend(), { key: 'Escape' });

      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    });

    it('writes nothing on the way to showing the legend', () => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchMock);
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

      fireEvent.keyDown(document.body, { key: '?', shiftKey: true });

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('stays put at the end of the queue rather than wrapping round', () => {
    globalThis.history.replaceState({}, '', '/?view=focus');
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: 'k' });

    expect(globalThis.location.search).not.toContain('focus=');
  });

  it('has nowhere to step in a section that holds nothing', () => {
    globalThis.history.replaceState({}, '', '/?view=focus');
    render(<ConsoleShell snapshot={{ ...snapshotOf(), findings: [] }} onAudit={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: 'j' });

    expect(globalThis.location.search).not.toContain('focus=');
  });

  describe('the keyboard on a section that shows no queue', () => {
    it('still opens the palette on the dashboard', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /Dashboard/ }));

      fireEvent.keyDown(document.body, { key: 'k', metaKey: true });

      expect(screen.getByTestId(TEST_IDS.findingPalette)).toBeInTheDocument();
    });

    it('still reaches the search field on the progress board', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /Progress/ }));

      fireEvent.keyDown(document.body, { key: '/' });

      expect(document.activeElement).toBe(screen.getByTestId(TEST_IDS.searchInput));
    });

    it('does not pretend a queue step means anything on the dashboard', () => {
      render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /Dashboard/ }));

      fireEvent.keyDown(document.body, { key: 'j' });

      expect(globalThis.location.search).not.toContain('focus=');
    });
  });

  it('jumps to the finding chosen from the palette, from the list', () => {
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    fireEvent.click(screen.getAllByTestId(TEST_IDS.paletteOption)[1]!);

    expect(globalThis.location.search).toContain('focus=A-2');
    expect(screen.queryByTestId(TEST_IDS.findingPalette)).toBeNull();
  });

  it('follows a chip out of the section the reader is in', () => {
    globalThis.history.replaceState({}, '', '/?view=focus');
    render(
      <ConsoleShell
        onAudit={vi.fn()}
        snapshot={{
          ...snapshotOf(),
          findings: [makeFinding({ id: 'A-1', state: 'open', related: ['A-5'] }), findings[4]!],
        }}
      />
    );

    fireEvent.click(screen.getByTestId(TEST_IDS.findingChip));

    expect(globalThis.location.search).toContain('section=denied');
    expect(globalThis.location.search).toContain('focus=A-5');
  });
  it('patches a card an agent wrote to, keeping the half-typed denial on screen', async () => {
    globalThis.history.replaceState({}, '', '/?view=focus');
    const arrivals: ((event: { data: string }) => void)[] = [];
    vi.stubGlobal(
      'EventSource',
      class {
        addEventListener(_type: string, listener: (event: { data: string }) => void): void {
          arrivals.push(listener);
        }
        close(): void {
          // Nothing to close in the stub.
        }
      }
    );
    const rewritten = makeFinding({ ...findings[0]!, title: 'rewritten by the agent' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            { ...snapshotOf(), findings: [rewritten, ...findings.slice(1)] },
            { status: 200 }
          )
        )
      )
    );
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);
    fireEvent.change(within(readerCard()).getByLabelText('Reason for denying'), {
      target: { value: 'not a defect after all' },
    });

    for (const arrival of arrivals) {
      arrival({ data: JSON.stringify({ type: 'finding', id: 'A-1' }) });
    }

    await waitFor(() => {
      expect(readerCard()).toHaveTextContent('rewritten by the agent');
    });
    expect(within(readerCard()).getByLabelText('Reason for denying')).toHaveValue(
      'not a defect after all'
    );
    vi.unstubAllGlobals();
  });
});

/**
 * `?focus=<id>` on its own is the shape a reader pastes to a colleague. It has
 * to land on the finding it names or say it cannot, never on a different one.
 */
describe('ConsoleShell arriving on a link', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
    globalThis.history.replaceState({}, '', '/?view=focus');
  });

  it('shows the finding a bare link names even when it lives in another section', () => {
    globalThis.history.replaceState({}, '', '/?view=focus&focus=A-3');

    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(readerCard()).toHaveTextContent('A-3');
  });

  it('takes the reader to the section that holds it, so the url and the card agree', () => {
    globalThis.history.replaceState({}, '', '/?view=focus&focus=A-3');

    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(globalThis.location.search).toContain('section=questions');
    expect(globalThis.location.search).toContain('focus=A-3');
  });

  it('does the same for a finding that has already been ruled', () => {
    globalThis.history.replaceState({}, '', '/?view=focus&focus=A-4');

    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(globalThis.location.search).toContain('section=ruled');
    expect(readerCard()).toHaveTextContent('A-4');
  });

  it('does the same for a finding that has been denied', () => {
    globalThis.history.replaceState({}, '', '/?view=focus&focus=A-5');

    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(globalThis.location.search).toContain('section=denied');
    expect(readerCard()).toHaveTextContent('A-5');
  });

  it('stops claiming a finding the audit does not hold', () => {
    globalThis.history.replaceState({}, '', '/?view=focus&focus=NOPE-9');

    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(globalThis.location.search).not.toContain('focus=');
  });

  it('leaves a link that already names the right section alone', () => {
    globalThis.history.replaceState({}, '', '/?view=focus&section=questions&focus=A-3');

    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(globalThis.location.search).toContain('section=questions');
    expect(readerCard()).toHaveTextContent('A-3');
  });

  it('leaves a finding the reader is already looking at alone', () => {
    globalThis.history.replaceState({}, '', '/?view=focus&focus=A-2');

    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(globalThis.location.search).not.toContain('section=');
    expect(readerCard()).toHaveTextContent('A-2');
  });

  it('keeps a selection the reader filtered out of sight, so clearing the filter finds it again', () => {
    globalThis.history.replaceState({}, '', '/?view=focus&severity=critical&focus=A-2');

    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(globalThis.location.search).toContain('focus=A-2');
    expect(globalThis.location.search).not.toContain('section=');
  });

  it('says so when a link names a finding this audit does not have', () => {
    globalThis.history.replaceState({}, '', '/?view=focus&focus=ZZ-999');

    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(screen.getByText(/ZZ-999/)).toBeInTheDocument();
  });

  it('lets the reader put the unfound-link notice away', () => {
    globalThis.history.replaceState({}, '', '/?view=focus&focus=ZZ-999');
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByText(/ZZ-999/)).not.toBeInTheDocument();
  });

  it('says nothing when the link names a finding that is there', () => {
    globalThis.history.replaceState({}, '', '/?view=focus&focus=A-3');

    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('does not move the reader when a write changes the state of the finding they are on', async () => {
    const only = makeFinding({ id: 'A-9', state: 'open' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            { finding: makeFinding({ id: 'A-9', state: 'denied' }), undoToken: 't1' },
            { status: 200 }
          )
        )
      )
    );
    render(<ConsoleShell snapshot={{ ...snapshotOf(), findings: [only] }} onAudit={vi.fn()} />);

    fireEvent.click(within(readerCard()).getByRole('button', { name: 'Deny without a reason' }));
    await screen.findByText('Denied A-9');

    // Nothing to advance to, so the reader stays put. Resolving the section
    // from the finding on every render would teleport them into Denied.
    expect(globalThis.location.search).not.toContain('section=denied');
    vi.unstubAllGlobals();
  });
});

/**
 * Every write of a bulk ruling lands in the audit it was started against, so
 * the hold is not about correctness: switching mid-plan takes away the summary
 * of what the plan ruled, which is the only place that count is reported. An
 * ordinary ruling is the opposite case — it resolves too fast for a hold to be
 * anything but a flicker — so the hold reads the plan, never a write in flight.
 */
describe('ConsoleShell while a bulk ruling runs', () => {
  beforeEach(() => {
    globalThis.history.replaceState({}, '', '/');
    globalThis.localStorage.clear();
    vi.unstubAllGlobals();
  });

  /** A write left outstanding, so what the console does before it lands is assertable. */
  function heldWrite(): { readonly fetch: typeof fetch; readonly land: () => Promise<void> } {
    const waiting: (() => void)[] = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          waiting.push(() => {
            resolve(
              Response.json(
                { finding: makeFinding({ id: 'A-3', state: 'denied' }), undoToken: 't1' },
                { status: 200 }
              )
            );
          });
        })
    );
    return {
      fetch: fetchMock as unknown as typeof fetch,
      land: async () => {
        await act(async () => {
          for (const resolve of waiting.splice(0)) resolve();
          await Promise.resolve();
        });
      },
    };
  }

  function switcher(): HTMLElement {
    return screen.getByTestId(TEST_IDS.auditSwitcher);
  }

  function denyEveryQuestionedFinding(): void {
    fireEvent.click(screen.getByRole('button', { name: /Questions/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Deny all 1' }));
    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));
  }

  it('holds the audit switch', async () => {
    const write = heldWrite();
    vi.stubGlobal('fetch', write.fetch);
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    denyEveryQuestionedFinding();

    await waitFor(() => {
      expect(switcher()).toBeDisabled();
    });
    await write.land();
    vi.unstubAllGlobals();
  });

  it('gives the audit switch back once the plan finishes', async () => {
    const write = heldWrite();
    vi.stubGlobal('fetch', write.fetch);
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);
    denyEveryQuestionedFinding();
    await waitFor(() => {
      expect(switcher()).toBeDisabled();
    });

    await write.land();

    await waitFor(() => {
      expect(switcher()).toBeEnabled();
    });
    vi.unstubAllGlobals();
  });

  it('leaves the audit switch alone while an ordinary ruling is in flight', async () => {
    globalThis.history.replaceState({}, '', '/?view=focus');
    const write = heldWrite();
    vi.stubGlobal('fetch', write.fetch);
    render(<ConsoleShell snapshot={snapshotOf()} onAudit={vi.fn()} />);

    fireEvent.click(within(readerCard()).getByRole('button', { name: 'Deny without a reason' }));

    await waitFor(() => {
      expect(write.fetch).toHaveBeenCalled();
    });
    expect(switcher()).toBeEnabled();
    await write.land();
    vi.unstubAllGlobals();
  });
});
