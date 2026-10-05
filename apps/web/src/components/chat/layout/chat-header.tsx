import * as React from 'react';
import { displayUsername, TEST_IDS } from '@hushbox/shared';
import { EncryptionBadge } from '@/components/shared/encryption-badge';
import { PageHeader } from '@/components/shared/page-header';
import { MemberFacepile } from '@/components/chat/member/member-facepile';
import { MemberStrip } from '@/components/chat/member/member-strip';

interface ChatHeaderProps {
  title?: string | undefined;
  /** Whether the caller is signed in; a visitor's encryption badge offers sign-up. */
  isAuthenticated?: boolean | undefined;
  /** Members for facepile display (undefined = no group chat features shown).
   *  Link-guest members carry null userId/username (see GroupChatProps.members). */
  members?: { id: string; userId: string | null; username: string | null }[] | undefined;
  /** The user ids online, from WebSocket presence. */
  onlineMemberIds?: Set<string> | undefined;
  /** Seats in the conversation, read before its member list arrives. */
  memberCount?: number | undefined;
  /** The reader holds a link: its conversation seats the owner beside the guest. */
  isLinkGuest?: boolean | undefined;
  /** Draws the New chat icon on phones; only the page knows it is a conversation. */
  showNewChat?: boolean;
  /** Follows the title; the conversation's branch switcher. */
  branchSwitcher?: React.ReactNode;
}

/** Each member as the facepile and the strip draw them. */
function facesOf(
  members: ChatHeaderProps['members'],
  onlineMemberIds: Set<string> | undefined
): { name: string; online: boolean }[] {
  return (
    members?.map((member) => ({
      name: member.username === null ? 'Guest' : displayUsername(member.username),
      online: member.userId !== null && onlineMemberIds?.has(member.userId) === true,
    })) ?? []
  );
}

export function ChatHeader({
  title,
  isAuthenticated,
  members,
  onlineMemberIds,
  memberCount,
  isLinkGuest = false,
  showNewChat = false,
  branchSwitcher,
}: Readonly<ChatHeaderProps>): React.JSX.Element {
  const faces = facesOf(members, onlineMemberIds);
  const showGroupFeatures = faces.length > 0;
  // A group holds its strip row from first paint; a solo conversation draws none.
  const isGroup = isLinkGuest || faces.length > 1 || (memberCount ?? 0) > 1;

  return (
    <PageHeader
      testId={TEST_IDS.chatHeader}
      titleTestId={TEST_IDS.chatTitle}
      title={title}
      showNewChat={showNewChat}
      center={branchSwitcher}
      shield={<EncryptionBadge isAuthenticated={isAuthenticated !== false} />}
      facepile={showGroupFeatures && <MemberFacepile members={faces} />}
      strip={isGroup && <MemberStrip members={showGroupFeatures ? faces : undefined} />}
    />
  );
}
