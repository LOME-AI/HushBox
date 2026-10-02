import * as React from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { cn } from '@hushbox/ui';
import { IconButton } from '@hushbox/ui/button';
import {
  Bell,
  BellOff,
  Ellipsis,
  Lock,
  LogOut,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  Users,
} from '@hushbox/ui/icons';
import { Menu, MenuItem } from '@hushbox/ui/menu';
import { encryptTextForEpoch, getPublicKeyFromPrivate } from '@hushbox/crypto';
import {
  toBase64,
  ROUTES,
  TEST_IDS,
  TEST_ID_BUILDERS,
  type ConversationListItem,
} from '@hushbox/shared';
import { useDeleteConversation, useUpdateConversation, DECRYPTING_TITLE } from '@/hooks/chat/chat';
import { useMuteConversation, usePinConversation } from '@/hooks/realtime/use-conversation-members';
import { getEpochKey, getEpochVerdict } from '@/lib/crypto/epoch-key-cache';
import { UnverifiedKeyChainError } from '@/lib/crypto/rotation';
import { clampConversationTitle } from '@/lib/chat/conversation-title';
import { DeleteConversationDialog } from './delete-conversation-dialog';
import { RenameConversationDialog } from './rename-conversation-dialog';
import { useRequestLeave } from './leave-conversation-controller';

// Subset of the API conversation list-item we render in the sidebar. Pulling
// the shape from the shared schema keeps `privilege` typed as `MemberPrivilege`
// — a stringly-typed local would let an invalid value silently drift past TS.
// Exported so parent components (chat-list, sidebar-content) share the same
// definition rather than declaring their own widened copies.
export type SidebarConversation = Pick<
  ConversationListItem,
  'id' | 'title' | 'currentEpoch' | 'updatedAt' | 'privilege' | 'muted' | 'pinned' | 'memberCount'
>;

interface ChatItemProps {
  conversation: SidebarConversation;
  isActive?: boolean;
  /** A conversation with other members, marked with the users icon. */
  isGroup?: boolean;
}

// Hidden at rest, not removed: the trigger keeps its place in the tab order, and a finger has
// no hover to reveal it with.
const TRIGGER_REVEAL =
  'opacity-0 group-hover/row:opacity-100 group-has-focus-visible/row:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100';

function rowClass(isActive: boolean): string {
  return cn(
    'text-ui-sm h-9 pr-2.5 pointer-coarse:h-11',
    isActive
      ? 'bg-background-subtle before:bg-brand-red font-semibold before:absolute before:top-1/2 before:left-1.75 before:size-1.5 before:-translate-y-1/2 before:rounded-full'
      : 'hover:bg-accent'
  );
}

function ChatItemTitle({ title }: Readonly<{ title: string }>): React.JSX.Element {
  if (title === DECRYPTING_TITLE) {
    return (
      <span
        className="text-muted-foreground flex items-center gap-1.5 truncate text-xs"
        data-testid={TEST_IDS.decryptingTitle}
      >
        <Lock className="h-3 w-3 shrink-0" />
        Decrypting...
      </span>
    );
  }
  return <span className="min-w-0 flex-1 truncate">{title}</span>;
}

function encryptTitle(
  conversationId: string,
  currentEpoch: number,
  rawTitle: string
): string | undefined {
  const trimmed = rawTitle.trim();
  /* v8 ignore next -- RenameConversationDialog disables its save button on `!value.trim()`, so encryptTitle is never reached with an empty title; this is a defensive double-check */
  if (!trimmed) return undefined;
  const epochPrivateKey = getEpochKey(conversationId, currentEpoch);
  if (!epochPrivateKey) return undefined;
  const epochPublicKey = getPublicKeyFromPrivate(epochPrivateKey);
  return toBase64(
    encryptTextForEpoch(epochPublicKey, trimmed, { conversationId, epochNumber: currentEpoch })
  );
}

function ChatItemMenuContent({
  conversation,
  onDelete,
  onRename,
  onLeave,
}: Readonly<{
  conversation: SidebarConversation;
  onDelete: () => void;
  onRename: () => void;
  onLeave: () => void;
}>): React.JSX.Element {
  const muteConversation = useMuteConversation();
  const pinConversation = usePinConversation();
  const isOwner = conversation.privilege === 'owner';

  const handlePinToggle = (): void => {
    pinConversation.mutate({
      conversationId: conversation.id,
      pinned: !conversation.pinned,
    });
  };

  const handleMuteToggle = (): void => {
    muteConversation.mutate({
      conversationId: conversation.id,
      muted: !conversation.muted,
    });
  };

  return (
    <>
      <MenuItem
        icon={conversation.pinned ? PinOff : Pin}
        title={conversation.pinned ? 'Unpin' : 'Pin'}
        onSelect={handlePinToggle}
      />
      <MenuItem
        icon={conversation.muted ? Bell : BellOff}
        title={conversation.muted ? 'Unmute' : 'Mute'}
        onSelect={handleMuteToggle}
      />
      {isOwner ? (
        <>
          <MenuItem icon={Pencil} title="Rename" onSelect={onRename} />
          <MenuItem icon={Trash2} title="Delete" tone="danger" onSelect={onDelete} />
        </>
      ) : (
        <MenuItem icon={LogOut} title="Leave" tone="danger" onSelect={onLeave} />
      )}
    </>
  );
}

// Memoized so a sidebar-search keystroke (which recreates the filtered array
// but keeps each conversation object reference stable) doesn't re-render every
// row. Shallow prop comparison suffices given the stable references.
export const ChatItem = React.memo(function ChatItem({
  conversation,
  isActive = false,
  isGroup = false,
}: Readonly<ChatItemProps>): React.JSX.Element {
  const navigate = useNavigate();
  const deleteConversation = useDeleteConversation();
  const updateConversation = useUpdateConversation();
  const requestLeave = useRequestLeave();

  const [showDeleteDialog, setShowDeleteDialog] = React.useState(false);
  const [showRenameDialog, setShowRenameDialog] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState(conversation.title);

  const handleDeleteClick = (): void => {
    setShowDeleteDialog(true);
  };

  const handleRenameClick = (): void => {
    setRenameValue(conversation.title);
    setShowRenameDialog(true);
  };

  const handleConfirmDelete = async (): Promise<unknown> => {
    const result = await deleteConversation.mutateAsync(conversation.id);
    void navigate({ to: ROUTES.CHAT });
    return result;
  };

  const handleLeaveClick = (): void => {
    // The confirmation modal and its leave flow are owned by
    // LeaveConversationProvider, a stable ancestor of this row. Leaving drops
    // this conversation from the sidebar list and unmounts this ChatItem, so a
    // row-owned modal would unmount mid-close (stuck vaul portal on touch).
    requestLeave(conversation, isActive);
  };

  const handleConfirmRename = async (): Promise<unknown> => {
    // A title encrypted to a rotation that failed verification is readable by whoever built it.
    if (getEpochVerdict(conversation.id)?.rotation === 'bad') throw new UnverifiedKeyChainError();
    const encrypted = encryptTitle(conversation.id, conversation.currentEpoch, renameValue);
    if (!encrypted) return;

    return updateConversation.mutateAsync({
      conversationId: conversation.id,
      data: {
        title: encrypted,
        titleEpochNumber: conversation.currentEpoch,
      },
    });
  };

  return (
    <>
      <div
        data-testid={TEST_ID_BUILDERS.conversationRow(conversation.id)}
        className={cn(
          'group/row relative flex items-center rounded-md transition-colors',
          rowClass(isActive)
        )}
      >
        <Link
          to={ROUTES.CHAT_ID}
          params={{ id: conversation.id }}
          search={{ fork: undefined }}
          data-testid={TEST_IDS.chatLink}
          className="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md pr-2 pl-4.5"
        >
          <ChatItemTitle title={conversation.title} />
          {isGroup && (
            <Users aria-hidden="true" className="text-muted-foreground size-3.5 shrink-0" />
          )}
        </Link>
        <Menu
          title={conversation.title}
          trigger={
            <IconButton
              aria-label={`More for ${conversation.title}`}
              icon={Ellipsis}
              size="2xs"
              hitArea="extend"
              data-testid={TEST_IDS.chatItemMoreButton}
              className={cn('text-muted-foreground -mr-1.5', TRIGGER_REVEAL)}
            />
          }
        >
          <ChatItemMenuContent
            conversation={conversation}
            onDelete={handleDeleteClick}
            onRename={handleRenameClick}
            onLeave={handleLeaveClick}
          />
        </Menu>
      </div>

      <DeleteConversationDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title={conversation.title}
        onConfirm={handleConfirmDelete}
      />

      <RenameConversationDialog
        open={showRenameDialog}
        onOpenChange={setShowRenameDialog}
        value={renameValue}
        // Clamped here rather than inside the dialog: the same dialog renames
        // forks, whose name is a plaintext field with its own, different cap.
        onValueChange={(next) => {
          setRenameValue(clampConversationTitle(next));
        }}
        onConfirm={handleConfirmRename}
      />
    </>
  );
});
