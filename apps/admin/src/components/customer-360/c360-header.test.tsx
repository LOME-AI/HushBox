import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { DAY_MS, TEST_DAY_START, isoAt, testUuidV7 } from '@hushbox/shared/test-time';
import { opCatalog } from '@/test-utils/op-catalog';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { C360Header } from './c360-header.js';
import type { Customer360View } from '@hushbox/shared';

afterEach(() => {
  vi.unstubAllGlobals();
});

// `c360-header.tsx` runs these ops BY NAME, so the fixture cannot use
// synthetic names — and a hand-written entry for a real op restates its
// class and inverse with nothing comparing them to the contract. Derived
// instead, so the inventory is what the tests below run against.
const CATALOG = opCatalog('wallet.credit', 'user.lock', 'user.unlock', 'sessions.revokeAll');

const USER_ID = testUuidV7(2);

const CREATED_AT = isoAt(TEST_DAY_START);

const LOCKED_AT = isoAt(TEST_DAY_START + 9 * DAY_MS);

const WALLET_ID = testUuidV7(4);

const USER: Customer360View['user'] = {
  id: USER_ID,
  email: 'locked@example.com',
  username: 'locked-user',
  emailVerified: true,
  totpEnabled: true,
  createdAt: CREATED_AT,
  lockedAt: LOCKED_AT,
  lockReason: 'chargeback',
  hasAcknowledgedPhrase: true,
};

const MONEY: Customer360View['panels']['money'] = {
  ok: true,
  data: {
    balance: {
      purchasedNanoUsd: '-2500000000',
      freeNanoUsd: '0',
      allowance: {
        day: '2026-07-15',
        limitNanoUsd: '100000000',
        spentNanoUsd: '0',
        remainingNanoUsd: '100000000',
      },
    },
    wallets: [
      { id: WALLET_ID, type: 'purchased', balanceNanoUsd: '-2500000000' },
      { id: testUuidV7(5), type: 'free', balanceNanoUsd: '0' },
    ],
    recentLedger: [],
  },
};

function renderHeader(
  user: Customer360View['user'] = USER,
  money: Customer360View['panels']['money'] = MONEY
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(CATALOG)))
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <C360Header user={user} money={money} />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

describe('C360Header', () => {
  it('shows the email, copyable user id, and username', () => {
    renderHeader();

    const header = screen.getByTestId(TEST_IDS.adminC360Header);
    expect(header).toHaveTextContent('locked@example.com');
    expect(header).toHaveTextContent(USER_ID);
    expect(header).toHaveTextContent('locked-user');
    expect(within(header).getByRole('button', { name: 'Copy user id' })).toBeInTheDocument();
  });

  it('shows the lock chip with the lock date, its reason, and the negative balance', () => {
    renderHeader();

    const header = screen.getByTestId(TEST_IDS.adminC360Header);
    expect(header).toHaveTextContent(`Locked since ${LOCKED_AT.slice(0, 10)}`);
    expect(header).toHaveTextContent('chargeback');
    expect(header).toHaveTextContent('-$2.50');
  });

  it('omits the lock reason from the chip when the server recorded none', () => {
    renderHeader({ ...USER, lockReason: null });

    const header = screen.getByTestId(TEST_IDS.adminC360Header);
    expect(header).toHaveTextContent(`Locked since ${LOCKED_AT.slice(0, 10)}`);
    expect(header).not.toHaveTextContent('chargeback');
  });

  it('shows the account created date', () => {
    renderHeader();

    expect(screen.getByTestId(TEST_IDS.adminC360Header)).toHaveTextContent(
      `Created ${CREATED_AT.slice(0, 10)}`
    );
  });

  it('shows Active for an unlocked user and an unverified-email chip', () => {
    renderHeader({ ...USER, lockedAt: null, emailVerified: false });

    const header = screen.getByTestId(TEST_IDS.adminC360Header);
    expect(header).toHaveTextContent('Active');
    expect(header).toHaveTextContent('Email unverified');
  });

  it('draws the lock chip in the error tone', () => {
    renderHeader();

    expect(screen.getByText(/^Locked since/)).toHaveClass('bg-error/12', 'text-error-text');
  });

  it('draws the Active chip in the secondary tone, with no outline', () => {
    renderHeader({ ...USER, lockedAt: null });

    const chip = screen.getByText('Active');
    expect(chip).toHaveClass('bg-secondary', 'text-secondary-foreground');
    expect(chip).not.toHaveClass('border');
  });

  it('draws the unverified-email chip as a neutral badge', () => {
    renderHeader({ ...USER, emailVerified: false });

    expect(screen.getByText('Email unverified')).toHaveClass('bg-muted', 'text-muted-foreground');
  });

  it('draws the balance chip as a neutral badge', () => {
    renderHeader();

    expect(screen.getByText(/^Balance/)).toHaveClass('bg-muted', 'text-muted-foreground');
  });

  it('omits the balance chip when the money panel failed', () => {
    renderHeader(USER, { ok: false, error: 'unavailable' });

    expect(screen.getByTestId(TEST_IDS.adminC360Header)).not.toHaveTextContent('$');
  });

  it('opens Unlock prefilled with the user id for a locked user', async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole('button', { name: 'Unlock account' }));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(modal).toHaveTextContent('Unlock account');
    expect(within(modal).getByLabelText('userId')).toHaveValue(USER_ID);
  });

  it('offers Lock instead of Unlock for an active user', async () => {
    const user = userEvent.setup();
    renderHeader({ ...USER, lockedAt: null });

    expect(screen.queryByRole('button', { name: 'Unlock account' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Lock account' }));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByLabelText('userId')).toHaveValue(USER_ID);
  });

  it('opens Revoke sessions prefilled with the user id', async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole('button', { name: 'Revoke all sessions' }));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByLabelText('userId')).toHaveValue(USER_ID);
  });

  it('states the revoke-sessions op has no undo, and why, before the operator runs it', async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole('button', { name: 'Revoke all sessions' }));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(modal).toHaveTextContent('No undo');
  });

  it('states no such case for the unlock op, whose effect the operator owns', async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole('button', { name: 'Unlock account' }));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(modal).not.toHaveTextContent('No undo');
  });

  it('opens Credit wallet prefilled with the purchased wallet id', async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole('button', { name: 'Credit wallet' }));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(modal).toHaveTextContent('Credit wallet');
    expect(within(modal).getByLabelText('walletId')).toHaveValue(WALLET_ID);
  });

  it('opens Credit wallet without a prefill when the money panel failed', async () => {
    const user = userEvent.setup();
    renderHeader(USER, { ok: false, error: 'unavailable' });

    await user.click(screen.getByRole('button', { name: 'Credit wallet' }));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByLabelText('walletId')).toHaveValue('');
  });
});
