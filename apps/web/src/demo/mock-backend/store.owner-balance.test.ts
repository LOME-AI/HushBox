import { describe, it, expect, vi } from 'vitest';
import type { DemoConversation } from './fixtures';

// Every shipped demo conversation is owned by the demo user, so a conversation
// the demo user joined as a plain member exists only by adding one to the
// fixture set.
const MEMBER_VIEW_ID = 'demo-member-view';

vi.mock('./fixtures', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fixtures')>();
  const memberView: DemoConversation = {
    id: MEMBER_VIEW_ID,
    title: 'Joined group',
    members: [
      { userId: 'demo-user-amir', username: 'amir', privilege: 'owner' },
      { userId: actual.DEMO_USER.id, username: 'demo', privilege: 'write' },
    ],
    messages: [],
  };
  return { ...actual, DEMO_CONVERSATIONS: [...actual.DEMO_CONVERSATIONS, memberView] };
});

const { DemoBackendStore } = await import('./store');
const { generateKeyPair } = await import('@hushbox/crypto');

describe('DemoBackendStore owner balance on conversation budgets', () => {
  it('serves the owner balance where the demo user owns the conversation', () => {
    const store = new DemoBackendStore(generateKeyPair().publicKey);

    expect(store.getConversationBudgets('demo-group').ownerBalanceNanoUsd).toBe(
      store.getBalance().purchased.balanceNanoUsd
    );
  });

  it('serves null where the demo user is not the owner', () => {
    const store = new DemoBackendStore(generateKeyPair().publicKey);

    expect(store.getConversationBudgets(MEMBER_VIEW_ID).ownerBalanceNanoUsd).toBeNull();
  });
});
