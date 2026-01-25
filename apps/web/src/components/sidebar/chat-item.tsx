import * as React from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  cn,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@lome-chat/ui';
import { MessageSquare, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { useDeleteConversation, useUpdateConversation } from '@/hooks/chat';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { ROUTES } from '@/lib/routes';

interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

interface ChatItemProps {
  conversation: Conversation;
  isActive?: boolean;
}

interface DeleteConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  isPending: boolean;
  onConfirm: () => void;
}

function DeleteConversationDialog({
  open,
  onOpenChange,
  title,
  isPending,
  onConfirm,
}: Readonly<DeleteConversationDialogProps>): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete conversation?</DialogTitle>
          <DialogDescription>
            This will permanently delete &quot;{title}&quot;. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
            data-testid="cancel-delete-button"
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isPending}
            data-testid="confirm-delete-button"
          >
            {isPending ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RenameConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onValueChange: (value: string) => void;
  isPending: boolean;
  onConfirm: () => void;
}

function RenameConversationDialog({
  open,
  onOpenChange,
  value,
  onValueChange,
  isPending,
  onConfirm,
}: Readonly<RenameConversationDialogProps>): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename conversation</DialogTitle>
          <DialogDescription>Enter a new name for this conversation.</DialogDescription>
        </DialogHeader>
        <Input
          value={value}
          onChange={(e) => {
            onValueChange(e.target.value);
          }}
          placeholder="Conversation title"
          autoFocus
        />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
            data-testid="cancel-rename-button"
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={!value.trim() || isPending}
            data-testid="save-rename-button"
          >
            {isPending ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ChatItem({ conversation, isActive }: Readonly<ChatItemProps>): React.JSX.Element {
  const navigate = useNavigate();
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const setMobileSidebarOpen = useUIStore((state) => state.setMobileSidebarOpen);
  const isMobile = useIsMobile();
  const deleteConversation = useDeleteConversation();
  const updateConversation = useUpdateConversation();

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

  const handleConfirmDelete = (): void => {
    deleteConversation.mutate(conversation.id, {
      onSuccess: () => {
        setShowDeleteDialog(false);
        void navigate({ to: ROUTES.CHAT });
      },
    });
  };

  const handleConfirmRename = (): void => {
    if (renameValue.trim()) {
      updateConversation.mutate(
        { conversationId: conversation.id, data: { title: renameValue.trim() } },
        {
          onSuccess: () => {
            setShowRenameDialog(false);
          },
        }
      );
    }
  };

  const handleLinkClick = (): void => {
    if (isMobile) {
      setMobileSidebarOpen(false);
    }
  };

  return (
    <>
      <div
        className={cn(
          'group relative flex items-center overflow-hidden rounded-md',
          'hover:bg-sidebar-border/50 transition-colors',
          isActive && 'bg-sidebar-border',
          !sidebarOpen && 'justify-center'
        )}
      >
        <Link
          to={ROUTES.CHAT_ID}
          params={{ id: conversation.id }}
          data-testid="chat-link"
          onClick={handleLinkClick}
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
          {sidebarOpen && <span className="truncate">{conversation.title}</span>}
        </Link>

        {sidebarOpen && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-1 h-6 w-6 shrink-0"
                data-testid="chat-item-more-button"
                onClick={(e) => {
                  e.preventDefault();
                }}
              >
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">More options</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={handleRenameClick}>
                <Pencil className="mr-2 h-4 w-4" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleDeleteClick} className="text-destructive">
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <DeleteConversationDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title={conversation.title}
        isPending={deleteConversation.isPending}
        onConfirm={handleConfirmDelete}
      />

      <RenameConversationDialog
        open={showRenameDialog}
        onOpenChange={setShowRenameDialog}
        value={renameValue}
        onValueChange={setRenameValue}
        isPending={updateConversation.isPending}
        onConfirm={handleConfirmRename}
      />
    </>
  );
}
