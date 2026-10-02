import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMembers = [
  { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
  { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
];

const mockLinks = [
  { id: 'l1', displayName: 'Dave', privilege: 'read', createdAt: isoAt(TEST_DAY_START) },
];

const mockPresenceMap = new Map([
  ['u1', { userId: 'u1', displayName: 'alice', isGuest: false, connectedAt: 1 }],
]);

const mockRemoveMutateAsync = vi.fn().mockResolvedValue({});
const mockChangeMutateAsync = vi.fn().mockResolvedValue({});
const mockRevokeMutateAsync = vi.fn().mockResolvedValue({});
const mockLeaveMutateAsync = vi.fn().mockResolvedValue({});
const mockAddMutateAsync = vi.fn().mockResolvedValue({});
const mockAdminNameMutateAsync = vi.fn().mockResolvedValue({});
const mockChangeLinkPrivilegeMutateAsync = vi.fn().mockResolvedValue({});
const mockNavigate = vi.fn();

vi.mock('@/lib/auth/auth.js', () => ({
  useAuthStore: Object.assign(
    vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        user: { id: 'u1', email: 'a@b.com', username: 'alice' },
      })
    ),
    { getState: vi.fn(() => ({ user: { id: 'u1' } })) }
  ),
}));

vi.mock('@/hooks/realtime/use-conversation-members.js', () => ({
  useConversationMembers: vi.fn(() => ({
    data: { members: mockMembers },
    isLoading: false,
    isError: false,
  })),
  useAddMember: vi.fn(() => ({ mutateAsync: mockAddMutateAsync })),
  useRemoveMember: vi.fn(() => ({ mutateAsync: mockRemoveMutateAsync })),
  useChangePrivilege: vi.fn(() => ({ mutateAsync: mockChangeMutateAsync })),
  useLeaveConversation: vi.fn(() => ({ mutateAsync: mockLeaveMutateAsync })),
}));

vi.mock('@/hooks/realtime/use-conversation-links.js', () => ({
  useConversationLinks: vi.fn(() => ({
    data: { links: mockLinks },
    isLoading: false,
    isError: false,
  })),
  useRevokeLink: vi.fn(() => ({ mutateAsync: mockRevokeMutateAsync })),
  useChangeLinkPrivilege: vi.fn(() => ({ mutateAsync: mockChangeLinkPrivilegeMutateAsync })),
}));

vi.mock('@/hooks/realtime/use-conversation-websocket.js', () => ({
  useConversationWebSocket: vi.fn(() => null),
}));

vi.mock('@/hooks/realtime/use-presence.js', () => ({
  usePresence: vi.fn(() => mockPresenceMap),
}));

const mockUseRealtimeSync = vi.fn();
vi.mock('@/hooks/realtime/use-realtime-sync.js', () => ({
  useRealtimeSync: (...args: unknown[]) => mockUseRealtimeSync(...args),
}));

const mockRemoteStreamingMap = new Map();
vi.mock('@/hooks/realtime/use-remote-streaming.js', () => ({
  useRemoteStreaming: vi.fn(() => mockRemoteStreamingMap),
}));

const mockTypingUserIds = new Set<string>();
vi.mock('@/hooks/realtime/use-typing-indicators.js', () => ({
  useTypingIndicators: vi.fn(() => mockTypingUserIds),
}));

vi.mock('@/hooks/realtime/use-link-name.js', () => ({
  useAdminLinkName: vi.fn(() => ({ mutateAsync: mockAdminNameMutateAsync })),
}));

vi.mock(import('@/lib/crypto/epoch-key-cache.js'), () => ({
  getCurrentEpoch: vi.fn<typeof getCurrentEpoch>(() => 3),
  getEpochKey: vi.fn<typeof getEpochKey>(() => new Uint8Array(32).fill(7)),
  getEpochVerdict: vi.fn<typeof getEpochVerdict>(),
  subscribe: vi.fn<typeof subscribe>(() => vi.fn()),
  getSnapshot: vi.fn<typeof getSnapshot>(() => 0),
}));

const mockExecuteWithRotation = vi.fn<typeof executeWithRotation>();
vi.mock(import('@/lib/crypto/rotation.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  executeWithRotation: (...args: Parameters<typeof executeWithRotation>) =>
    mockExecuteWithRotation(...args),
}));

vi.mock(import('@hushbox/crypto'), () => ({
  wrapEpochKeyForNewMember: vi.fn<typeof wrapEpochKeyForNewMember>(() =>
    new Uint8Array(32).fill(9)
  ),
  getPublicKeyFromPrivate: vi.fn<typeof getPublicKeyFromPrivate>(() => new Uint8Array(32).fill(6)),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    fromBase64: vi.fn((s: string) => new Uint8Array(Buffer.from(s, 'base64'))),
    toBase64: vi.fn(() => 'base64wrap'),
  };
});

vi.mock('@tanstack/react-router', () => ({
  useNavigate: vi.fn(() => mockNavigate),
}));

import { wrapEpochKeyForNewMember } from '@hushbox/crypto';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { requireCurrentEpochKey, useGroupChat } from '@/hooks/realtime/use-group-chat.js';
import { useConversationMembers } from '@/hooks/realtime/use-conversation-members.js';
import { useConversationLinks } from '@/hooks/realtime/use-conversation-links.js';
import {
  getCurrentEpoch,
  getEpochKey,
  getEpochVerdict,
  getSnapshot,
} from '@/lib/crypto/epoch-key-cache.js';
import { useRemoteStreaming } from '@/hooks/realtime/use-remote-streaming.js';
import { useTypingIndicators } from '@/hooks/realtime/use-typing-indicators.js';
import { useConversationWebSocket } from '@/hooks/realtime/use-conversation-websocket.js';
import { useNotificationActivityStore } from '@/stores/activity/notification.js';
import { UnverifiedKeyChainError } from '@/lib/crypto/rotation.js';
import type { getPublicKeyFromPrivate } from '@hushbox/crypto';
import type { executeWithRotation, MemberKeyResponse } from '@/lib/crypto/rotation.js';
import type { EpochVerdict, subscribe } from '@/lib/crypto/epoch-key-cache.js';
import type { CurrentEpochKey, GroupChatProps } from '@/components/chat/message/types.js';

function verdictOf(rotation: EpochVerdict['rotation']): EpochVerdict {
  return {
    currentEpoch: 3,
    rotationPending: false,
    rotation,
    lastGoodEpoch: rotation === 'ok' ? 3 : 2,
    badEpochs: new Set(),
  };
}

const verifiedKey: CurrentEpochKey = { epochNumber: 3, privateKey: new Uint8Array(32).fill(7) };

describe('requireCurrentEpochKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses when no verified current-epoch key is cached', () => {
    vi.mocked(getEpochVerdict).mockReturnValue(verdictOf('ok'));

    // eslint-disable-next-line unicorn/no-useless-undefined -- currentEpochKey is a required positional argument
    expect(() => requireCurrentEpochKey('conv-1', undefined)).toThrow(UnverifiedKeyChainError);
  });

  it('refuses a verified current-epoch key while the verdict is bad', () => {
    vi.mocked(getEpochVerdict).mockReturnValue(verdictOf('bad'));

    expect(() => requireCurrentEpochKey('conv-1', verifiedKey)).toThrow(UnverifiedKeyChainError);
  });

  it('returns the verified current-epoch key under an ok verdict', () => {
    vi.mocked(getEpochVerdict).mockReturnValue(verdictOf('ok'));

    expect(requireCurrentEpochKey('conv-1', verifiedKey)).toBe(verifiedKey);
  });

  it('returns the verified current-epoch key while no verdict has been reached', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockReturnValue requires an argument for the EpochVerdict|undefined return
    vi.mocked(getEpochVerdict).mockReturnValue(undefined);

    expect(requireCurrentEpochKey('conv-1', verifiedKey)).toBe(verifiedKey);
  });

  it('reads the verdict of the conversation it names', () => {
    vi.mocked(getEpochVerdict).mockReturnValue(verdictOf('ok'));

    requireCurrentEpochKey('conv-9', verifiedKey);

    expect(getEpochVerdict).toHaveBeenCalledWith('conv-9');
  });
});

describe('useGroupChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentEpoch).mockReturnValue(3);
    vi.mocked(getEpochKey).mockReturnValue(new Uint8Array(32).fill(7));
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockReturnValue requires an argument for the EpochVerdict|undefined return
    vi.mocked(getEpochVerdict).mockReturnValue(undefined);
    mockExecuteWithRotation.mockResolvedValue({
      params: {
        expectedEpoch: 3,
        epochPublicKey: 'ep',
        confirmationHash: 'ch',
        chainLink: 'cl',
        encryptedTitle: 'et',
        memberWraps: [],
      },
      newEpochPrivateKey: new Uint8Array(32).fill(8),
      newEpochNumber: 4,
    });
    vi.mocked(useConversationMembers).mockReturnValue({
      data: { members: mockMembers },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);
    vi.mocked(useConversationLinks).mockReturnValue({
      data: { links: mockLinks },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationLinks>);
  });

  it('returns undefined for null conversationId', () => {
    const { result } = renderHook(() => useGroupChat(null, 'u1'));

    expect(result.current).toBeUndefined();
  });

  it.each([
    { scenario: 'the invite link is revoked', status: 401 },
    { scenario: 'the caller is no longer a member', status: 404 },
  ])('drops the websocket when $scenario ($status)', ({ status }) => {
    // Stale members keep `isGroup` true, but a terminal 4xx means access is gone.
    // The socket must be torn down so it stops retrying a doomed handshake.
    vi.mocked(useConversationMembers).mockReturnValue({
      data: { members: mockMembers },
      error: Object.assign(new Error('access denied'), { status }),
      isError: true,
    } as unknown as ReturnType<typeof useConversationMembers>);

    renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(useConversationWebSocket).toHaveBeenCalledWith(null);
  });

  it('returns undefined when callerId is undefined', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- callerId is a required positional argument
    const { result } = renderHook(() => useGroupChat('conv-1', undefined));

    expect(result.current).toBeUndefined();
  });

  it('returns undefined while members are loading', () => {
    vi.mocked(useConversationMembers).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current).toBeUndefined();
  });

  it('returns GroupChatProps with correct members shape', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current).toBeDefined();
    expect(result.current!.members).toEqual([
      { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
      { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
    ]);
  });

  it('returns GroupChatProps with correct links shape', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.links).toEqual([
      {
        id: 'l1',
        displayName: 'Dave',
        privilege: 'read',
        createdAt: isoAt(TEST_DAY_START),
        memberId: null,
      },
    ]);
  });

  it('gives each link entry the id of the member seated through that link', () => {
    vi.mocked(useConversationMembers).mockReturnValue({
      data: {
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm4', userId: null, linkId: 'l2', username: null, privilege: 'write' },
          { id: 'm3', userId: null, linkId: 'l1', username: null, privilege: 'read' },
        ],
      },
      isLoading: false,
      isError: false,
      // Cast: the fixture is a partial UseQueryResult; the hook reads only `data` and `error`.
    } as ReturnType<typeof useConversationMembers>);
    vi.mocked(useConversationLinks).mockReturnValue({
      data: {
        links: [
          { id: 'l1', displayName: null, privilege: 'read', createdAt: isoAt(TEST_DAY_START) },
          { id: 'l2', displayName: null, privilege: 'write', createdAt: isoAt(TEST_DAY_START) },
        ],
      },
      isLoading: false,
      isError: false,
      // Cast: the fixture is a partial UseQueryResult; the hook reads only `data`.
    } as ReturnType<typeof useConversationLinks>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.links.map((link) => [link.id, link.memberId])).toEqual([
      ['l1', 'm3'],
      ['l2', 'm4'],
    ]);
  });

  it('leaves a link entry without a member id while its seated member is not yet read', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.links[0]!.memberId).toBeNull();
  });

  it('uses callerId to find current member instead of auth store', () => {
    // Set callerId to 'u2' (bob) — should find bob's member, not alice
    const { result } = renderHook(() => useGroupChat('conv-1', 'u2'));

    expect(result.current!.currentUserId).toBe('u2');
    expect(result.current!.currentUserPrivilege).toBe('write');
  });

  it('derives currentUserPrivilege from members list', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.currentUserPrivilege).toBe('owner');
  });

  it('carries the cached current-epoch key with its epoch number', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.currentEpochKey).toEqual({
      epochNumber: 3,
      privateKey: new Uint8Array(32).fill(7),
    });
    expect(getEpochKey).toHaveBeenCalledWith('conv-1', 3);
  });

  it('onRemoveMember calls executeWithRotation', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    act(() => {
      void result.current!.onRemoveMember!('m2');
    });

    expect(mockExecuteWithRotation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(7),
        currentEpochNumber: 3,
        plaintextTitle: 'My Chat',
        filterMembers: expect.any(Function),
        execute: expect.any(Function),
      })
    );
  });

  it('onRemoveMember filterMembers excludes removed member and includes metadata', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    act(() => {
      void result.current!.onRemoveMember!('m2');
    });

    const call = mockExecuteWithRotation.mock.calls[0]![0];
    const testKeys: MemberKeyResponse[] = [
      {
        memberId: 'm1',
        userId: 'u1',
        linkId: null,
        publicKey: 'pk1',
        privilege: 'owner',
        visibleFromEpoch: 1,
      },
      {
        memberId: 'm2',
        userId: 'u2',
        linkId: null,
        publicKey: 'pk2',
        privilege: 'write',
        visibleFromEpoch: 1,
      },
    ];
    const filtered = call.filterMembers(testKeys);
    // Should exclude m2 (the removed member) — only m1 remains
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.publicKey).toBeInstanceOf(Uint8Array);
  });

  describe('with no verified current-epoch key cached', () => {
    beforeEach(() => {
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockReturnValue requires an argument for the Uint8Array|undefined return
      vi.mocked(getEpochKey).mockReturnValue(undefined);
    });

    it('returns the loaded members', () => {
      const { result } = renderHook(() => useGroupChat('conv-1', 'u2'));

      expect(result.current!.members).toEqual([
        { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
        { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
      ]);
    });

    it("returns the caller's own identity", () => {
      const { result } = renderHook(() => useGroupChat('conv-1', 'u2'));

      expect(result.current!.currentUserId).toBe('u2');
    });

    it('carries no current-epoch key', () => {
      const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

      expect(result.current!.currentEpochKey).toBeUndefined();
    });

    it('carries no current-epoch key while the current epoch is unknown', () => {
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockReturnValue requires an argument for the number|undefined return
      vi.mocked(getCurrentEpoch).mockReturnValue(undefined);

      const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

      expect(result.current!.currentEpochKey).toBeUndefined();
    });

    it('refuses to remove a member before any request', async () => {
      const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

      await expect(result.current!.onRemoveMember!('m2')).rejects.toBeInstanceOf(
        UnverifiedKeyChainError
      );
      expect(mockExecuteWithRotation).not.toHaveBeenCalled();
      expect(mockRemoveMutateAsync).not.toHaveBeenCalled();
    });

    it('refuses to revoke a link before any request', async () => {
      const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

      await expect(result.current!.onRevokeLinkClick!('l1')).rejects.toBeInstanceOf(
        UnverifiedKeyChainError
      );
      expect(mockExecuteWithRotation).not.toHaveBeenCalled();
      expect(mockRevokeMutateAsync).not.toHaveBeenCalled();
    });

    it('refuses to add a member with full history before any request', async () => {
      const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

      await expect(
        result.current!.onAddMember!({
          userId: 'u3',
          username: 'charlie',
          publicKey: 'cGssPublic',
          privilege: 'write',
          giveFullHistory: true,
        })
      ).rejects.toBeInstanceOf(UnverifiedKeyChainError);
      expect(wrapEpochKeyForNewMember).not.toHaveBeenCalled();
      expect(mockAddMutateAsync).not.toHaveBeenCalled();
    });

    it.each<[string, (props: GroupChatProps) => void | Promise<void>]>([
      ['remove a member', (props) => props.onRemoveMember!('m2')],
      ['revoke a link', (props) => props.onRevokeLinkClick!('l1')],
      [
        'add a member with full history',
        (props) =>
          props.onAddMember!({
            userId: 'u3',
            username: 'charlie',
            publicKey: 'cGssPublic',
            privilege: 'write',
            giveFullHistory: true,
          }),
      ],
      [
        'add a member through a rotation',
        (props) =>
          props.onAddMember!({
            userId: 'u3',
            username: 'charlie',
            publicKey: 'cGssPublic',
            privilege: 'write',
            giveFullHistory: false,
          }),
      ],
    ])('refuses to %s when only older epochs have a verified key', async (_action, act) => {
      vi.mocked(getEpochKey).mockImplementation((_conversationId, epochNumber) =>
        epochNumber < 3 ? new Uint8Array(32).fill(epochNumber) : undefined
      );
      // The reachable state: the current epoch's key is unreachable with no bad link, so the
      // verdict stays ok while naming an older last-good epoch whose key is cached.
      vi.mocked(getEpochVerdict).mockReturnValue({ ...verdictOf('ok'), lastGoodEpoch: 2 });
      const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

      await expect(act(result.current!)).rejects.toBeInstanceOf(UnverifiedKeyChainError);
      expect(mockExecuteWithRotation).not.toHaveBeenCalled();
      expect(wrapEpochKeyForNewMember).not.toHaveBeenCalled();
      for (const mutation of [
        mockRemoveMutateAsync,
        mockChangeMutateAsync,
        mockRevokeMutateAsync,
        mockLeaveMutateAsync,
        mockAddMutateAsync,
        mockAdminNameMutateAsync,
        mockChangeLinkPrivilegeMutateAsync,
      ]) {
        expect(mutation).not.toHaveBeenCalled();
      }
    });

    it('refuses to add a member through a rotation before any request', async () => {
      const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

      await expect(
        result.current!.onAddMember!({
          userId: 'u3',
          username: 'charlie',
          publicKey: 'cGssPublic',
          privilege: 'write',
          giveFullHistory: false,
        })
      ).rejects.toBeInstanceOf(UnverifiedKeyChainError);
      expect(mockExecuteWithRotation).not.toHaveBeenCalled();
      expect(mockAddMutateAsync).not.toHaveBeenCalled();
    });

    it("still changes a member's privilege", async () => {
      const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

      await result.current!.onChangePrivilege!('m2', 'read');

      expect(mockChangeMutateAsync).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        memberId: 'm2',
        privilege: 'read',
      });
    });

    it('still renames a link', async () => {
      const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

      await result.current!.onSaveLinkName!('l1', 'Eve');

      expect(mockAdminNameMutateAsync).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        linkId: 'l1',
        displayName: 'Eve',
      });
    });

    it("still changes a link's privilege", async () => {
      const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

      await result.current!.onChangeLinkPrivilege!('l1', 'write');

      expect(mockChangeLinkPrivilegeMutateAsync).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        linkId: 'l1',
        privilege: 'write',
      });
    });

    it('still leaves the conversation', async () => {
      const { result } = renderHook(() => useGroupChat('conv-1', 'u2'));

      await result.current!.onLeave!();

      expect(mockLeaveMutateAsync).toHaveBeenCalledWith({ conversationId: 'conv-1' });
    });
  });

  describe('with a verified current-epoch key under a bad verdict', () => {
    beforeEach(() => {
      vi.mocked(getEpochVerdict).mockReturnValue(verdictOf('bad'));
    });

    it('refuses to add a member with full history before any request', async () => {
      const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

      await expect(
        result.current!.onAddMember!({
          userId: 'u3',
          username: 'charlie',
          publicKey: 'cGssPublic',
          privilege: 'write',
          giveFullHistory: true,
        })
      ).rejects.toBeInstanceOf(UnverifiedKeyChainError);
      expect(wrapEpochKeyForNewMember).not.toHaveBeenCalled();
      expect(mockAddMutateAsync).not.toHaveBeenCalled();
    });

    it('refuses to remove a member before any request', async () => {
      const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

      await expect(result.current!.onRemoveMember!('m2')).rejects.toBeInstanceOf(
        UnverifiedKeyChainError
      );
      expect(mockExecuteWithRotation).not.toHaveBeenCalled();
      expect(mockRemoveMutateAsync).not.toHaveBeenCalled();
    });
  });

  it('adds a member with full history under an ok verdict', async () => {
    vi.mocked(getEpochVerdict).mockReturnValue(verdictOf('ok'));
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    await result.current!.onAddMember!({
      userId: 'u3',
      username: 'charlie',
      publicKey: 'cGssPublic',
      privilege: 'write',
      giveFullHistory: true,
    });

    expect(wrapEpochKeyForNewMember).toHaveBeenCalledOnce();
    expect(mockAddMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u3', giveFullHistory: true, expectedEpoch: 3 })
    );
  });

  it('onRemoveMember execute runs the remove mutation with the rotation', async () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));
    act(() => {
      void result.current!.onRemoveMember!('m2');
    });

    const call = mockExecuteWithRotation.mock.calls[0]![0] as {
      execute: (rotation: unknown) => Promise<unknown>;
    };
    const rotation = { rotation: 'r' };
    await act(async () => {
      await call.execute(rotation);
    });

    expect(mockRemoveMutateAsync).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      memberId: 'm2',
      rotation,
    });
  });

  it('onRevokeLinkClick execute runs the revoke mutation with the rotation', async () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));
    act(() => {
      void result.current!.onRevokeLinkClick!('l1');
    });

    const call = mockExecuteWithRotation.mock.calls[0]![0] as {
      execute: (rotation: unknown) => Promise<unknown>;
    };
    const rotation = { rotation: 'r' };
    await act(async () => {
      await call.execute(rotation);
    });

    expect(mockRevokeMutateAsync).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      linkId: 'l1',
      rotation,
    });
  });

  it('onAddMember execute runs the add mutation with the rotation', async () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));
    act(() => {
      void result.current!.onAddMember!({
        userId: 'u3',
        username: 'charlie',
        publicKey: 'cGssPublic',
        privilege: 'write',
        giveFullHistory: false,
      });
    });

    const call = mockExecuteWithRotation.mock.calls[0]![0] as {
      execute: (rotation: unknown) => Promise<unknown>;
    };
    const rotation = { rotation: 'r' };
    await act(async () => {
      await call.execute(rotation);
    });

    expect(mockAddMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', userId: 'u3', rotation })
    );
  });

  it('onChangePrivilege calls mutation with correct params', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    act(() => {
      void result.current!.onChangePrivilege!('m2', 'admin');
    });

    expect(mockChangeMutateAsync).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      memberId: 'm2',
      privilege: 'admin',
    });
  });

  it('onRevokeLinkClick calls executeWithRotation', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    act(() => {
      void result.current!.onRevokeLinkClick!('l1');
    });

    expect(mockExecuteWithRotation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        plaintextTitle: 'My Chat',
        filterMembers: expect.any(Function),
        execute: expect.any(Function),
      })
    );
  });

  it('onRevokeLinkClick filterMembers excludes link member and includes metadata', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    act(() => {
      void result.current!.onRevokeLinkClick!('l1');
    });

    const call = mockExecuteWithRotation.mock.calls[0]![0];
    const testKeys: MemberKeyResponse[] = [
      {
        memberId: 'm1',
        userId: 'u1',
        linkId: null,
        publicKey: 'pk1',
        privilege: 'owner',
        visibleFromEpoch: 1,
      },
      {
        memberId: 'm3',
        userId: null,
        linkId: 'l1',
        publicKey: 'pk3',
        privilege: 'read',
        visibleFromEpoch: 1,
      },
    ];
    const filtered = call.filterMembers(testKeys);
    // Should exclude l1 (the revoked link) — only m1 remains
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.publicKey).toBeInstanceOf(Uint8Array);
  });

  it('onSaveLinkName calls admin link name mutation with new name', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    act(() => {
      void result.current!.onSaveLinkName!('l1', 'NewName');
    });

    expect(mockAdminNameMutateAsync).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      linkId: 'l1',
      displayName: 'NewName',
    });
  });

  it('onChangeLinkPrivilege calls change link privilege mutation', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    act(() => {
      void result.current!.onChangeLinkPrivilege!('l1', 'write');
    });

    expect(mockChangeLinkPrivilegeMutateAsync).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      linkId: 'l1',
      privilege: 'write',
    });
  });

  it('onLeave as owner calls mutation directly without rotation', async () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    // eslint-disable-next-line @typescript-eslint/require-await -- async needed so act() returns Promise and flushes .then() chain
    await act(async () => {
      void result.current!.onLeave!();
    });

    // Owner leave — no rotation needed (deletes conversation)
    expect(mockLeaveMutateAsync).toHaveBeenCalledWith({ conversationId: 'conv-1' });
    expect(mockExecuteWithRotation).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
  });

  it('onLeave as non-owner sends a bare leave, builds no rotation, then navigates', async () => {
    vi.mocked(useConversationMembers).mockReturnValue({
      data: {
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'write' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'owner' },
        ],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    // eslint-disable-next-line @typescript-eslint/require-await -- async needed so act() returns Promise and flushes .then() chain
    await act(async () => {
      void result.current!.onLeave!();
    });

    expect(mockLeaveMutateAsync).toHaveBeenCalledWith({ conversationId: 'conv-1' });
    expect(mockExecuteWithRotation).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
  });

  it('onAddMember with full history wraps epoch key directly', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    act(() => {
      void result.current!.onAddMember!({
        userId: 'u3',
        username: 'charlie',
        publicKey: 'cGssPublic',
        privilege: 'write',
        giveFullHistory: true,
      });
    });

    expect(wrapEpochKeyForNewMember).toHaveBeenCalledWith(
      new Uint8Array(32).fill(7),
      new Uint8Array(Buffer.from('cGssPublic', 'base64')),
      { conversationId: 'conv-1', epochNumber: 3, epochPublicKey: new Uint8Array(32).fill(6) }
    );
    expect(mockAddMutateAsync).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userId: 'u3',
      wrap: 'base64wrap',
      privilege: 'write',
      giveFullHistory: true,
      expectedEpoch: 3,
    });
    expect(mockExecuteWithRotation).not.toHaveBeenCalled();
  });

  it('onAddMember without history calls executeWithRotation', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    act(() => {
      void result.current!.onAddMember!({
        userId: 'u3',
        username: 'charlie',
        publicKey: 'cGssPublic',
        privilege: 'write',
        giveFullHistory: false,
      });
    });

    expect(wrapEpochKeyForNewMember).not.toHaveBeenCalled();
    expect(mockExecuteWithRotation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        plaintextTitle: 'My Chat',
        filterMembers: expect.any(Function),
        execute: expect.any(Function),
      })
    );
  });

  it('onAddMember without history filterMembers includes new member with metadata', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    act(() => {
      void result.current!.onAddMember!({
        userId: 'u3',
        username: 'charlie',
        publicKey: 'cGssPublic',
        privilege: 'write',
        giveFullHistory: false,
      });
    });

    const call = mockExecuteWithRotation.mock.calls[0]![0];
    const testKeys: MemberKeyResponse[] = [
      {
        memberId: 'm1',
        userId: 'u1',
        linkId: null,
        publicKey: 'pk1',
        privilege: 'owner',
        visibleFromEpoch: 1,
      },
    ];
    const filtered = call.filterMembers(testKeys);
    // Should include existing member + new member → 2 entries
    expect(filtered).toHaveLength(2);
    // Both entries only have publicKey (no metadata)
    expect(filtered[0]!.publicKey).toBeInstanceOf(Uint8Array);
    expect(filtered[1]!.publicKey).toBeInstanceOf(Uint8Array);
  });

  it('onlineMemberIds derived from presence map', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.onlineMemberIds).toEqual(new Set(['u1']));
  });

  it('handles links query error gracefully with empty array', () => {
    vi.mocked(useConversationLinks).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as ReturnType<typeof useConversationLinks>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.links).toEqual([]);
  });

  it('returns props for solo conversation with one member', () => {
    vi.mocked(useConversationMembers).mockReturnValue({
      data: {
        members: [{ id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' }],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current).toBeDefined();
    expect(result.current!.members).toEqual([
      { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
    ]);
    expect(result.current!.currentUserId).toBe('u1');
    expect(result.current!.currentUserPrivilege).toBe('owner');
  });

  it('does not create WebSocket for solo conversation', () => {
    vi.mocked(useConversationMembers).mockReturnValue({
      data: {
        members: [{ id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' }],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);

    renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(useConversationWebSocket).toHaveBeenCalledWith(null);
  });

  it('returns undefined if current user not found in members', () => {
    vi.mocked(useConversationMembers).mockReturnValue({
      data: {
        members: [{ id: 'm9', userId: 'u99', username: 'stranger', privilege: 'write' }],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current).toBeUndefined();
  });

  it('calls useRealtimeSync with ws, conversationId, and userId', () => {
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    vi.mocked(useConversationWebSocket).mockReturnValue(
      mockWs as unknown as ReturnType<typeof useConversationWebSocket>
    );

    renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(mockUseRealtimeSync).toHaveBeenCalledWith(mockWs, 'conv-1', 'u1');
  });

  it('counts a message from another member as activity while the user is away', () => {
    let onMessage: ((event: { conversationId: string; senderId?: string }) => void) | undefined;
    const mockWs = {
      on: vi.fn(
        (
          type: string,
          listener: (event: { conversationId: string; senderId?: string }) => void
        ) => {
          if (type === 'message:new') onMessage = listener;
          return () => {};
        }
      ),
      send: vi.fn(),
      close: vi.fn(),
    };
    vi.mocked(useConversationWebSocket).mockReturnValue(
      mockWs as unknown as ReturnType<typeof useConversationWebSocket>
    );
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    useNotificationActivityStore.setState({ unreadCount: 0 });

    renderHook(() => useGroupChat('conv-1', 'u1'));
    act(() => {
      onMessage?.({ conversationId: 'conv-1', senderId: 'u2' });
    });

    expect(useNotificationActivityStore.getState().unreadCount).toBe(1);
    vi.mocked(document.hasFocus).mockRestore();
  });

  it('calls useRemoteStreaming with the shared ws', () => {
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    vi.mocked(useConversationWebSocket).mockReturnValue(
      mockWs as unknown as ReturnType<typeof useConversationWebSocket>
    );

    renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(useRemoteStreaming).toHaveBeenCalledWith(mockWs);
  });

  it('calls useTypingIndicators with ws', () => {
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    vi.mocked(useConversationWebSocket).mockReturnValue(
      mockWs as unknown as ReturnType<typeof useConversationWebSocket>
    );

    renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(useTypingIndicators).toHaveBeenCalledWith(mockWs);
  });

  it('returns typingUserIds in GroupChatProps', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.typingUserIds).toBe(mockTypingUserIds);
  });

  it('returns remoteStreamingMessages in GroupChatProps', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.remoteStreamingMessages).toBe(mockRemoteStreamingMap);
  });

  it('returns ws in GroupChatProps', () => {
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    vi.mocked(useConversationWebSocket).mockReturnValue(
      mockWs as unknown as ReturnType<typeof useConversationWebSocket>
    );

    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.ws).toBe(mockWs);
  });

  it('excludes link guest members from returned members array', () => {
    vi.mocked(useConversationMembers).mockReturnValue({
      data: {
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
          { id: 'm3', userId: null, linkId: 'l1', username: null, privilege: 'read' },
        ],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.members).toEqual([
      { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
      { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
    ]);
  });

  it('identifies a link guest by the link id the server serves on its member row', () => {
    vi.mocked(useConversationMembers).mockReturnValue({
      data: {
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm3', userId: null, linkId: 'l1', username: null, privilege: 'read' },
        ],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);
    vi.mocked(useConversationLinks).mockReturnValue({
      data: {
        links: [
          {
            id: 'l1',
            displayName: 'Guest 1',
            privilege: 'read',
            createdAt: isoAt(TEST_DAY_START),
          },
        ],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationLinks>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'l1'));

    expect(result.current).toBeDefined();
    expect(result.current!.currentUserId).toBe('l1');
    expect(result.current!.currentUserLinkId).toBe('l1');
    expect(result.current!.currentUserPrivilege).toBe('read');
    // Link guest should not appear in the display members — shown as LinkRow instead
    expect(result.current!.members).toEqual([
      { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
    ]);
  });

  it('does not identify a caller by a member row id', () => {
    vi.mocked(useConversationMembers).mockReturnValue({
      data: {
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm3', userId: null, linkId: 'l1', username: null, privilege: 'read' },
        ],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'm3'));

    expect(result.current).toBeUndefined();
  });

  it('re-computes epoch key when cache version changes', () => {
    // Initial render with cache version 0 — epoch key is fill(7)
    vi.mocked(getSnapshot).mockReturnValue(0);
    const { result, rerender } = renderHook(() => useGroupChat('conv-1', 'u1'));
    expect(result.current!.currentEpochKey?.privateKey).toEqual(new Uint8Array(32).fill(7));

    // Simulate cache update: new epoch key cached, version bumps
    const newKey = new Uint8Array(32).fill(42);
    vi.mocked(getEpochKey).mockReturnValue(newKey);
    vi.mocked(getSnapshot).mockReturnValue(1);

    rerender();

    expect(result.current!.currentEpochKey?.privateKey).toEqual(newKey);
  });
});
