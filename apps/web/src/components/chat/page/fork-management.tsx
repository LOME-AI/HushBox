import * as React from 'react';
import { useAsyncAction } from '@hushbox/ui';
import { useCreateFork, useDeleteFork, useRenameFork } from '@/hooks/chat/forks';
import { RenameConversationDialog } from '@/components/sidebar/rename-conversation-dialog';
import { DeleteConversationDialog } from '@/components/sidebar/delete-conversation-dialog';

interface ForkSummary {
  id: string;
  name: string;
}

export interface ForkManagement {
  renamingFork: { id: string; name: string } | null;
  setRenamingFork: React.Dispatch<React.SetStateAction<{ id: string; name: string } | null>>;
  renameValue: string;
  setRenameValue: React.Dispatch<React.SetStateAction<string>>;
  deletingFork: { id: string; name: string } | null;
  setDeletingFork: React.Dispatch<React.SetStateAction<{ id: string; name: string } | null>>;
  handleForkSelect: (forkId: string) => void;
  handleForkRename: (forkId: string, currentName: string) => void;
  handleConfirmRename: () => Promise<unknown>;
  handleForkDelete: (forkId: string) => void;
  handleConfirmDelete: () => Promise<unknown>;
  handleForkFromMessage: (messageId: string) => void;
}

export function useForkManagement(
  conversationId: string | null,
  forksList: readonly ForkSummary[],
  activeForkId: string | null,
  setActiveFork: (id: string | null) => void
): ForkManagement {
  const createFork = useCreateFork();
  const deleteFork = useDeleteFork();
  const renameFork = useRenameFork();
  const { run: runCreateFork } = useAsyncAction({ fallback: 'toast' });

  const [renamingFork, setRenamingFork] = React.useState<{ id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [deletingFork, setDeletingFork] = React.useState<{ id: string; name: string } | null>(null);

  const handleForkSelect = React.useCallback(
    (forkId: string): void => {
      setActiveFork(forkId);
    },
    [setActiveFork]
  );

  const handleForkRename = React.useCallback((forkId: string, currentName: string): void => {
    setRenamingFork({ id: forkId, name: currentName });
    setRenameValue(currentName);
  }, []);

  const handleConfirmRename = React.useCallback((): Promise<unknown> => {
    const name = renameValue.trim();
    /* v8 ignore next 3 -- the rename dialog opens only for a fork on a loaded conversation and disables Save on a blank name, so this guard is unreachable via the UI */
    if (!renamingFork || !name || !conversationId) {
      return Promise.reject(new Error('fork rename confirmed with no fork, name or conversation'));
    }
    return renameFork.mutateAsync({ conversationId, forkId: renamingFork.id, name });
  }, [renamingFork, renameValue, conversationId, renameFork]);

  const handleForkDelete = React.useCallback(
    (forkId: string): void => {
      const fork = forksList.find((f) => f.id === forkId);
      setDeletingFork({ id: forkId, name: fork?.name ?? 'Fork' });
    },
    [forksList]
  );

  const handleConfirmDelete = React.useCallback(async (): Promise<unknown> => {
    /* v8 ignore next 3 -- the delete dialog only opens for an existing fork on an active conversation, so this guard is unreachable via the UI */
    if (!deletingFork || !conversationId) {
      throw new Error('fork delete confirmed with no fork or conversation');
    }
    const forkId = deletingFork.id;
    const result = await deleteFork.mutateAsync({ conversationId, forkId });
    if (activeForkId === forkId) {
      // Set to null — the auto-select effect will pick the correct fork
      // from the updated forksList after the query refetch.
      setActiveFork(null);
    }
    return result;
  }, [deletingFork, conversationId, deleteFork, activeForkId, setActiveFork]);

  const handleForkFromMessage = React.useCallback(
    (messageId: string): void => {
      /* v8 ignore next -- fork-from-message is only reachable from a rendered conversation, so conversationId is always present here */
      if (!conversationId) return;
      const forkId = crypto.randomUUID();
      const previousForkId = activeForkId;
      // Claim the new fork as active immediately. Setting it only in onSuccess
      // left a window where the forks query refetched to >= 2 forks but
      // activeForkId was still null, which the Main fallback filled — clobbering
      // the just-created fork. Revert if creation fails.
      setActiveFork(forkId);
      void (async (): Promise<void> => {
        const result = await runCreateFork(() =>
          createFork.mutateAsync({ id: forkId, conversationId, fromMessageId: messageId })
        );
        if (!result.ok) setActiveFork(previousForkId);
      })();
    },
    [conversationId, createFork, runCreateFork, setActiveFork, activeForkId]
  );

  return {
    renamingFork,
    setRenamingFork,
    renameValue,
    setRenameValue,
    deletingFork,
    setDeletingFork,
    handleForkSelect,
    handleForkRename,
    handleConfirmRename,
    handleForkDelete,
    handleConfirmDelete,
    handleForkFromMessage,
  };
}

export function ForkDialogs({ fm }: Readonly<{ fm: ForkManagement }>): React.JSX.Element | null {
  return (
    <>
      <RenameConversationDialog
        open={fm.renamingFork !== null}
        onOpenChange={(open) => {
          /* v8 ignore next -- a controlled dialog only emits onOpenChange(false); the open===true branch is unreachable */
          if (!open) fm.setRenamingFork(null);
        }}
        value={fm.renameValue}
        onValueChange={fm.setRenameValue}
        onConfirm={fm.handleConfirmRename}
      />
      <DeleteConversationDialog
        open={fm.deletingFork !== null}
        onOpenChange={(open) => {
          /* v8 ignore next -- a controlled dialog only emits onOpenChange(false); the open===true branch is unreachable */
          if (!open) fm.setDeletingFork(null);
        }}
        title={fm.deletingFork?.name ?? ''}
        onConfirm={fm.handleConfirmDelete}
      />
    </>
  );
}
