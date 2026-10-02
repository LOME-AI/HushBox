import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { HOUR_MS, MINUTE_MS, TEST_DAY_START, isoAt, testUuidV7 } from '@hushbox/shared/test-time';
import { opCatalog } from '@/test-utils/op-catalog';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { AuditRowDrawer } from './audit-row-drawer.js';
import type { AdminAuditRowWire } from '@hushbox/shared';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = opCatalog('user.lock', 'user.unlock');

const USER_ID = testUuidV7(2);

const ROW: AdminAuditRowWire = {
  id: testUuidV7(1),
  actor: 'founder@hushbox.test',
  role: 'operator',
  action: 'user.lock',
  targetType: 'user',
  targetId: USER_ID,
  details: {
    input: { userId: USER_ID, lockReason: 'chargeback', reason: 'dispute received' },
    effects: [
      {
        label: 'user.lockedAt',
        before: null,
        after: isoAt(TEST_DAY_START + 9 * HOUR_MS + 30 * MINUTE_MS),
      },
    ],
    inverseInput: { userId: USER_ID, reason: 'undo lock' },
  },
  undoes: null,
  undoneBy: null,
  createdAt: isoAt(TEST_DAY_START + 9 * HOUR_MS + 30 * MINUTE_MS),
};

function stubCatalogFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(CATALOG)))
  );
}

interface Handlers {
  onClose?: () => void;
  onJump?: (auditId: string) => void;
}

function renderDrawer(row: AdminAuditRowWire, handlers: Handlers = {}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <AuditRowDrawer
          row={row}
          onClose={handlers.onClose ?? vi.fn()}
          onJump={handlers.onJump ?? vi.fn()}
        />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

describe('AuditRowDrawer', () => {
  it('renders actor, target, reason and the changed-fields diff', () => {
    stubCatalogFetch();
    renderDrawer(ROW);
    expect(screen.getByText('founder@hushbox.test')).toBeInTheDocument();
    expect(screen.getByText(USER_ID)).toBeInTheDocument();
    expect(screen.getByText('dispute received')).toBeInTheDocument();
    const diff = screen.getByTestId(TEST_IDS.adminOpDiff);
    expect(within(diff).getByText('user.lockedAt')).toBeInTheDocument();
  });

  it('heads the details with the action as a neutral badge', () => {
    stubCatalogFetch();
    renderDrawer(ROW);
    expect(screen.getByText('user.lock').closest('[data-slot="badge"]')).toHaveClass(
      'bg-muted',
      'text-muted-foreground'
    );
  });

  it('keeps the action in monospace', () => {
    stubCatalogFetch();
    renderDrawer(ROW);
    expect(screen.getByText('user.lock')).toHaveClass('font-mono');
  });

  it('labels the acting role as a fact of its own', () => {
    stubCatalogFetch();
    renderDrawer(ROW);
    const role = screen.getByText('Role').closest('div');
    expect(role).toHaveTextContent('operator');
  });

  it('shows the role the inspected row carries, not a fixed one', () => {
    stubCatalogFetch();
    renderDrawer({ ...ROW, role: 'growth-viewer' });
    expect(screen.getByText('Role').closest('div')).toHaveTextContent('growth-viewer');
  });

  it('falls back gracefully for a row without structured effects', () => {
    stubCatalogFetch();
    renderDrawer({ ...ROW, action: 'read.sqlPanel', details: { query: 'SELECT 1' } });
    expect(screen.getByText(/no structured effects/i)).toBeInTheDocument();
  });

  it('reveals the raw JSON behind a toggle', async () => {
    stubCatalogFetch();
    renderDrawer(ROW);
    expect(screen.queryByText(/"inverseInput"/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId(TEST_IDS.adminAuditDrawerRaw));
    expect(screen.getByText(/"inverseInput"/)).toBeInTheDocument();
  });

  it('makes the raw JSON its own named scroll region', async () => {
    stubCatalogFetch();
    renderDrawer(ROW);
    await userEvent.click(screen.getByTestId(TEST_IDS.adminAuditDrawerRaw));
    expect(screen.getByRole('group', { name: 'Raw JSON' })).toBe(
      screen.getByText(/"inverseInput"/).closest('pre')
    );
  });

  it('offers Undo on a reversible row through the OpModal', async () => {
    stubCatalogFetch();
    renderDrawer(ROW);
    await userEvent.click(await screen.findByTestId(TEST_IDS.adminAuditUndo));
    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByText('Unlock account')).toBeInTheDocument();
  });

  it('threads the undo pair: jump buttons for undoes and undoneBy', async () => {
    stubCatalogFetch();
    const onJump = vi.fn();
    const undoneBy = testUuidV7(0xbb_bb);
    renderDrawer({ ...ROW, undoneBy }, { onJump });
    await userEvent.click(screen.getByRole('button', { name: /undone by/i }));
    expect(onJump).toHaveBeenCalledWith(undoneBy);
  });

  it('closes from the close button', async () => {
    stubCatalogFetch();
    const onClose = vi.fn();
    renderDrawer(ROW, { onClose });
    await userEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('AuditRowDrawer edge shapes', () => {
  it('falls back when the effects array itself is malformed', () => {
    stubCatalogFetch();
    renderDrawer({
      ...ROW,
      details: { input: {}, effects: [42], inverseInput: null },
    });
    expect(screen.getByText(/no structured effects/i)).toBeInTheDocument();
  });

  it('renders a target-less row and a reason-less row honestly', () => {
    stubCatalogFetch();
    renderDrawer({
      ...ROW,
      targetType: null,
      targetId: null,
      details: { input: {}, effects: [], inverseInput: null },
    });
    expect(screen.getByText('none')).toBeInTheDocument();
    expect(screen.getByText('none recorded')).toBeInTheDocument();
  });

  it('jumps to the undone target from the Undoes link', async () => {
    stubCatalogFetch();
    const onJump = vi.fn();
    const undoes = testUuidV7(0xaa_aa);
    renderDrawer({ ...ROW, undoes }, { onJump });
    await userEvent.click(screen.getByRole('button', { name: /^undoes/i }));
    expect(onJump).toHaveBeenCalledWith(undoes);
  });
});
