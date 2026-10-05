/**
 * Which funding and budgets reads the list's Regenerate gate sends, for each viewer.
 *
 * Only the transport is stubbed: the typed client records every call it is asked to make, and
 * everything above it — the send gate, the funding read, the budgets read — runs for real. A stub
 * of the send gate itself could not show a request that is never made. The markdown renderer is
 * held unsettled so no row mounts: the gate is read once per list, never inside a row.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SECOND_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { MessageList } from '@/components/chat/message/message-list';
import { billingKeys } from '@/hooks/billing/billing';
import { budgetKeys } from '@/hooks/billing/use-conversation-budgets';
import { renderWithProviders } from '@/test-utils/render';
import type { Message } from '@/lib/api/api';
import type { ModelsData } from '@/hooks/models/models';
import type { QueryKey } from '@tanstack/react-query';
import type { UserTierInfo } from '@hushbox/shared';

// Whether the viewer reaches the list as a link guest: no session, a link credential, guest tier.
const { transportCalls, viewer } = vi.hoisted(() => {
  const transportCalls: { current: string[] } = { current: [] };
  return { transportCalls, viewer: { linkGuest: false } };
});

vi.mock('@/lib/platform/env', () => ({ env: { isLocalDev: false, isE2E: false } }));

vi.mock('@/lib/api/api', () => ({
  getApiUrl: (): string => 'http://localhost:8787',
  ApiError: class ApiError extends Error {},
}));

// The typed client, recording the path of every call. A call never settles, so each read stays in
// flight and its query key stays in the cache for the test to read.
vi.mock('@/lib/api-client', () => {
  function recorder(path: readonly string[]): unknown {
    return new Proxy(() => {}, {
      get: (_target, key): unknown => {
        if (typeof key !== 'string') return undefined;
        if (!key.startsWith('$')) return recorder([...path, key]);
        return (argument: unknown): Promise<never> => {
          transportCalls.current.push(`${[...path, key].join('.')} ${JSON.stringify(argument)}`);
          return new Promise<never>(() => {});
        };
      },
    });
  }
  return {
    client: recorder([]),
    fetchJson: <T,>(response: Promise<T>): Promise<T> => response,
  };
});

vi.mock('@/components/chat/message/markdown-renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }): React.JSX.Element => <div>{content}</div>,
}));

vi.mock('@/components/chat/segments/segment-renderers', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/chat/segments/segment-renderers')>();
  return { ...actual, useMarkdownRendererReady: (): boolean => false };
});

vi.mock('@/hooks/models/models', () => {
  const catalog: { data: ModelsData; isLoading: boolean; isError: boolean } = {
    data: { models: [], premiumIds: new Set<string>() },
    isLoading: false,
    isError: false,
  };
  return { useModels: (): typeof catalog => catalog };
});

vi.mock('@/lib/auth/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/auth')>();
  type Session = ReturnType<typeof actual.useSession>;
  const signedIn: Session = {
    data: {
      user: {
        id: 'reader-1',
        email: 'reader@hushbox.ai',
        username: 'reader',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: true,
      },
      session: { id: 'session-1' },
    },
    isPending: false,
  };
  // A link credential masks the session, as the real hook does.
  const masked: Session = { data: null, isPending: false };
  return { ...actual, useSession: (): Session => (viewer.linkGuest ? masked : signedIn) };
});

vi.mock('@/lib/auth/link-guest-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/link-guest-auth')>();
  return {
    ...actual,
    getLinkGuestAuth: (): ReturnType<typeof actual.getLinkGuestAuth> =>
      viewer.linkGuest ? 'link-credential' : null,
  };
});

vi.mock('@/hooks/billing/use-user-tier-info', () => {
  const paid: UserTierInfo = {
    tier: 'paid',
    canAccessPremium: true,
    purchasedBalanceNanoUsd: 10_000_000_000n,
    freeAllowanceNanoUsd: 0n,
  };
  const guest: UserTierInfo = {
    tier: 'guest',
    canAccessPremium: false,
    purchasedBalanceNanoUsd: 0n,
    freeAllowanceNanoUsd: 0n,
  };
  return { useUserTierInfo: (): UserTierInfo => (viewer.linkGuest ? guest : paid) };
});

const messages: Message[] = [
  {
    id: 'q-1',
    conversationId: 'conv-1',
    role: 'user',
    content: 'Hello!',
    createdAt: isoAt(TEST_DAY_START),
  },
  {
    id: 'a-1',
    conversationId: 'conv-1',
    role: 'assistant',
    content: 'Hi there!',
    createdAt: isoAt(TEST_DAY_START + SECOND_MS),
  },
];

function fundingCalls(): string[] {
  return transportCalls.current.filter((call) => /spendable|budgets|funding/.test(call));
}

function cachedKeys(keys: readonly QueryKey[]): string[] {
  return keys.map((key) => JSON.stringify(key));
}

describe('the reads the list sends to price a re-run', () => {
  beforeEach(() => {
    transportCalls.current = [];
    viewer.linkGuest = false;
  });

  describe('a signed-in viewer whose row grants no re-run sends no funding or budgets read', () => {
    it('for a message-link reader', () => {
      renderWithProviders(<MessageList messages={messages} isMessageLink isAuthenticated />);
      expect(fundingCalls()).toEqual([]);
    });

    it('for a group member who may only read', () => {
      renderWithProviders(
        <MessageList
          messages={messages}
          isAuthenticated
          isGroupChat
          currentUserId="reader-1"
          callerPrivilege="read"
        />
      );
      expect(fundingCalls()).toEqual([]);
    });
  });

  describe('a member who can send makes the reads it made before, under the same keys', () => {
    it('a group member who may write reads the conversation’s funding and its budgets', () => {
      const { queryClient } = renderWithProviders(
        <MessageList
          messages={messages}
          isAuthenticated
          isGroupChat
          currentUserId="reader-1"
          callerPrivilege="write"
        />
      );
      const keys = cachedKeys(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey)
      );
      expect(keys).toContain(JSON.stringify(billingKeys.spendableFor('conv-1')));
      expect(keys).toContain(JSON.stringify(budgetKeys.conversation('conv-1')));
      expect(fundingCalls()).toEqual(
        expect.arrayContaining([
          'billing.spendable.$get {"query":{"conversationId":"conv-1"}}',
          'conversations.:conversationId.budgets.$get {"param":{"conversationId":"conv-1"}}',
        ])
      );
    });

    it('a solo owner reads the conversation’s funding and no budgets', () => {
      const { queryClient } = renderWithProviders(
        <MessageList messages={messages} isAuthenticated currentUserId="reader-1" />
      );
      const keys = cachedKeys(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey)
      );
      expect(keys).toContain(JSON.stringify(billingKeys.spendableFor('conv-1')));
      expect(keys).not.toContain(JSON.stringify(budgetKeys.conversation('conv-1')));
      expect(fundingCalls()).toEqual([
        'billing.spendable.$get {"query":{"conversationId":"conv-1"}}',
      ]);
    });
  });
  describe('a grant that changes while the list is mounted', () => {
    it("sends the conversation's funding and budgets reads once a member who could only read may write", () => {
      const { rerender } = renderWithProviders(
        <MessageList
          messages={messages}
          isAuthenticated
          isGroupChat
          currentUserId="reader-1"
          callerPrivilege="read"
        />
      );
      expect(fundingCalls()).toEqual([]);

      rerender(
        <MessageList
          messages={messages}
          isAuthenticated
          isGroupChat
          currentUserId="reader-1"
          callerPrivilege="write"
        />
      );
      expect(fundingCalls()).toEqual(
        expect.arrayContaining([
          'billing.spendable.$get {"query":{"conversationId":"conv-1"}}',
          'conversations.:conversationId.budgets.$get {"param":{"conversationId":"conv-1"}}',
        ])
      );
    });

    it("sends no funding read once a link guest's privilege arrives as write", () => {
      viewer.linkGuest = true;
      const { rerender } = renderWithProviders(
        <MessageList messages={messages} isAuthenticated={false} isLinkGuest />
      );

      rerender(
        <MessageList
          messages={messages}
          isAuthenticated={false}
          isLinkGuest
          callerPrivilege="write"
        />
      );
      expect(fundingCalls()).toEqual([]);
    });

    it('stops observing the funding and budgets reads once a member may only read', () => {
      // An observed read is refetched on focus and on the socket's invalidations, so a read-only
      // viewer must leave no observer behind, not merely send nothing new at the rerender.
      const { rerender, queryClient } = renderWithProviders(
        <MessageList
          messages={messages}
          isAuthenticated
          isGroupChat
          currentUserId="reader-1"
          callerPrivilege="write"
        />
      );
      expect(fundingCalls()).not.toEqual([]);
      transportCalls.current = [];

      rerender(
        <MessageList
          messages={messages}
          isAuthenticated
          isGroupChat
          currentUserId="reader-1"
          callerPrivilege="read"
        />
      );
      expect(fundingCalls()).toEqual([]);
      for (const queryKey of [
        billingKeys.spendableFor('conv-1'),
        budgetKeys.conversation('conv-1'),
      ]) {
        expect(queryClient.getQueryCache().find({ queryKey })?.getObserversCount()).toBe(0);
      }
    });
  });
});
