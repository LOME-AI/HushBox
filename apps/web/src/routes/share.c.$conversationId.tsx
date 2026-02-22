import * as React from 'react';
import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { decryptMessage } from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { AppShell } from '../components/shared/app-shell.js';
import { ChatLayout } from '../components/chat/chat-layout.js';
import { useSharedConversation } from '../hooks/use-shared-conversation.js';
import { processKeyChain, getEpochKey } from '../lib/epoch-key-cache.js';
import type { Message } from '../lib/api.js';

export const Route = createFileRoute('/share/c/$conversationId')({
  component: SharedConversationPage,
});

export function SharedConversationPage(): React.JSX.Element {
  const { conversationId } = Route.useParams();
  const linkPrivateKeyBase64 = useMemo(() => globalThis.location.hash.slice(1) || null, []);

  const { data, linkPrivateKey, isLoading, isError } = useSharedConversation(
    conversationId,
    linkPrivateKeyBase64
  );

  const title = useMemo((): string => {
    if (!data || !linkPrivateKey) return 'Shared Conversation';
    processKeyChain(
      conversationId,
      {
        wraps: data.wraps,
        chainLinks: data.chainLinks,
        currentEpoch: data.conversation.currentEpoch,
      },
      linkPrivateKey
    );
    const titleEpochKey = getEpochKey(conversationId, data.conversation.titleEpochNumber);
    if (!titleEpochKey) return 'Shared Conversation';
    try {
      return decryptMessage(titleEpochKey, fromBase64(data.conversation.title));
    } catch {
      return 'Shared Conversation';
    }
  }, [conversationId, data, linkPrivateKey]);

  const decryptedMessages = useMemo((): Message[] => {
    if (!data?.messages || !linkPrivateKey) return [];
    processKeyChain(
      conversationId,
      {
        wraps: data.wraps,
        chainLinks: data.chainLinks,
        currentEpoch: data.conversation.currentEpoch,
      },
      linkPrivateKey
    );
    return data.messages.map((msg): Message => {
      const epochKey = getEpochKey(conversationId, msg.epochNumber);
      if (!epochKey) {
        return {
          id: msg.id,
          conversationId: msg.conversationId,
          role: msg.senderType === 'ai' ? ('assistant' as const) : ('user' as const),
          content: '[decryption failed: missing epoch key]',
          createdAt: msg.createdAt,
        };
      }
      try {
        const content = decryptMessage(epochKey, fromBase64(msg.encryptedBlob));
        return {
          id: msg.id,
          conversationId: msg.conversationId,
          role: msg.senderType === 'ai' ? ('assistant' as const) : ('user' as const),
          content,
          createdAt: msg.createdAt,
          ...(msg.cost != null && { cost: msg.cost }),
        };
      } catch {
        return {
          id: msg.id,
          conversationId: msg.conversationId,
          role: msg.senderType === 'ai' ? ('assistant' as const) : ('user' as const),
          content: '[decryption failed]',
          createdAt: msg.createdAt,
        };
      }
    });
  }, [conversationId, data, linkPrivateKey]);

  const groupChat = useMemo(
    () =>
      data
        ? {
            conversationId,
            members: data.members.filter(
              (m): m is typeof m & { userId: string; username: string } =>
                m.userId !== null && m.username !== null
            ),
            links: data.links,
            onlineMemberIds: new Set<string>(),
            currentUserId: '',
            currentUserPrivilege: data.privilege,
            currentEpochPrivateKey: new Uint8Array(0),
            currentEpochNumber: data.conversation.currentEpoch,
          }
        : null,
    [conversationId, data]
  );

  if (isLoading) {
    return (
      <div
        data-testid="shared-conversation-loading"
        className="flex h-dvh items-center justify-center"
      >
        <span className="text-muted-foreground text-sm">Loading shared conversation...</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <AppShell>
        <div
          className="flex flex-1 items-center justify-center"
          data-testid="shared-conversation-error"
        >
          <div className="text-center">
            <h2 className="mb-2 text-lg font-semibold">Unable to access conversation</h2>
            <p className="text-muted-foreground text-sm">
              This link may have been revoked or is invalid.
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  const inputDisabled = data.privilege === 'read';

  return (
    <AppShell>
      <ChatLayout
        title={title}
        messages={decryptedMessages}
        streamingMessageId={null}
        inputDisabled={inputDisabled}
        isProcessing={false}
        isAuthenticated={false}
        inputValue=""
        onInputChange={() => {
          /* noop — read-only shared view */
        }}
        onSubmit={() => {
          /* noop — read-only shared view */
        }}
        historyCharacters={0}
        groupChat={groupChat ?? undefined}
      />
    </AppShell>
  );
}
