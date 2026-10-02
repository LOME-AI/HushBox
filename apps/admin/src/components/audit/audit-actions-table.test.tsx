import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { HOUR_MS, MINUTE_MS, TEST_DAY_START, isoAt, testUuidV7 } from '@hushbox/shared/test-time';
import { opCatalog } from '@/test-utils/op-catalog';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { formatTime } from '@/lib/format-time';
import { AuditActionsTable, auditReasonOf } from './audit-actions-table.js';
import type { AdminAuditRowWire } from '@hushbox/shared';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = {
  ops: [
    ...opCatalog('user.lock', 'user.unlock', 'banner.set').ops,
    {
      // Deliberately not a registered op name: what this entry stands for is
      // `inverse: null`, which is what the Undo affordance reads.
      name: 'fixture.noInverse',
      title: 'Fixture op with no inverse',
      kind: 'mutation',
      effectClass: 'ephemeral',
      inverse: null,
      fields: ['userId', 'reason'],
    },
  ],
  role: 'operator' as const,
};

const USER_ID = testUuidV7(2);
const CREATED_AT = isoAt(TEST_DAY_START + 9 * HOUR_MS + 30 * MINUTE_MS);

const LOCK_ROW: AdminAuditRowWire = {
  id: testUuidV7(1),
  actor: 'founder@hushbox.test',
  role: 'operator',
  action: 'user.lock',
  targetType: 'user',
  targetId: USER_ID,
  details: {
    input: { userId: USER_ID, lockReason: 'chargeback', reason: 'dispute received' },
    effects: [{ label: 'user.lockedAt' }],
    inverseInput: { userId: USER_ID, reason: 'undo lock' },
  },
  undoes: null,
  undoneBy: null,
  createdAt: CREATED_AT,
};

function renderTable(rows: readonly AdminAuditRowWire[]): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <AuditActionsTable rows={rows} />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

function stubCatalogFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(CATALOG)))
  );
}

describe('AuditActionsTable', () => {
  it('names the actions scroll region, so a keyboard reader can reach and scroll it', () => {
    stubCatalogFetch();
    renderTable([LOCK_ROW]);
    expect(screen.getByRole('group', { name: 'Admin actions' })).toContainElement(
      screen.getByRole('table')
    );
  });

  it('keeps the actions scroll region square, so rounding does not clip or repaint the rows it scrolls', () => {
    stubCatalogFetch();
    renderTable([LOCK_ROW]);
    expect(screen.getByRole('group', { name: 'Admin actions' }).className).not.toMatch(
      /(^|\s)rounded(-|\s|$)/
    );
  });

  it('renders time, actor, action, target, and reason for each row', () => {
    stubCatalogFetch();
    renderTable([LOCK_ROW]);

    const row = screen.getByText('user.lock').closest('tr');
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent(formatTime(CREATED_AT));
    expect(row).toHaveTextContent('founder@hushbox.test');
    expect(row).toHaveTextContent(`user:${USER_ID}`);
    expect(row).toHaveTextContent('dispute received');
  });

  it('shows each row the role its own actor acted as', () => {
    stubCatalogFetch();
    // Two rows differing in role: with one row, a hardcoded label passes.
    renderTable([
      LOCK_ROW,
      {
        ...LOCK_ROW,
        id: testUuidV7(7),
        actor: 'analyst@hushbox.test',
        role: 'growth-viewer',
        action: 'read.growth',
      },
    ]);

    const lockRow = screen.getByText('user.lock').closest('tr');
    const readRow = screen.getByText('read.growth').closest('tr');
    expect(lockRow).toHaveTextContent('operator');
    expect(readRow).toHaveTextContent('growth-viewer');
    expect(lockRow).not.toHaveTextContent('growth-viewer');
  });

  it('names the role for a screen reader rather than leaving a bare token', () => {
    stubCatalogFetch();
    renderTable([LOCK_ROW]);

    expect(screen.getByText('acting as')).toHaveClass('sr-only');
  });

  it('keeps the target id on one line with a full-value title, like the jobs table', () => {
    stubCatalogFetch();
    renderTable([LOCK_ROW]);

    const cell = screen.getByText(`user:${USER_ID}`).closest('td');
    expect(cell).not.toBeNull();
    expect(cell?.className).toContain('whitespace-nowrap');
    expect(cell).toHaveAttribute('title', `user:${USER_ID}`);
  });

  it('shows an empty state without rows', () => {
    stubCatalogFetch();
    renderTable([]);

    expect(screen.getByText(/no admin actions/i)).toBeInTheDocument();
  });

  it('offers Undo on a reversible executed row and opens the inverse op prefilled', async () => {
    const user = userEvent.setup();
    stubCatalogFetch();
    renderTable([LOCK_ROW]);

    const undo = await screen.findByTestId(TEST_IDS.adminAuditUndo);
    await user.click(undo);

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(modal).toHaveTextContent('Unlock account');
    expect(within(modal).getByLabelText('userId')).toHaveValue(USER_ID);
    // The operator types every undo reason. Rows recorded before that rule
    // still carry a machine-authored one, so the strip is unconditional.
    expect(within(modal).getByLabelText('reason')).toHaveValue('');
  });

  it('prefills group rows and booleans when undoing an op whose inverse input carries them', async () => {
    const user = userEvent.setup();
    stubCatalogFetch();
    renderTable([
      {
        ...LOCK_ROW,
        action: 'banner.set',
        details: {
          input: { enabled: false, messages: [], reason: 'clear banner' },
          effects: [{ label: 'banner' }],
          inverseInput: {
            enabled: true,
            messages: [{ variant: 'info', text: 'Restored message' }],
            reason: 'restore prior banner',
          },
        },
      },
    ]);

    await user.click(await screen.findByTestId(TEST_IDS.adminAuditUndo));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByRole('switch', { name: 'enabled' })).toHaveAttribute(
      'data-state',
      'checked'
    );
    const row = within(modal).getByTestId(TEST_ID_BUILDERS.adminOpGroupRow('messages', 0));
    expect(within(row).getByLabelText('text')).toHaveValue('Restored message');
  });

  it('offers no Undo when the op has no registered inverse', async () => {
    stubCatalogFetch();
    renderTable([
      {
        ...LOCK_ROW,
        action: 'fixture.noInverse',
        details: { input: { userId: USER_ID, reason: 'r' }, effects: [], inverseInput: null },
      },
    ]);

    await screen.findByText('fixture.noInverse');
    expect(screen.queryByTestId(TEST_IDS.adminAuditUndo)).not.toBeInTheDocument();
  });

  it('offers no Undo on a read-audit row (details are not an executed effect)', async () => {
    stubCatalogFetch();
    renderTable([{ ...LOCK_ROW, action: 'read.customer360', details: { query: {} } }]);

    await screen.findByText('read.customer360');
    expect(screen.queryByTestId(TEST_IDS.adminAuditUndo)).not.toBeInTheDocument();
  });

  it('renders an empty target cell and reason for a row with no target or details', () => {
    stubCatalogFetch();
    renderTable([{ ...LOCK_ROW, targetType: null, targetId: null, details: null }]);

    const row = screen.getByText('user.lock').closest('tr');
    expect(row).not.toHaveTextContent('user:');
  });

  it('renders the bare target type and no reason when targetId and reason are absent', () => {
    stubCatalogFetch();
    renderTable([{ ...LOCK_ROW, targetId: null, details: { input: { reason: 42 }, effects: [] } }]);

    const row = screen.getByText('user.lock').closest('tr');
    expect(row).toHaveTextContent('user:');
    expect(row).not.toHaveTextContent('dispute received');
  });

  it('offers no Undo when the executed row recorded no inverse input', async () => {
    stubCatalogFetch();
    renderTable([{ ...LOCK_ROW, details: { input: {}, effects: [], inverseInput: null } }]);

    await screen.findByText('user.lock');
    expect(screen.queryByTestId(TEST_IDS.adminAuditUndo)).not.toBeInTheDocument();
  });

  it('marks an already-undone row instead of offering Undo again', async () => {
    stubCatalogFetch();
    renderTable([{ ...LOCK_ROW, undoneBy: testUuidV7(0x0f) }]);

    await screen.findByText('user.lock');
    expect(screen.queryByTestId(TEST_IDS.adminAuditUndo)).not.toBeInTheDocument();
    expect(screen.getByText(/undone/i)).toBeInTheDocument();
  });
});

describe('AuditActionsTable inspection (audit trail screen)', () => {
  function renderInspectable(
    rows: readonly AdminAuditRowWire[],
    onInspect: (row: AdminAuditRowWire) => void,
    inspectedId?: string
  ): void {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OpModalProvider>
          <AuditActionsTable rows={rows} onInspect={onInspect} inspectedId={inspectedId} />
        </OpModalProvider>
      </QueryClientProvider>
    );
  }

  it('offers a Details affordance per row when inspection is wired', async () => {
    stubCatalogFetch();
    const onInspect = vi.fn();
    renderInspectable([LOCK_ROW], onInspect);

    await userEvent.setup().click(screen.getByTestId(TEST_IDS.adminAuditInspect));
    expect(onInspect).toHaveBeenCalledWith(LOCK_ROW);
  });

  it('offers no Details affordance in the plain feed', () => {
    stubCatalogFetch();
    renderTable([LOCK_ROW]);
    expect(screen.queryByTestId(TEST_IDS.adminAuditInspect)).not.toBeInTheDocument();
  });

  it('marks the inspected row as the current one', () => {
    stubCatalogFetch();
    renderInspectable([LOCK_ROW], vi.fn(), LOCK_ROW.id);
    expect(screen.getByText('user.lock').closest('tr')).toHaveAttribute('aria-current', 'true');
  });

  it('marks no row current when none is inspected', () => {
    stubCatalogFetch();
    renderInspectable([LOCK_ROW], vi.fn());
    expect(screen.getByText('user.lock').closest('tr')).not.toHaveAttribute('aria-current');
  });

  it('marks only the inspected row when another row is present', () => {
    stubCatalogFetch();
    const other = { ...LOCK_ROW, id: testUuidV7(3), action: 'user.unlock' };
    renderInspectable([LOCK_ROW, other], vi.fn(), LOCK_ROW.id);
    expect(screen.getAllByRole('row', { current: true })).toHaveLength(1);
    expect(screen.getByText('user.unlock').closest('tr')).not.toHaveAttribute('aria-current');
  });

  it('badges an undo execution row so the pair reads from the table', () => {
    stubCatalogFetch();
    renderTable([{ ...LOCK_ROW, undoes: testUuidV7(0xaa_aa) }]);
    expect(screen.getByText('undo')).toBeInTheDocument();
  });

  it('draws the undo badge in the secondary tone, with no outline', () => {
    stubCatalogFetch();
    renderTable([{ ...LOCK_ROW, undoes: testUuidV7(0xaa_aa) }]);
    const badge = screen.getByText('undo');
    expect(badge).toHaveClass('bg-secondary', 'text-secondary-foreground');
    expect(badge).not.toHaveClass('border');
  });

  it('names the undone row on the undo badge', () => {
    stubCatalogFetch();
    const undone = testUuidV7(0xaa_aa);
    renderTable([{ ...LOCK_ROW, undoes: undone }]);
    expect(screen.getByText('undo')).toHaveAttribute('title', `Undoes audit row ${undone}`);
  });

  it("draws a row's action as a neutral badge", () => {
    stubCatalogFetch();
    renderTable([LOCK_ROW]);
    expect(screen.getByText('user.lock').closest('[data-slot="badge"]')).toHaveClass(
      'bg-muted',
      'text-muted-foreground'
    );
  });

  it("keeps a row's action in monospace", () => {
    stubCatalogFetch();
    renderTable([LOCK_ROW]);
    expect(screen.getByText('user.lock')).toHaveClass('font-mono');
  });
});

describe('auditReasonOf', () => {
  it('extracts the executed input reason', () => {
    expect(auditReasonOf(LOCK_ROW.details)).toBe('dispute received');
  });
  it('returns null for a non-executed details shape', () => {
    expect(auditReasonOf({ query: {} })).toBeNull();
  });
});
