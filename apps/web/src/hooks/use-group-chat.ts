import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { wrapEpochKeyForNewMember } from '@hushbox/crypto';
import { fromBase64, isOwner, toBase64, type StreamChatRotation } from '@hushbox/shared';
import { useAuthStore } from '../lib/auth.js';
import {
  useConversationMembers,
  useAddMember,
  useRemoveMember,
  useChangePrivilege,
  useLeaveConversation,
} from './use-conversation-members.js';
import {
  useConversationLinks,
  useRevokeLink,
  useChangeLinkPrivilege,
} from './use-conversation-links.js';
import { useConversationWebSocket } from './use-conversation-websocket.js';
import { usePresence } from './use-presence.js';
import { useRealtimeSync } from './use-realtime-sync.js';
import { useRemoteStreaming } from './use-remote-streaming.js';
import { useTypingIndicators } from './use-typing-indicators.js';
import { useAdminLinkName } from './use-link-name.js';
import { getCurrentEpoch, getEpochKey, subscribe, getSnapshot } from '../lib/epoch-key-cache.js';
import { executeWithRotation } from '../lib/rotation.js';
import type { MemberKeyResponse, RotationMember } from '../lib/rotation.js';
import type { GroupChatProps } from '../components/chat/chat-layout.js';

export function useGroupChat(
  conversationId: string | null,
  plaintextTitle?: string
): GroupChatProps | undefined {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const membersQuery = useConversationMembers(conversationId);
  const linksQuery = useConversationLinks(conversationId);
  const members = (membersQuery.data as { members: GroupChatProps['members'] } | undefined)
    ?.members;
  const isGroup = (members?.length ?? 0) > 1;
  const ws = useConversationWebSocket(isGroup ? conversationId : null);
  const presenceMap = usePresence(ws);
  useRealtimeSync(ws, conversationId, user?.id ?? null);
  const remoteStreamingMessages = useRemoteStreaming(ws, user?.id ?? null);
  const typingUserIds = useTypingIndicators(ws);

  const removeMember = useRemoveMember();
  const changePrivilege = useChangePrivilege();
  const revokeLink = useRevokeLink();
  const changeLinkPrivilege = useChangeLinkPrivilege();
  const leaveConversation = useLeaveConversation();
  const addMember = useAddMember();
  const adminLinkName = useAdminLinkName();

  // Subscribe to epoch key cache changes for reactivity
  const cacheVersion = React.useSyncExternalStore(subscribe, getSnapshot);

  const links = (linksQuery.data as { links: GroupChatProps['links'] } | undefined)?.links;

  // Stable refs for mutation functions to avoid re-creating callbacks
  const removeMemberRef = React.useRef(removeMember.mutateAsync);
  removeMemberRef.current = removeMember.mutateAsync;

  const changePrivilegeRef = React.useRef(changePrivilege.mutateAsync);
  changePrivilegeRef.current = changePrivilege.mutateAsync;

  const revokeLinkRef = React.useRef(revokeLink.mutateAsync);
  revokeLinkRef.current = revokeLink.mutateAsync;

  const changeLinkPrivilegeRef = React.useRef(changeLinkPrivilege.mutateAsync);
  changeLinkPrivilegeRef.current = changeLinkPrivilege.mutateAsync;

  const leaveRef = React.useRef(leaveConversation.mutateAsync);
  leaveRef.current = leaveConversation.mutateAsync;

  const addMemberRef = React.useRef(addMember.mutateAsync);
  addMemberRef.current = addMember.mutateAsync;

  const adminNameRef = React.useRef(adminLinkName.mutateAsync);
  adminNameRef.current = adminLinkName.mutateAsync;

  return React.useMemo((): GroupChatProps | undefined => {
    if (!conversationId || !members || !user) return undefined;

    const currentMember = members.find((m) => m.userId === user.id);
    if (!currentMember) return undefined;

    const epochNumber = getCurrentEpoch(conversationId);
    if (epochNumber === undefined) return undefined;
    const epochKey = getEpochKey(conversationId, epochNumber);
    if (!epochKey) return undefined;

    const onlineMemberIds = new Set<string>();
    for (const key of presenceMap.keys()) {
      onlineMemberIds.add(key);
    }

    return {
      conversationId,
      members: members.map((m) => ({
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
      })),
      onlineMemberIds,
      currentUserId: user.id,
      currentUserPrivilege: currentMember.privilege,
      currentEpochPrivateKey: epochKey,
      currentEpochNumber: epochNumber,
      typingUserIds,
      remoteStreamingMessages,
      ws: ws ?? undefined,
      onRemoveMember: (memberId: string): void => {
        const removedUserId = members.find((m) => m.id === memberId)?.userId;
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
        void executeWithRotation({
          conversationId,
          currentEpochPrivateKey: epochKey,
          currentEpochNumber: epochNumber,
          plaintextTitle: plaintextTitle ?? '',
          filterMembers: filter,
          execute: (rotation) => removeMemberRef.current({ conversationId, memberId, rotation }),
        });
      },
      onChangePrivilege: (memberId: string, newPrivilege: string): void => {
        void changePrivilegeRef.current({
          conversationId,
          memberId,
          privilege: newPrivilege,
        });
      },
      onRevokeLinkClick: (linkId: string): void => {
        const filter = (keys: MemberKeyResponse[]): RotationMember[] => {
          const result: RotationMember[] = [];
          for (const k of keys) {
            if (k.linkId !== linkId) result.push({ publicKey: fromBase64(k.publicKey) });
          }
          return result;
        };
        void executeWithRotation({
          conversationId,
          currentEpochPrivateKey: epochKey,
          currentEpochNumber: epochNumber,
          plaintextTitle: plaintextTitle ?? '',
          filterMembers: filter,
          execute: (rotation) => revokeLinkRef.current({ conversationId, linkId, rotation }),
        });
      },
      onSaveLinkName: (linkId: string, newName: string): void => {
        void adminNameRef.current({
          conversationId,
          linkId,
          displayName: newName,
        });
      },
      onChangeLinkPrivilege: (linkId: string, newPrivilege: string): void => {
        void changeLinkPrivilegeRef.current({
          conversationId,
          linkId,
          privilege: newPrivilege as 'read' | 'write',
        });
      },
      onLeave: (): void => {
        if (isOwner(currentMember.privilege)) {
          void (async (): Promise<void> => {
            await leaveRef.current({ conversationId });
            void navigate({ to: '/chat' });
          })();
        } else {
          const filter = (keys: MemberKeyResponse[]): RotationMember[] => {
            const result: RotationMember[] = [];
            for (const k of keys) {
              if (k.userId !== user.id) result.push({ publicKey: fromBase64(k.publicKey) });
            }
            return result;
          };
          const execute = (rotation: StreamChatRotation): Promise<unknown> =>
            leaveRef.current({ conversationId, rotation });
          void (async (): Promise<void> => {
            await executeWithRotation({
              conversationId,
              currentEpochPrivateKey: epochKey,
              currentEpochNumber: epochNumber,
              plaintextTitle: plaintextTitle ?? '',
              filterMembers: filter,
              execute,
            });
            void navigate({ to: '/chat' });
          })();
        }
      },
      onAddMember: (params: {
        userId: string;
        username: string;
        publicKey: string;
        privilege: string;
        giveFullHistory: boolean;
      }): void => {
        if (params.giveFullHistory) {
          const wrap = wrapEpochKeyForNewMember(epochKey, fromBase64(params.publicKey));
          void addMemberRef.current({
            conversationId,
            userId: params.userId,
            wrap: toBase64(wrap),
            privilege: params.privilege,
            giveFullHistory: true,
          });
        } else {
          const newMemberKey = fromBase64(params.publicKey);
          const filter = (keys: MemberKeyResponse[]): RotationMember[] => {
            const result: RotationMember[] = [];
            for (const k of keys) {
              result.push({ publicKey: fromBase64(k.publicKey) });
            }
            result.push({ publicKey: newMemberKey });
            return result;
          };
          void executeWithRotation({
            conversationId,
            currentEpochPrivateKey: epochKey,
            currentEpochNumber: epochNumber,
            plaintextTitle: plaintextTitle ?? '',
            filterMembers: filter,
            execute: (rotation) =>
              addMemberRef.current({
                conversationId,
                userId: params.userId,
                privilege: params.privilege,
                giveFullHistory: false,
                rotation,
              }),
          });
        }
      },
    };
  }, [
    conversationId,
    members,
    links,
    user,
    presenceMap,
    typingUserIds,
    remoteStreamingMessages,
    ws,
    navigate,
    cacheVersion,
  ]);
}
