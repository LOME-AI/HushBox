// POST /chat/guest on a new conversation whose overall budget is still $0.00:
// the owner's balance and the link's allowance are both positive, and still
// nothing funds the guest's turn.
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ledgerEntries, memberBudgets, wallets } from '@hushbox/db';
import {
  MODEL,
  STARTED,
  db,
  fakeRealtime,
  postGuest,
  recordingRealtime,
  seedConversation,
  seedGuestLink,
  seedModel,
  seedUser,
} from '../../test-support/chat-routes.integration.setup.js';

const OWNER_BALANCE = 10_000_000_000n; // $10.00
const LINK_ALLOWANCE = 5_000_000_000n; // $5.00

interface OwnerLedgerState {
  readonly balanceNanoUsd: bigint | undefined;
  readonly ledgerRowIds: readonly string[];
}

async function ownerLedgerState(walletId: string): Promise<OwnerLedgerState> {
  const walletRows = await db
    .select({ balanceNanoUsd: wallets.balanceNanoUsd })
    .from(wallets)
    .where(eq(wallets.id, walletId));
  const ledgerRows = await db
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.walletId, walletId));
  return {
    balanceNanoUsd: walletRows[0]?.balanceNanoUsd,
    ledgerRowIds: ledgerRows.map((row) => row.id),
  };
}

describe('chat route: POST /chat/guest under a $0.00 overall budget', () => {
  it('refuses the guest send as group budget exhausted', async () => {
    await seedModel();
    const ownerId = await seedUser();
    // No overall budget is set: the conversation keeps the column default, $0.00.
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    await db
      .insert(memberBudgets)
      .values({ memberId: guest.memberId, budgetNanoUsd: LINK_ALLOWANCE, spentNanoUsd: 0n });
    const walletRows = await db
      .insert(wallets)
      .values({ userId: ownerId, type: 'purchased', balanceNanoUsd: OWNER_BALANCE })
      .returning({ id: wallets.id });
    const ownerWalletId = walletRows[0]?.id;
    if (ownerWalletId === undefined) throw new Error('owner wallet seed failed');

    const res = await postGuest(fakeRealtime(STARTED), guest.credential, {
      conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      userMessage: { content: 'hello from a guest' },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'GROUP_BUDGET_EXHAUSTED' });
  });

  it('charges the owner nothing for the refused send: no run starts, no ledger row appears', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    await db
      .insert(memberBudgets)
      .values({ memberId: guest.memberId, budgetNanoUsd: LINK_ALLOWANCE, spentNanoUsd: 0n });
    const walletRows = await db
      .insert(wallets)
      .values({ userId: ownerId, type: 'purchased', balanceNanoUsd: OWNER_BALANCE })
      .returning({ id: wallets.id });
    const ownerWalletId = walletRows[0]?.id;
    if (ownerWalletId === undefined) throw new Error('owner wallet seed failed');
    const before = await ownerLedgerState(ownerWalletId);
    const { starts, realtime } = recordingRealtime();

    const res = await postGuest(realtime, guest.credential, {
      conversationId,
      turnSources: [{ kind: 'model', id: MODEL }],
      userMessage: { content: 'hello from a guest' },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'GROUP_BUDGET_EXHAUSTED' });
    expect(starts).toEqual([]);
    expect(await ownerLedgerState(ownerWalletId)).toEqual(before);
  });
});
