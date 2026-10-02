/**
 * Which requests the member sidebar's footer issues, observed at the transport
 * rather than asserted against the hook's arguments: the real
 * `useConversationBudgets`, the real TanStack Query client and the real typed
 * client all run, and what they reach is a stubbed `fetch`. A gate asserted at
 * the hook's call site would still pass if the query fired for another reason.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';

vi.mock('@/lib/api/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/api')>();
  return { ...actual, getApiUrl: () => 'http://localhost:8787' };
});

import { urlFromFetchInput } from '@/test-utils/fetch-mock';
import { renderWithProviders } from '@/test-utils/render';
import { setLinkGuestAuth, clearLinkGuestAuth } from '@/lib/auth/link-guest-auth';
import { MemberSidebarFooter } from '@/components/chat/member/member-sidebar-footer';

const BUDGETS_RESPONSE = {
  conversationCapNanoUsd: '0',
  conversationSpentNanoUsd: '30000000000',
  ownerBalanceNanoUsd: '200000000000',
  members: [
    {
      memberId: 'mem-1',
      userId: 'user-1',
      username: 'alice',
      privilege: 'write',
      capNanoUsd: '0',
      spentNanoUsd: '5000000000',
      effectiveRemainingNanoUsd: '35000000000',
    },
  ],
};

let mockFetch: Mock<typeof fetch>;

function requestsTo(path: string): string[] {
  return mockFetch.mock.calls
    .map(([input]) => urlFromFetchInput(input))
    .filter((url) => url.includes(path));
}

function budgetRequests(): string[] {
  return requestsTo('/budgets');
}

describe('MemberSidebarFooter budget request', () => {
  beforeEach(() => {
    // A fresh Response per call: a body is readable once, and the typed client
    // reads it.
    mockFetch = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(BUDGETS_RESPONSE)));
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    // Unmount before leaving link-guest mode: the mode notifies its subscribers
    // synchronously, so clearing it under a mounted tree is a React update
    // outside `act`.
    cleanup();
    clearLinkGuestAuth();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('issues no conversation-budget request when the viewer is a link guest', async () => {
    setLinkGuestAuth('link-public-key');

    renderWithProviders(
      <MemberSidebarFooter
        conversationId="conv-1"
        currentUserId="mem-1"
        currentUserPrivilege="write"
        collapsed={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.memberBudgetFooter)).toBeInTheDocument();
    });

    expect(budgetRequests()).toEqual([]);
  });

  it('issues the conversation-budget request for a session-authenticated member', async () => {
    renderWithProviders(
      <MemberSidebarFooter
        conversationId="conv-1"
        currentUserId="mem-1"
        currentUserPrivilege="write"
        collapsed={false}
      />
    );

    await waitFor(() => {
      expect(budgetRequests()).toHaveLength(1);
    });
    expect(budgetRequests()[0]).toContain('/conversations/conv-1/budgets');
  });

  it('renders the served figures for a session-authenticated member', async () => {
    renderWithProviders(
      <MemberSidebarFooter
        conversationId="conv-1"
        currentUserId="mem-1"
        currentUserPrivilege="write"
        collapsed={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.memberBudgetFooter)).toHaveTextContent(
        '$5.00 of $0.00 spent'
      );
    });
  });

  it('names its collapsed budget button by its label', async () => {
    renderWithProviders(
      <MemberSidebarFooter
        conversationId="conv-1"
        currentUserId="mem-1"
        currentUserPrivilege="write"
        collapsed={true}
      />
    );

    await waitFor(() => {
      expect(budgetRequests()).toHaveLength(1);
    });
    expect(screen.getByTestId(TEST_IDS.memberBudgetTrigger)).toHaveAccessibleName('See budgets');
  });

  it('reads the roster and the links for the owner, who names the funded members', async () => {
    renderWithProviders(
      <MemberSidebarFooter
        conversationId="conv-1"
        currentUserId="user-owner"
        currentUserPrivilege="owner"
        collapsed={false}
      />
    );

    await waitFor(() => {
      expect(requestsTo('/members')).toHaveLength(1);
    });
    await waitFor(() => {
      expect(requestsTo('/links')).toHaveLength(1);
    });
  });

  it('reads neither the roster nor the links for a member', async () => {
    renderWithProviders(
      <MemberSidebarFooter
        conversationId="conv-1"
        currentUserId="user-1"
        currentUserPrivilege="write"
        collapsed={false}
      />
    );

    await waitFor(() => {
      expect(budgetRequests()).toHaveLength(1);
    });
    expect(requestsTo('/members')).toEqual([]);
    expect(requestsTo('/links')).toEqual([]);
  });
});
