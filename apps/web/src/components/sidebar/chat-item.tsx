import * as React from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { cn, DropdownMenuItem } from '@hushbox/ui';
import { Lock, LogOut, MessageSquare, Pencil, Trash2 } from 'lucide-react';
import { ItemRow } from '@/components/shared/item-row';
import { encryptMessageForStorage, getPublicKeyFromPrivate } from '@hushbox/crypto';
import { toBase64, ROUTES } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui';
import { useDeleteConversation, useUpdateConversation, DECRYPTING_TITLE } from '@/hooks/chat';
import { useLeaveConversation } from '@/hooks/use-conversation-members';
import { getEpochKey } from '@/lib/epoch-key-cache';
import { LeaveConfirmationModal } from '@/components/chat/leave-confirmation-modal';
import { DeleteConversationDialog } from './delete-conversation-dialog';
import { RenameConversationDialog } from './rename-conversation-dialog';

interface Conversation {
  id: string;
  title: string;
  currentEpoch: number;
  updatedAt: string;
  privilege: string;
}

interface ChatItemProps {
  conversation: Conversation;
  isActive?: boolean;
}

export function ChatItem({ conversation, isActive }: Readonly<ChatItemProps>): React.JSX.Element {
  const navigate = useNavigate();
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const deleteConversation = useDeleteConversation();
  const updateConversation = useUpdateConversation();
  const leaveConversation = useLeaveConversation();

  const isOwner = conversation.privilege === 'owner';

  const [showDeleteDialog, setShowDeleteDialog] = React.useState(false);
  const [showRenameDialog, setShowRenameDialog] = React.useState(false);
  const [showLeaveDialog, setShowLeaveDialog] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState(conversation.title);

  const handleDeleteClick = (): void => {
    setShowDeleteDialog(true);
  };

  const handleRenameClick = (): void => {
    setRenameValue(conversation.title);
    setShowRenameDialog(true);
  };

  const handleConfirmDelete = (): void => {
    deleteConversation.mutate(conversation.id, {
      onSuccess: () => {
        setShowDeleteDialog(false);
        void navigate({ to: ROUTES.CHAT });
      },
    });
  };

  const handleLeaveClick = (): void => {
    setShowLeaveDialog(true);
  };

  const handleConfirmLeave = (): void => {
    leaveConversation.mutate(
      { conversationId: conversation.id },
      {
        onSuccess: () => {
          setShowLeaveDialog(false);
          void navigate({ to: ROUTES.CHAT });
        },
      }
    );
  };

  const handleConfirmRename = (): void => {
    const trimmed = renameValue.trim();
    if (!trimmed) return;

    const epochPrivateKey = getEpochKey(conversation.id, conversation.currentEpoch);
    if (!epochPrivateKey) return;

    const epochPublicKey = getPublicKeyFromPrivate(epochPrivateKey);
    const encryptedBytes = encryptMessageForStorage(epochPublicKey, trimmed);

    updateConversation.mutate(
      {
        conversationId: conversation.id,
        data: {
          title: toBase64(encryptedBytes),
          titleEpochNumber: conversation.currentEpoch,
        },
      },
      {
        onSuccess: () => {
          setShowRenameDialog(false);
        },
      }
    );
  };

  return (
    <>
      <ItemRow
        className={cn(
          '[&:hover:not(:has([data-menu-trigger]:hover))]:bg-sidebar-border/50',
          isActive && 'bg-sidebar-border',
          !sidebarOpen && 'justify-center'
        )}
        showMenu={sidebarOpen}
        menuProps={{
          className: 'absolute right-1',
          'data-testid': 'chat-item-more-button',
          onClick: (e) => {
            e.preventDefault();
          },
        }}
        menuContent={
          isOwner ? (
            <>
              <DropdownMenuItem onSelect={handleRenameClick}>
                <Pencil />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleDeleteClick} className="text-destructive">
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem onSelect={handleLeaveClick} className="text-destructive">
              <LogOut />
              Leave
            </DropdownMenuItem>
          )
        }
      >
        <Link
          to={ROUTES.CHAT_ID}
          params={{ id: conversation.id }}
          search={{ fork: undefined }}
          data-testid="chat-link"
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm',
            !sidebarOpen && 'justify-center px-0',
            sidebarOpen && 'pr-8'
          )}
        >
          {!sidebarOpen && (
            <MessageSquare
              data-testid="message-icon"
              className="h-4 w-4 shrink-0"
              aria-hidden="true"
            />
          )}
          {sidebarOpen &&
            (conversation.title === DECRYPTING_TITLE ? (
              <span
                className="text-muted-foreground flex items-center gap-1.5 truncate text-xs"
                data-testid="decrypting-title"
              >
                <Lock className="h-3 w-3 shrink-0" />
                Decrypting...
              </span>
            ) : (
              <span className="truncate">{conversation.title}</span>
            ))}
        </Link>
      </ItemRow>

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
        onValueChange={setRenameValue}
        onConfirm={handleConfirmRename}
      />

      <LeaveConfirmationModal
        open={showLeaveDialog}
        onOpenChange={setShowLeaveDialog}
        isOwner={false}
        onConfirm={handleConfirmLeave}
      />
    </>
  );
}
