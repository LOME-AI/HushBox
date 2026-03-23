import * as React from 'react';
import { Navigate } from '@tanstack/react-router';
import { ChatLayout } from '@/components/chat/chat-layout';
import { useAuthenticatedChat } from '@/hooks/use-authenticated-chat';
import { useGroupChat } from '@/hooks/use-group-chat';
import { useForks } from '@/hooks/forks';
import { useCreateFork, useDeleteFork, useRenameFork } from '@/hooks/forks';
import { useForkStore } from '@/stores/fork';
import { useChatEditStore } from '@/stores/chat-edit';
import { RenameConversationDialog } from '@/components/sidebar/rename-conversation-dialog';
import { DeleteConversationDialog } from '@/components/sidebar/delete-conversation-dialog';
import { ROUTES } from '@hushbox/shared';
import type { FundingSource, MemberPrivilege } from '@hushbox/shared';
import { resolveRegenerateTarget } from '@/lib/chat-regeneration';
import type { Message } from '@/lib/api';

interface AuthenticatedChatPageProps {
  readonly routeConversationId: string;
  readonly initialForkId?: string | undefined;
  readonly privateKeyOverride?: Uint8Array | null | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-empty-function -- Required for disabled submit handler
const NOOP = (): void => {};

function buildPhantomMessages(
  remotePhantoms: Map<string, import('@/hooks/use-remote-streaming').PhantomMessage> | undefined,
  existingMessages: Message[],
  conversationId: string | null
): Message[] {
  if (!remotePhantoms || remotePhantoms.size === 0) return [];
  const existingIds = new Set(existingMessages.map((m) => m.id));
  const result: Message[] = [];
  for (const [id, phantom] of remotePhantoms) {
    if (existingIds.has(id)) continue;
    result.push({
      id,
      conversationId: conversationId ?? '',
      role: phantom.senderType === 'user' ? 'user' : 'assistant',
      content: phantom.content,
      createdAt: '',
      ...(phantom.senderId !== undefined && { senderId: phantom.senderId }),
      ...(phantom.modelName !== undefined && { modelName: phantom.modelName }),
    });
  }
  return result;
}

function findRemoteStreamingIds(
  remotePhantoms: Map<string, import('@/hooks/use-remote-streaming').PhantomMessage> | undefined
): Set<string> {
  const ids = new Set<string>();
  if (!remotePhantoms) return ids;
  for (const [id, phantom] of remotePhantoms) {
    if (phantom.senderType === 'ai') ids.add(id);
  }
  return ids;
}

function resolveConversationId(
  routeConversationId: string,
  realConversationId: string | null
): string | null {
  return routeConversationId === 'new' ? realConversationId : routeConversationId;
}

function combineWithPhantoms(baseMessages: Message[], phantoms: Message[]): Message[] {
  if (phantoms.length === 0) return baseMessages;
  return [...baseMessages, ...phantoms];
}

function syncForkToUrl(activeForkId: string | null): void {
  const url = new URL(globalThis.location.href);
  if (activeForkId) {
    url.searchParams.set('fork', activeForkId);
  } else {
    url.searchParams.delete('fork');
  }
  if (url.href !== globalThis.location.href) {
    globalThis.history.replaceState(null, '', url.toString());
  }
}

function useForkUrlSync(activeForkId: string | null): void {
  React.useEffect(() => {
    syncForkToUrl(activeForkId);
  }, [activeForkId]);
}

function useInitialFork(initialForkId: string | undefined): void {
  const initializedRef = React.useRef(false);
  React.useEffect(() => {
    if (!initializedRef.current && initialForkId) {
      initializedRef.current = true;
      useForkStore.getState().setActiveFork(initialForkId);
    }
  }, [initialForkId]);
}

interface ForkItem {
  id: string;
  conversationId: string;
  name: string;
  tipMessageId: string | null;
  createdAt: string;
}

interface ForkManagement {
  renamingFork: { id: string; name: string } | null;
  setRenamingFork: React.Dispatch<React.SetStateAction<{ id: string; name: string } | null>>;
  renameValue: string;
  setRenameValue: React.Dispatch<React.SetStateAction<string>>;
  deletingFork: { id: string; name: string } | null;
  setDeletingFork: React.Dispatch<React.SetStateAction<{ id: string; name: string } | null>>;
  handleForkSelect: (forkId: string) => void;
  handleForkRename: (forkId: string, currentName: string) => void;
  handleConfirmRename: () => void;
  handleForkDelete: (forkId: string) => void;
  handleConfirmDelete: () => void;
  handleForkFromMessage: (messageId: string) => void;
}

function useForkManagement(
  conversationId: string | null,
  forksList: ForkItem[],
  activeForkId: string | null,
  setActiveFork: (id: string | null) => void
): ForkManagement {
  const createFork = useCreateFork();
  const deleteFork = useDeleteFork();
  const renameFork = useRenameFork();

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

  const handleConfirmRename = React.useCallback((): void => {
    if (!renamingFork || !renameValue.trim() || !conversationId) return;
    renameFork.mutate({ conversationId, forkId: renamingFork.id, name: renameValue.trim() });
    setRenamingFork(null);
  }, [renamingFork, renameValue, conversationId, renameFork]);

  const handleForkDelete = React.useCallback(
    (forkId: string): void => {
      const fork = forksList.find((f) => f.id === forkId);
      setDeletingFork({ id: forkId, name: fork?.name ?? 'Fork' });
    },
    [forksList]
  );

  const handleConfirmDelete = React.useCallback((): void => {
    if (!deletingFork || !conversationId) return;
    const forkId = deletingFork.id;
    deleteFork.mutate(
      { conversationId, forkId },
      {
        onSuccess: () => {
          if (activeForkId === forkId) {
            // Set to null — the auto-select effect will pick the correct fork
            // from the updated forksList after the query refetch.
            setActiveFork(null);
          }
        },
      }
    );
    setDeletingFork(null);
  }, [deletingFork, conversationId, deleteFork, activeForkId, setActiveFork]);

  const handleForkFromMessage = React.useCallback(
    (messageId: string): void => {
      if (!conversationId) return;
      const forkId = crypto.randomUUID();
      createFork.mutate(
        { id: forkId, conversationId, fromMessageId: messageId },
        {
          onSuccess: () => {
            setActiveFork(forkId);
          },
        }
      );
    },
    [conversationId, createFork, setActiveFork]
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

function ForkDialogs({ fm }: Readonly<{ fm: ForkManagement }>): React.JSX.Element | null {
  return (
    <>
      <RenameConversationDialog
        open={fm.renamingFork !== null}
        onOpenChange={(open) => {
          if (!open) fm.setRenamingFork(null);
        }}
        value={fm.renameValue}
        onValueChange={fm.setRenameValue}
        onConfirm={fm.handleConfirmRename}
      />
      <DeleteConversationDialog
        open={fm.deletingFork !== null}
        onOpenChange={(open) => {
          if (!open) fm.setDeletingFork(null);
        }}
        title={fm.deletingFork?.name ?? ''}
        onConfirm={fm.handleConfirmDelete}
      />
    </>
  );
}

/** Default callerPrivilege to 'read' during loading for link guests to prevent notification flash. */
function resolveGuestPrivilege(
  isLinkGuest: boolean,
  callerPrivilege: MemberPrivilege | undefined
): MemberPrivilege | undefined {
  if (!isLinkGuest) return callerPrivilege;
  return callerPrivilege ?? 'read';
}

export function AuthenticatedChatPage({
  routeConversationId,
  initialForkId,
  privateKeyOverride,
}: AuthenticatedChatPageProps): React.JSX.Element {
  const { editingMessageId, startEditing, clearEditing } = useChatEditStore();

  const { activeForkId, setActiveFork } = useForkStore();

  useInitialFork(initialForkId);

  const chat = useAuthenticatedChat({ routeConversationId, activeForkId, privateKeyOverride });
  const conversationId = resolveConversationId(routeConversationId, chat.realConversationId);
  const groupChat = useGroupChat(
    conversationId,
    chat.callerId,
    chat.displayTitle,
    chat.state.streamingMessageIdsRef
  );

  const forksQueryId = conversationId ?? '';
  const { data: forks } = useForks(forksQueryId);
  const forksList = React.useMemo(() => forks ?? [], [forks]);

  // When forks exist but activeForkId is null, auto-set to the Main fork
  // (earliest createdAt). The store is the single source of truth — once set,
  // all downstream hooks use activeForkId directly.
  React.useEffect(() => {
    if (activeForkId !== null || forksList.length < 2) return;
    const sorted = forksList.toSorted(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    if (sorted[0]) {
      setActiveFork(sorted[0].id);
    }
  }, [activeForkId, forksList, setActiveFork]);

  useForkUrlSync(activeForkId);

  const fm = useForkManagement(conversationId, forksList, activeForkId, setActiveFork);

  const handleRegenerate = React.useCallback(
    (messageId: string): void => {
      const { targetMessageId, action } = resolveRegenerateTarget(chat.messages, messageId);
      chat.handleRegenerate(targetMessageId, action);
    },
    [chat]
  );

  const handleEdit = React.useCallback(
    (messageId: string, content: string): void => {
      startEditing(messageId, content);
      chat.state.setInputValue(content);
    },
    [startEditing, chat.state]
  );

  const handleCancelEdit = React.useCallback((): void => {
    clearEditing();
    chat.state.setInputValue('');
  }, [clearEditing, chat.state]);

  const handleEditSubmit = React.useCallback(
    (fundingSource: FundingSource): void => {
      if (!editingMessageId) {
        chat.handleSend(fundingSource);
        return;
      }
      chat.handleRegenerate(editingMessageId, 'edit', chat.state.inputValue);
      clearEditing();
    },
    [editingMessageId, chat, clearEditing]
  );

  const isLinkGuest = privateKeyOverride != null;
  const remotePhantoms = groupChat?.remoteStreamingMessages;
  const phantomMessages = React.useMemo(
    () => buildPhantomMessages(remotePhantoms, chat.messages, conversationId),
    [remotePhantoms, conversationId, chat.messages]
  );

  const messagesWithPhantoms = React.useMemo(
    () => combineWithPhantoms(chat.messages, phantomMessages),
    [chat.messages, phantomMessages]
  );

  // Fork filtering is already applied inside useAuthenticatedChat (via forkFilteredDecrypted
  // passed to mergeMessages). Optimistic messages are appended after fork filtering, so they
  // remain visible during streaming. No need to re-apply fork filter here.

  const remoteStreamingIds = React.useMemo(
    () => findRemoteStreamingIds(remotePhantoms),
    [remotePhantoms]
  );

  const effectiveStreamingIds =
    chat.state.streamingMessageIds.size > 0 ? chat.state.streamingMessageIds : remoteStreamingIds;

  if (chat.renderState.type === 'redirecting' || chat.renderState.type === 'not-found') {
    if (isLinkGuest) {
      return (
        <div
          className="flex h-full items-center justify-center"
          data-testid="shared-conversation-error"
        >
          <p className="text-muted-foreground">This shared link is no longer available.</p>
        </div>
      );
    }
    return <Navigate to={ROUTES.CHAT} />;
  }

  if (chat.renderState.type === 'loading') {
    return (
      <ChatLayout
        title={chat.renderState.title}
        messages={[]}
        streamingMessageIds={new Set<string>()}
        inputValue=""
        onInputChange={chat.state.setInputValue}
        onSubmit={NOOP}
        inputDisabled={true}
        isProcessing={false}
        historyCharacters={0}
        isAuthenticated={!isLinkGuest}
        isLinkGuest={isLinkGuest}
        isDecrypting={true}
        conversationId={conversationId ?? undefined}
        groupChat={groupChat}
        callerPrivilege={resolveGuestPrivilege(isLinkGuest, chat.callerPrivilege)}
      />
    );
  }

  return (
    <>
      <ChatLayout
        title={chat.displayTitle}
        messages={messagesWithPhantoms}
        streamingMessageIds={effectiveStreamingIds}
        inputValue={chat.state.inputValue}
        onInputChange={chat.state.setInputValue}
        onSubmit={handleEditSubmit}
        onSubmitUserOnly={chat.handleSendUserOnly}
        inputDisabled={chat.inputDisabled}
        isProcessing={chat.isStreaming}
        historyCharacters={chat.historyCharacters}
        isAuthenticated={!isLinkGuest}
        isLinkGuest={isLinkGuest}
        promptInputRef={chat.promptInputRef}
        errorMessageId={chat.errorMessageId}
        conversationId={conversationId ?? undefined}
        groupChat={groupChat}
        callerPrivilege={chat.callerPrivilege}
        forks={forksList}
        activeForkId={activeForkId}
        onForkSelect={fm.handleForkSelect}
        onForkRename={fm.handleForkRename}
        onForkDelete={fm.handleForkDelete}
        onRegenerate={handleRegenerate}
        onEdit={handleEdit}
        onFork={fm.handleForkFromMessage}
        isEditing={editingMessageId !== null}
        onCancelEdit={handleCancelEdit}
      />
      <ForkDialogs fm={fm} />
    </>
  );
}
