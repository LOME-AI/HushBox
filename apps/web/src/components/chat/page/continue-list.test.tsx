import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { TEST_IDS, type ConversationListItem } from '@hushbox/shared';
import { DAY_MS, HOUR_MS, TEST_DAY_START, freezeClock } from '@hushbox/shared/test-time';
import { useAuthStore } from '@/lib/auth/auth';
import { clearLinkGuestAuth, setLinkGuestAuth } from '@/lib/auth/link-guest-auth';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: Readonly<{
    children: React.ReactNode;
    to: string;
    params: { id: string };
    'aria-label': string;
    className?: string;
  }>): React.JSX.Element => (
    <a href={to.replace('$id', params.id)} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@/hooks/chat/chat', () => ({
  useDecryptedConversations: vi.fn(),
}));

import { useDecryptedConversations } from '@/hooks/chat/chat';
import { ContinueList } from './continue-list';

const mockUseDecryptedConversations = vi.mocked(useDecryptedConversations);

const REFERENCE_DAY = new Date(TEST_DAY_START);

/** Noon on the viewer's local calendar, `dayOffset` days from the reference day. */
function localNoon(dayOffset: number): number {
  return new Date(
    REFERENCE_DAY.getUTCFullYear(),
    REFERENCE_DAY.getUTCMonth(),
    REFERENCE_DAY.getUTCDate() + dayOffset,
    12
  ).getTime();
}

const NOW = localNoon(0);

function conversation(
  id: string,
  title: string,
  updatedAtMs: number,
  overrides: Partial<ConversationListItem> = {}
): ConversationListItem {
  return {
    id,
    title,
    currentEpoch: 1,
    titleEpochNumber: 1,
    nextSequence: 1,
    createdAt: new Date(updatedAtMs - DAY_MS).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    accepted: true,
    invitedByUsername: null,
    privilege: 'owner',
    muted: false,
    pinned: false,
    lastReadSeq: 0,
    memberCount: 1,
    ...overrides,
  };
}

function withConversations(data?: ConversationListItem[]): void {
  mockUseDecryptedConversations.mockReturnValue({
    data,
    isLoading: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  });
}

function signIn(): void {
  useAuthStore.getState().setUser({
    id: 'user-1',
    email: 'alice@hushbox.ai',
    username: 'alice',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: true,
  });
  useAuthStore.getState().setLoading(false);
}

const FIVE_CONVERSATIONS: ConversationListItem[] = [
  conversation('conv-pinned-old', 'Thesis outline', NOW - 40 * DAY_MS, { pinned: true }),
  conversation('conv-invite', 'Team offsite', NOW - HOUR_MS, { accepted: false }),
  conversation('conv-lease', 'Lease renewal letter', NOW - 2 * HOUR_MS),
  conversation('conv-tcp', 'TCP vs UDP for game netcode', localNoon(-3)),
  conversation('conv-merge', 'Merging duplicate contacts', NOW - 3 * HOUR_MS),
];

describe('ContinueList', () => {
  beforeEach(() => {
    freezeClock(NOW, { toFake: ['Date'] });
    signIn();
  });

  afterEach(() => {
    // Unmount before resetting the auth stores, so the reset re-renders nothing.
    cleanup();
    vi.useRealTimers();
    clearLinkGuestAuth();
    useAuthStore.getState().setUser(null);
  });

  it('lists the three most recent accepted conversations, newest first, whatever their pin', () => {
    withConversations(FIVE_CONVERSATIONS);

    render(<ContinueList />);

    const links = within(screen.getByRole('navigation', { name: 'Continue' })).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/chat/conv-lease',
      '/chat/conv-merge',
      '/chat/conv-tcp',
    ]);
  });

  it('names each conversation by its title and its date group', () => {
    withConversations(FIVE_CONVERSATIONS);

    render(<ContinueList />);

    expect(screen.getByRole('link', { name: 'Lease renewal letter, Today' })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'TCP vs UDP for game netcode, Previous 7 days' })
    ).toBeInTheDocument();
  });

  it('shows each title with its date group as visible text', () => {
    withConversations([conversation('conv-tcp', 'TCP vs UDP for game netcode', localNoon(-3))]);

    render(<ContinueList />);

    const link = screen.getByRole('link', { name: 'TCP vs UDP for game netcode, Previous 7 days' });
    expect(within(link).getByText('TCP vs UDP for game netcode')).toBeInTheDocument();
    expect(within(link).getByText('Previous 7 days')).toBeInTheDocument();
  });

  it('shows fewer than three when the account has fewer', () => {
    withConversations([conversation('conv-lease', 'Lease renewal letter', NOW - HOUR_MS)]);

    render(<ContinueList />);

    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('carries the registry test id on its landmark', () => {
    withConversations(FIVE_CONVERSATIONS);

    render(<ContinueList />);

    expect(screen.getByRole('navigation', { name: 'Continue' })).toHaveAttribute(
      'data-testid',
      TEST_IDS.continueList
    );
  });

  it('draws nothing for an account with no conversations', () => {
    withConversations([]);

    const { container } = render(<ContinueList />);

    expect(container).toBeEmptyDOMElement();
  });

  it('draws nothing for an account whose only conversations are unaccepted invites', () => {
    withConversations([
      conversation('conv-invite', 'Team offsite', NOW - HOUR_MS, { accepted: false }),
    ]);

    const { container } = render(<ContinueList />);

    expect(container).toBeEmptyDOMElement();
  });

  it('draws nothing while the conversation list has not arrived', () => {
    withConversations();

    const { container } = render(<ContinueList />);

    expect(container).toBeEmptyDOMElement();
  });

  it('draws nothing for a visitor who is not signed in', () => {
    useAuthStore.getState().setUser(null);
    withConversations(FIVE_CONVERSATIONS);

    const { container } = render(<ContinueList />);

    expect(container).toBeEmptyDOMElement();
  });

  it('draws nothing for a link guest, even over a cached conversation list', () => {
    setLinkGuestAuth('link-guest-public-key');
    withConversations(FIVE_CONVERSATIONS);

    const { container } = render(<ContinueList />);

    expect(container).toBeEmptyDOMElement();
  });
});
