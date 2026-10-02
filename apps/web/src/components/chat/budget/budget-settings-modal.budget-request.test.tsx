/**
 * Which requests the budget settings modal issues, observed at the transport
 * rather than asserted against the hook's arguments: the real
 * `useConversationBudgets`, the real TanStack Query client and the real typed
 * client all run, and what they reach is a stubbed `fetch`. The sibling suite
 * mocks that hook, so it can see the modal's rendering but not the request the
 * modal causes.
 *
 * The closed modal is the state that matters: it mounts with the group chat
 * rather than when it opens, so a closed one is what a link guest actually has
 * on screen.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';

vi.mock('@/lib/api/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/api')>();
  return { ...actual, getApiUrl: () => 'http://localhost:8787' };
});

import { urlFromFetchInput } from '@/test-utils/fetch-mock';
import { renderWithProviders } from '@/test-utils/render';
import { setLinkGuestAuth, clearLinkGuestAuth } from '@/lib/auth/link-guest-auth';
import { BudgetSettingsModal } from '@/components/chat/budget/budget-settings-modal';
import type { InferResponseType } from 'hono/client';
import type { client } from '@/lib/api-client';

type Conversation = (typeof client.conversations)[':conversationId'];
type LinksBody = InferResponseType<Conversation['links']['$get'], 200>;
type MembersBody = InferResponseType<Conversation['members']['$get'], 200>;

const BUDGETS_RESPONSE = {
  conversationCapNanoUsd: '100000000000',
  conversationSpentNanoUsd: '42500000000',
  ownerBalanceNanoUsd: '500000000000',
  members: [
    {
      memberId: 'mem-2',
      userId: 'user-2',
      username: 'bob',
      privilege: 'write',
      capNanoUsd: '25000000000',
      spentNanoUsd: '8000000000',
      effectiveRemainingNanoUsd: '17000000000',
    },
  ],
};

const SEATED = {
  linkId: null,
  visibleFromEpoch: 1,
  joinedAt: isoAt(TEST_DAY_START),
  accepted: true,
};

const ROSTER_RESPONSE: MembersBody = {
  members: [
    { id: 'mem-1', userId: 'user-1', username: 'alice', privilege: 'owner', ...SEATED },
    { id: 'mem-2', userId: 'user-2', username: 'bob', privilege: 'write', ...SEATED },
  ],
};

const LINKS_RESPONSE: LinksBody = { links: [] };

let mockFetch: Mock<typeof fetch>;

/** Each read answers with its own route's body; a budget write answers as the API does. */
function answer(input: RequestInfo | URL): Response {
  const url = urlFromFetchInput(input);
  if (url.endsWith('/links')) return Response.json(LINKS_RESPONSE);
  if (url.endsWith('/members')) return Response.json(ROSTER_RESPONSE);
  if (url.endsWith('/budget')) return Response.json({ updated: true });
  return Response.json(BUDGETS_RESPONSE);
}

function budgetRequests(): string[] {
  return mockFetch.mock.calls
    .map(([input]) => urlFromFetchInput(input))
    .filter((url) => url.includes('/budgets'));
}

interface SentWrite {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly hasIdempotencyKey: boolean;
}

function budgetWrites(): SentWrite[] {
  return mockFetch.mock.calls.flatMap(([input, init]): SentWrite[] => {
    const url = urlFromFetchInput(input);
    if (!url.endsWith('/budget')) return [];
    const headers = new Headers(init?.headers);
    return [
      {
        method: init?.method ?? 'GET',
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
        hasIdempotencyKey: headers.has('Idempotency-Key'),
      },
    ];
  });
}

describe('BudgetSettingsModal budget request', () => {
  beforeEach(() => {
    // A fresh Response per call: a body is readable once, and the typed client
    // reads it.
    mockFetch = vi.fn<typeof fetch>((input) => Promise.resolve(answer(input)));
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
      <BudgetSettingsModal
        open={false}
        onOpenChange={vi.fn()}
        conversationId="conv-1"
        currentUserPrivilege="write"
      />
    );

    await waitFor(() => {
      expect(mockFetch).not.toHaveBeenCalled();
    });
    expect(budgetRequests()).toEqual([]);
  });

  it('issues the conversation-budget request for a session-authenticated member before it opens', async () => {
    renderWithProviders(
      <BudgetSettingsModal
        open={false}
        onOpenChange={vi.fn()}
        conversationId="conv-1"
        currentUserPrivilege="write"
      />
    );

    await waitFor(() => {
      expect(budgetRequests()).toHaveLength(1);
    });
    expect(budgetRequests()[0]).toContain('/conversations/conv-1/budgets');
  });

  it('renders the served member row for a session-authenticated member', async () => {
    renderWithProviders(
      <BudgetSettingsModal
        open
        onOpenChange={vi.fn()}
        conversationId="conv-1"
        currentUserPrivilege="write"
      />
    );

    const row = await screen.findByTestId(TEST_ID_BUILDERS.budgetMember('mem-2'));
    expect(row).toHaveTextContent('Bob');
    expect(screen.queryByTestId(TEST_IDS.budgetLoading)).not.toBeInTheDocument();
  });

  it('holds a link guest on the loading state it already showed', async () => {
    setLinkGuestAuth('link-public-key');

    renderWithProviders(
      <BudgetSettingsModal
        open
        onOpenChange={vi.fn()}
        conversationId="conv-1"
        currentUserPrivilege="write"
      />
    );

    expect(await screen.findByTestId(TEST_IDS.budgetLoading)).toBeInTheDocument();
    expect(budgetRequests()).toEqual([]);
  });

  it('sends one budget write, for the one member row that changed', async () => {
    renderWithProviders(
      <BudgetSettingsModal
        open
        onOpenChange={vi.fn()}
        conversationId="conv-1"
        currentUserPrivilege="owner"
      />
    );
    const field = await screen.findByTestId(TEST_ID_BUILDERS.budgetInput('mem-2'));
    await userEvent.clear(field);
    await userEvent.type(field, '30.00');

    await userEvent.click(screen.getByTestId(TEST_IDS.budgetSaveButton));

    await waitFor(() => {
      expect(budgetWrites()).toHaveLength(1);
    });
    expect(budgetWrites()).toEqual([
      {
        method: 'PUT',
        url: 'http://localhost:8787/conversations/conv-1/member/mem-2/budget',
        body: { capNanoUsd: '30000000000' },
        hasIdempotencyKey: true,
      },
    ]);
  });

  it('sends the conversation budget write alone when only it changed', async () => {
    renderWithProviders(
      <BudgetSettingsModal
        open
        onOpenChange={vi.fn()}
        conversationId="conv-1"
        currentUserPrivilege="owner"
      />
    );
    const field = await screen.findByTestId(TEST_IDS.budgetConversationInput);
    await userEvent.clear(field);
    await userEvent.type(field, '0');

    await userEvent.click(screen.getByTestId(TEST_IDS.budgetSaveButton));

    await waitFor(() => {
      expect(budgetWrites()).toHaveLength(1);
    });
    expect(budgetWrites()).toEqual([
      {
        method: 'PUT',
        url: 'http://localhost:8787/conversations/conv-1/budget',
        body: { capNanoUsd: '0' },
        hasIdempotencyKey: true,
      },
    ]);
  });
});
