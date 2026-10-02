import type { MemberPrivilege } from '@hushbox/shared';
import type { PhantomMessage } from '@/hooks/realtime/use-remote-streaming';
import type { ConversationWebSocket } from '@/lib/api/ws-client';

/** Imperative handle exposed by the prompt input for programmatic focus. */
export interface PromptInputRef {
  focus: () => void;
}

/** A verified key for the conversation's current epoch, with that epoch's number. */
export interface CurrentEpochKey {
  readonly epochNumber: number;
  readonly privateKey: Uint8Array;
}

export interface GroupChatProps {
  readonly conversationId: string;
  // A link-guest member has no user account: the backend `members.ts` types
  // `username` nullable, and the users left-join yields a null `userId`. This
  // shape is the source of truth for every member consumer below.
  readonly members: {
    id: string;
    userId: string | null;
    username: string | null;
    privilege: string;
  }[];
  readonly links: {
    id: string;
    displayName: string | null;
    privilege: string;
    createdAt: string;
    // The member seated through this link; null until the members read holds it.
    memberId: string | null;
  }[];
  readonly onlineMemberIds: Set<string>;
  readonly currentUserId: string;
  readonly currentUserLinkId: string | null;
  readonly currentUserPrivilege: MemberPrivilege;
  // Absent while no verified key for the current epoch is cached; every action
  // that encrypts to that epoch is refused until one is.
  readonly currentEpochKey?: CurrentEpochKey | undefined;
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
