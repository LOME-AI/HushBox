import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { opCatalogEntry } from '@/test-utils/op-catalog';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { Route } from './ops.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CREDIT = opCatalogEntry('wallet.credit');

const CATALOG = {
  ops: [
    // `rateLimitKey` is added on top of the derived entry rather than written
    // into one: it stands for any field a stale server sends, and the
    // assertion below is that the shared schema strips it rather than the
    // table rendering it. Everything else stays projected from the contract.
    { ...CREDIT, guardrails: { ...CREDIT.guardrails, rateLimitKey: 'wallet-credit' } },
    {
      // Deliberately not a registered op name: this row stands for any op that
      // declares a class and no inverse, so a change to the real inventory's
      // classes cannot falsify it.
      name: 'fixture.ephemeral',
      title: 'Fixture ephemeral op',
      kind: 'mutation',
      effectClass: 'ephemeral',
      inverse: null,
      fields: ['userId', 'reason'],
    },
  ],
  role: 'operator' as const,
};

function renderScreen(): void {
  const Component = (Route as { options?: { component?: React.ComponentType } }).options?.component;
  if (Component === undefined) {
    throw new Error('ops route has no component');
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <Component />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

describe('Ops catalog screen', () => {
  it('names the catalog scroll region, so a keyboard reader can reach and scroll it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(CATALOG)))
    );
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminOpsTable);
    expect(screen.getByRole('group', { name: 'Ops catalog' })).toContainElement(table);
  });

  it('keeps the catalog scroll region square, so rounding does not clip or repaint the rows it scrolls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(CATALOG)))
    );
    renderScreen();

    await screen.findByTestId(TEST_IDS.adminOpsTable);
    expect(screen.getByRole('group', { name: 'Ops catalog' }).className).not.toMatch(
      /(^|\s)rounded(-|\s|$)/
    );
  });

  it('renders the contract facts of each served catalog entry, including the money cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(CATALOG)))
    );
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminOpsTable);
    const credit = within(table).getByText('wallet.credit').closest('tr');
    expect(credit).not.toBeNull();
    expect(credit).toHaveTextContent('Credit wallet');
    expect(credit).toHaveTextContent('mutation');
    expect(credit).toHaveTextContent('durable');
    expect(credit).toHaveTextContent('wallet.clawback');
    // Load-bearing past this file: this literal is what pins the wallet cap's
    // MAGNITUDE. Driven at two values — `ADMIN_WALLET_ADJUSTMENT_CAP_NANO_USD` doubled,
    // and collapsed to five nano-USD — this case is the only red in the whole
    // `@hushbox/admin` suite, and the whole `@hushbox/shared` suite stays green under
    // both. Softened to a derived or shape-only expectation, the magnitude would be
    // pinned nowhere in either package.
    expect(credit).toHaveTextContent('maxAmount $1,000.00');
    // The money cap is the only guardrail the wire carries; anything else a
    // stale server sends is stripped by the shared schema before it renders.
    expect(credit).not.toHaveTextContent('rateLimitKey');

    const classOnly = within(table).getByText('fixture.ephemeral').closest('tr');
    expect(classOnly).toHaveTextContent('ephemeral');
    expect(classOnly).toHaveTextContent('none');
  });

  it("draws an op's kind as a neutral badge", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(CATALOG)))
    );
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminOpsTable);
    const row = within(table).getByText('fixture.ephemeral').closest('tr') as HTMLElement;
    expect(within(row).getByText('mutation')).toHaveClass('bg-muted', 'text-muted-foreground');
  });

  it("draws an op's effect class in the secondary tone, with no outline", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(CATALOG)))
    );
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminOpsTable);
    const row = within(table).getByText('fixture.ephemeral').closest('tr') as HTMLElement;
    const effectClass = within(row).getByText('ephemeral');
    expect(effectClass).toHaveClass('bg-secondary', 'text-secondary-foreground');
    expect(effectClass).not.toHaveClass('border');
  });

  it('opens the OpModal from a row Run action', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(CATALOG)))
    );
    renderScreen();

    const table = await screen.findByTestId(TEST_IDS.adminOpsTable);
    const row = within(table).getByText('wallet.credit').closest('tr');
    await user.click(within(row as HTMLElement).getByTestId(TEST_IDS.adminOpsRun));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpModal)).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'Credit wallet' })).toBeInTheDocument();
  });

  it('shows a loading state then an error state on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ code: 'UNAVAILABLE' }, { status: 503 })))
    );
    renderScreen();

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Failed to load the op catalog.')).toBeInTheDocument();
    });
  });
});
