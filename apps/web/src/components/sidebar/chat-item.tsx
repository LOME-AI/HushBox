import * as React from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  cn,
  IconButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@hushbox/ui';
import { Lock, LogOut, MessageSquare, MoreVertical, Pencil, Trash2 } from 'lucide-react';
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
      <div
        className={cn(
          'group relative flex items-center overflow-hidden rounded-md',
          '[&:hover:not(:has(button:hover))]:bg-sidebar-border/50 transition-colors',
          isActive && 'bg-sidebar-border',
          !sidebarOpen && 'justify-center'
        )}
      >
        <Link
          to={ROUTES.CHAT_ID}
          params={{ id: conversation.id }}
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

        {sidebarOpen && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                className="absolute right-1"
                data-testid="chat-item-more-button"
                onClick={(e) => {
                  e.preventDefault();
                }}
              >
                <MoreVertical className="h-4 w-4" />
                <span className="sr-only">More options</span>
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isOwner ? (
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
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
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
