import type { MemberPrivilege } from '@hushbox/shared';
import type { PhantomMessage } from '@/hooks/realtime/use-remote-streaming';
import type { ConversationWebSocket } from '@/lib/ws-client';

/** Imperative handle exposed by the prompt input for programmatic focus. */
export interface PromptInputRef {
  focus: () => void;
}

export interface GroupChatProps {
  readonly conversationId: string;
  readonly members: {
    id: string;
    userId: string;
    username: string;
    privilege: string;
  }[];
  readonly links: {
    id: string;
    displayName: string | null;
    privilege: string;
    createdAt: string;
  }[];
  readonly onlineMemberIds: Set<string>;
  readonly currentUserId: string;
  readonly currentUserLinkId: string | null;
  readonly currentUserPrivilege: MemberPrivilege;
  readonly currentEpochPrivateKey: Uint8Array;
  readonly currentEpochNumber: number;
  readonly typingUserIds?: Set<string> | undefined;
  readonly remoteStreamingMessages?: Map<string, PhantomMessage> | undefined;
  readonly ws?: ConversationWebSocket | undefined;
  readonly onRemoveMember?: ((memberId: string) => void | Promise<void>) | undefined;
  readonly onChangePrivilege?:
    | ((memberId: string, newPrivilege: string) => void | Promise<void>)
    | undefined;
  readonly onRevokeLinkClick?: ((linkId: string) => void | Promise<void>) | undefined;
  readonly onSaveLinkName?: ((linkId: string, newName: string) => void | Promise<void>) | undefined;
  readonly onChangeLinkPrivilege?:
    | ((linkId: string, newPrivilege: string) => void | Promise<void>)
    | undefined;
  readonly onAddMember?:
    | ((params: {
        userId: string;
        username: string;
        publicKey: string;
        privilege: string;
        giveFullHistory: boolean;
      }) => void | Promise<void>)
    | undefined;
  readonly onLeave?: (() => void | Promise<void>) | undefined;
}
