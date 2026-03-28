import * as React from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { cn, DropdownMenuItem } from '@hushbox/ui';
import { Bell, BellOff, Lock, LogOut, MessageSquare, Pencil, Trash2 } from 'lucide-react';
import { ItemRow } from '@/components/shared/item-row';
import { encryptMessageForStorage, getPublicKeyFromPrivate } from '@hushbox/crypto';
import { toBase64, ROUTES } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui';
import { useDeleteConversation, useUpdateConversation, DECRYPTING_TITLE } from '@/hooks/chat';
import { useLeaveConversation, useMuteConversation } from '@/hooks/use-conversation-members';
import { getEpochKey } from '@/lib/epoch-key-cache';
import { LeaveConfirmationModal } from '@/components/chat/leave-confirmation-modal';
import { DeleteConversationDialog } from './delete-conversation-dialog';
import { RenameConversationDialog } from './rename-conversation-dialog';
import type { ConversationListItem } from '@/lib/api';

interface ChatItemProps {
  conversation: ConversationListItem;
  isActive?: boolean;
}

function ChatItemTitle({ title }: Readonly<{ title: string }>): React.JSX.Element {
  if (title === DECRYPTING_TITLE) {
    return (
      <span
        className="text-muted-foreground flex items-center gap-1.5 truncate text-xs"
        data-testid="decrypting-title"
      >
        <Lock className="h-3 w-3 shrink-0" />
        Decrypting...
      </span>
    );
  }
  return <span className="truncate">{title}</span>;
}

function encryptTitle(
  conversationId: string,
  currentEpoch: number,
  rawTitle: string
): string | undefined {
  const trimmed = rawTitle.trim();
  if (!trimmed) return undefined;
  const epochPrivateKey = getEpochKey(conversationId, currentEpoch);
  if (!epochPrivateKey) return undefined;
  const epochPublicKey = getPublicKeyFromPrivate(epochPrivateKey);
  return toBase64(encryptMessageForStorage(epochPublicKey, trimmed));
}

export function ChatItem({ conversation, isActive }: Readonly<ChatItemProps>): React.JSX.Element {
  const navigate = useNavigate();
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const deleteConversation = useDeleteConversation();
  const updateConversation = useUpdateConversation();
  const leaveConversation = useLeaveConversation();
  const muteConversation = useMuteConversation();

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

  const handleMuteToggle = (): void => {
    muteConversation.mutate({
      conversationId: conversation.id,
      muted: !conversation.muted,
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
    const encrypted = encryptTitle(conversation.id, conversation.currentEpoch, renameValue);
    if (!encrypted) return;

    updateConversation.mutate(
      {
        conversationId: conversation.id,
        data: {
          title: encrypted,
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
          <>
            <DropdownMenuItem onSelect={handleMuteToggle}>
              {conversation.muted ? <Bell /> : <BellOff />}
              {conversation.muted ? 'Unmute' : 'Mute'}
            </DropdownMenuItem>
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
          </>
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
          {sidebarOpen ? (
            <ChatItemTitle title={conversation.title} />
          ) : (
            <MessageSquare
              data-testid="message-icon"
              className="h-4 w-4 shrink-0"
              aria-hidden="true"
            />
          )}
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
