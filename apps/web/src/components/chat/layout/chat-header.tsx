import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { EncryptionBadge } from '@/components/shared/encryption-badge';
import { PageHeader } from '@/components/shared/page-header';
import { MemberFacepile } from '@/components/chat/member/member-facepile';

interface ChatHeaderProps {
  title?: string | undefined;
  /** Whether the caller is signed in; a visitor's encryption badge offers sign-up. */
  isAuthenticated?: boolean | undefined;
  /** Members for facepile display (undefined = no group chat features shown).
   *  Link-guest members carry null userId/username (see GroupChatProps.members). */
  members?: { id: string; userId: string | null; username: string | null }[] | undefined;
  /** Set of online member IDs from WebSocket presence */
  onlineMemberIds?: Set<string> | undefined;
  /** Called when facepile is clicked (opens member list) */
  onFacepileClick?: (() => void) | undefined;
  /** Draws the New chat icon on phones; only the page knows it is a conversation. */
  showNewChat?: boolean;
  /** Follows the title; the conversation's branch switcher. */
  branchSwitcher?: React.ReactNode;
}

export function ChatHeader({
  title,
  isAuthenticated,
  members,
  onlineMemberIds,
  onFacepileClick,
  showNewChat = false,
  branchSwitcher,
}: Readonly<ChatHeaderProps>): React.JSX.Element {
  const showGroupFeatures = members !== undefined && members.length > 0;

  return (
    <PageHeader
      testId={TEST_IDS.chatHeader}
      titleTestId={TEST_IDS.chatTitle}
      title={title}
      showNewChat={showNewChat}
      center={branchSwitcher}
      shield={<EncryptionBadge isAuthenticated={isAuthenticated !== false} />}
      facepile={
        showGroupFeatures && (
          <MemberFacepile
            members={members}
            onlineMemberIds={onlineMemberIds ?? new Set()}
            onFacepileClick={
              onFacepileClick ??
              (() => {
                /* noop */
              })
            }
          />
        )
      }
    />
  );
}
