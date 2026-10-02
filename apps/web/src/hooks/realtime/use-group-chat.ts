import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { getPublicKeyFromPrivate, wrapEpochKeyForNewMember } from '@hushbox/crypto';
import { fromBase64, toBase64 } from '@hushbox/shared';
import {
  useConversationMembers,
  useAddMember,
  useRemoveMember,
  useChangePrivilege,
  useLeaveConversation,
} from '@/hooks/realtime/use-conversation-members.js';
import {
  useConversationLinks,
  useRevokeLink,
  useChangeLinkPrivilege,
} from '@/hooks/realtime/use-conversation-links.js';
import { useConversationWebSocket } from '@/hooks/realtime/use-conversation-websocket.js';
import { usePresence } from '@/hooks/realtime/use-presence.js';
import { useRealtimeSync } from '@/hooks/realtime/use-realtime-sync.js';
import { useRemoteStreaming } from '@/hooks/realtime/use-remote-streaming.js';
import { useTypingIndicators } from '@/hooks/realtime/use-typing-indicators.js';
import { useAdminLinkName } from '@/hooks/realtime/use-link-name.js';
import { accountMembers } from '@/hooks/chat/conversation-identity';
import { useConversationActivity } from '@/hooks/notifications/use-conversation-activity.js';
import {
  getCurrentEpoch,
  getEpochKey,
  getEpochVerdict,
  subscribe,
  getSnapshot,
} from '@/lib/crypto/epoch-key-cache.js';
import { leaveConversation } from '@/lib/chat/leave-conversation.js';
import { executeWithRotation, UnverifiedKeyChainError } from '@/lib/crypto/rotation.js';
import type { MemberKeyResponse, RotationMember } from '@/lib/crypto/rotation.js';
import type { CurrentEpochKey, GroupChatProps } from '@/components/chat/message/types.js';

type RawMember = NonNullable<ReturnType<typeof useConversationMembers>['data']>['members'][number];

/** A terminal access-revoked response (link revoked, member removed, gone). */
function isAccessRevokedStatus(status: unknown): boolean {
  return status === 401 || status === 403 || status === 404;
}

interface MemoPrerequisites {
  conversationId: string;
  callerId: string;
  allMembers: RawMember[];
  currentMember: RawMember;
}

/** The current epoch's key, when a verified one is cached. */
function readCurrentEpochKey(conversationId: string): CurrentEpochKey | undefined {
  const epochNumber = getCurrentEpoch(conversationId);
  if (epochNumber === undefined) return undefined;
  const privateKey = getEpochKey(conversationId, epochNumber);
  if (!privateKey) return undefined;
  return { epochNumber, privateKey };
}

/**
 * The key a key-dependent action (remove, revoke, add, mint) builds on, or
 * `UnverifiedKeyChainError` before any request. A bad verdict refuses even a verified
 * key: its chain link failed, and only a recovery rotation may build on it. Falling back
 * to an older verified key is not an option: a member added or a link minted under it
 * would be seated on an epoch the server has moved past.
 */
export function requireCurrentEpochKey(
  conversationId: string,
  currentEpochKey: CurrentEpochKey | undefined
): CurrentEpochKey {
  if (!currentEpochKey || getEpochVerdict(conversationId)?.rotation === 'bad') {
    throw new UnverifiedKeyChainError();
  }
  return currentEpochKey;
}

/** Validates all prerequisites needed by the useMemo callback. */
function resolveMemoPrerequisites(
  conversationId: string | null,
  allMembers: RawMember[] | undefined,
  callerId: string | undefined
): MemoPrerequisites | undefined {
  if (!conversationId || !allMembers || !callerId) return undefined;

  // A signed-in caller matches its member row by account id; a link guest has
  // none and matches by the link it joined through, which is the identity the
  // conversation read hands it. The member row's own id is deliberately not an
  // arm of this match: it is the identity no other consumer uses for a guest —
  // message sender ids, the realtime principal id and the realtime self-checks
  // are all the link id — so matching on it would find the row and mis-key
  // everything downstream of it.
  const currentMember = allMembers.find((m) => m.userId === callerId || m.linkId === callerId);
  if (!currentMember) return undefined;

  return { conversationId, callerId, allMembers, currentMember };
}

export function useGroupChat(
  conversationId: string | null,
  callerId: string | undefined,
  plaintextTitle?: string
): GroupChatProps | undefined {
  const navigate = useNavigate();

  const membersQuery = useConversationMembers(conversationId);
  const linksQuery = useConversationLinks(conversationId);
  const allMembers = membersQuery.data?.members;
  const isGroup = (allMembers?.length ?? 0) > 1;
  // Tie the realtime socket to access. TanStack keeps the last members list on
  // error, so a terminal 401/403/404 (link revoked / member removed) would
  // otherwise leave `isGroup` true and the socket retrying a handshake that can
  // never succeed — each failed reconnect logs a browser error. Drop the socket
  // the moment access is gone; 4xx is terminal (the query layer never retries it).
  // Keyed on the members query — the canonical access signal for both members
  // and link guests (both fetch `/api/members/:id`).
  const accessRevoked = isAccessRevokedStatus(
    (membersQuery.error as { status?: unknown } | null)?.status
  );
  const ws = useConversationWebSocket(isGroup && !accessRevoked ? conversationId : null);
  const presenceMap = usePresence(ws);
  useConversationActivity(ws, callerId ?? null);
  useRealtimeSync(ws, conversationId, callerId ?? null);
  const remoteStreamingMessages = useRemoteStreaming(ws);
  const typingUserIds = useTypingIndicators(ws);

  const removeMember = useRemoveMember();
  const changePrivilege = useChangePrivilege();
  const revokeLink = useRevokeLink();
  const changeLinkPrivilege = useChangeLinkPrivilege();
  const leaveMutation = useLeaveConversation();
  const addMember = useAddMember();
  const adminLinkName = useAdminLinkName();

  // Subscribe to epoch key cache changes for reactivity
  const cacheVersion = React.useSyncExternalStore(subscribe, getSnapshot);

  const links = linksQuery.data?.links;

  // Stable refs for mutation functions to avoid re-creating callbacks
  const removeMemberRef = React.useRef(removeMember.mutateAsync);
  removeMemberRef.current = removeMember.mutateAsync;

  const changePrivilegeRef = React.useRef(changePrivilege.mutateAsync);
  changePrivilegeRef.current = changePrivilege.mutateAsync;

  const revokeLinkRef = React.useRef(revokeLink.mutateAsync);
  revokeLinkRef.current = revokeLink.mutateAsync;

  const changeLinkPrivilegeRef = React.useRef(changeLinkPrivilege.mutateAsync);
  changeLinkPrivilegeRef.current = changeLinkPrivilege.mutateAsync;

  const leaveRef = React.useRef(leaveMutation.mutateAsync);
  leaveRef.current = leaveMutation.mutateAsync;

  const addMemberRef = React.useRef(addMember.mutateAsync);
  addMemberRef.current = addMember.mutateAsync;

  const adminNameRef = React.useRef(adminLinkName.mutateAsync);
  adminNameRef.current = adminLinkName.mutateAsync;

  return React.useMemo((): GroupChatProps | undefined => {
    const prereqs = resolveMemoPrerequisites(conversationId, allMembers, callerId);
    if (!prereqs) return undefined;
    const {
      conversationId: resolvedConversationId,
      callerId: resolvedCallerId,
      allMembers: resolvedMembers,
      currentMember,
    } = prereqs;
    const currentEpochKey = readCurrentEpochKey(resolvedConversationId);
    const requireKey = (): CurrentEpochKey =>
      requireCurrentEpochKey(resolvedConversationId, currentEpochKey);

    const onlineMemberIds = new Set<string>();
    for (const key of presenceMap.keys()) {
      onlineMemberIds.add(key);
    }

    // Filter out link guest members — they are displayed via the links array instead
    const displayMembers = accountMembers(resolvedMembers);
    const memberIdByLinkId = new Map<string, string>();
    for (const m of resolvedMembers) {
      if (m.linkId) memberIdByLinkId.set(m.linkId, m.id);
    }

    return {
      conversationId: resolvedConversationId,
      members: displayMembers.map((m) => ({
        id: m.id,
        userId: m.userId,
        username: m.username,
        privilege: m.privilege,
      })),
      links: (links ?? []).map((l) => ({
        id: l.id,
        displayName: l.displayName,
        privilege: l.privilege,
        createdAt: l.createdAt,
        memberId: memberIdByLinkId.get(l.id) ?? null,
      })),
      onlineMemberIds,
      currentUserId: resolvedCallerId,
      currentUserLinkId: currentMember.linkId,
      currentUserPrivilege: currentMember.privilege,
      currentEpochKey,
      typingUserIds,
      remoteStreamingMessages,
      ws: ws ?? undefined,
      onRemoveMember: async (memberId: string): Promise<void> => {
        const { epochNumber, privateKey } = requireKey();
        const removedUserId = resolvedMembers.find((m) => m.id === memberId)?.userId;
        const filter = (keys: MemberKeyResponse[]): RotationMember[] => {
          const result: RotationMember[] = [];
          for (const k of keys) {
            if (
              k.memberId !== memberId &&
              (removedUserId === undefined || k.userId !== removedUserId)
            ) {
              result.push({ publicKey: fromBase64(k.publicKey) });
            }
          }
          return result;
        };
        await executeWithRotation({
          conversationId: resolvedConversationId,
          currentEpochPrivateKey: privateKey,
          currentEpochNumber: epochNumber,
          plaintextTitle: plaintextTitle ?? '',
          filterMembers: filter,
          execute: (rotation) =>
            removeMemberRef.current({ conversationId: resolvedConversationId, memberId, rotation }),
        });
      },
      onChangePrivilege: async (memberId: string, newPrivilege: string): Promise<void> => {
        await changePrivilegeRef.current({
          conversationId: resolvedConversationId,
          memberId,
          privilege: newPrivilege,
        });
      },
      onRevokeLinkClick: async (linkId: string): Promise<void> => {
        const { epochNumber, privateKey } = requireKey();
        const filter = (keys: MemberKeyResponse[]): RotationMember[] => {
          const result: RotationMember[] = [];
          for (const k of keys) {
            if (k.linkId !== linkId) result.push({ publicKey: fromBase64(k.publicKey) });
          }
          return result;
        };
        await executeWithRotation({
          conversationId: resolvedConversationId,
          currentEpochPrivateKey: privateKey,
          currentEpochNumber: epochNumber,
          plaintextTitle: plaintextTitle ?? '',
          filterMembers: filter,
          execute: (rotation) =>
            revokeLinkRef.current({ conversationId: resolvedConversationId, linkId, rotation }),
        });
      },
      onSaveLinkName: async (linkId: string, newName: string): Promise<void> => {
        await adminNameRef.current({
          conversationId: resolvedConversationId,
          linkId,
          displayName: newName,
        });
      },
      onChangeLinkPrivilege: async (linkId: string, newPrivilege: string): Promise<void> => {
        await changeLinkPrivilegeRef.current({
          conversationId: resolvedConversationId,
          linkId,
          privilege: newPrivilege as 'read' | 'write',
        });
      },
      onLeave: async (): Promise<void> => {
        await leaveConversation({
          conversationId: resolvedConversationId,
          leave: leaveRef.current,
        });
        void navigate({ to: '/chat' });
      },
      onAddMember: async (params: {
        userId: string;
        username: string;
        publicKey: string;
        privilege: string;
        giveFullHistory: boolean;
      }): Promise<void> => {
        const { epochNumber, privateKey } = requireKey();
        if (params.giveFullHistory) {
          const wrap = wrapEpochKeyForNewMember(privateKey, fromBase64(params.publicKey), {
            conversationId: resolvedConversationId,
            epochNumber,
            epochPublicKey: getPublicKeyFromPrivate(privateKey),
          });
          await addMemberRef.current({
            conversationId: resolvedConversationId,
            userId: params.userId,
            wrap: toBase64(wrap),
            privilege: params.privilege,
            giveFullHistory: true,
            expectedEpoch: epochNumber,
          });
          return;
        }
        const newMemberKey = fromBase64(params.publicKey);
        const filter = (keys: MemberKeyResponse[]): RotationMember[] => {
          const result: RotationMember[] = [];
          for (const k of keys) {
            result.push({ publicKey: fromBase64(k.publicKey) });
          }
          result.push({ publicKey: newMemberKey });
          return result;
        };
        await executeWithRotation({
          conversationId: resolvedConversationId,
          currentEpochPrivateKey: privateKey,
          currentEpochNumber: epochNumber,
          plaintextTitle: plaintextTitle ?? '',
          filterMembers: filter,
          execute: (rotation) =>
            addMemberRef.current({
              conversationId: resolvedConversationId,
              userId: params.userId,
              privilege: params.privilege,
              giveFullHistory: false,
              rotation,
            }),
        });
      },
    };
  }, [
    conversationId,
    allMembers,
    links,
    callerId,
    presenceMap,
    typingUserIds,
    remoteStreamingMessages,
    ws,
    navigate,
    cacheVersion,
  ]);
}
