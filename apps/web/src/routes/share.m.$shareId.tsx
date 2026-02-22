import * as React from 'react';
import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { AppShell } from '../components/shared/app-shell.js';
import { ChatLayout } from '../components/chat/chat-layout.js';
import { useSharedMessage } from '../hooks/use-shared-message.js';

interface SharedMessageData {
  content: string;
  createdAt: string;
  author: string;
}

export const Route = createFileRoute('/share/m/$shareId')({
  component: SharedMessagePage,
});

export function SharedMessagePage(): React.JSX.Element {
  const { shareId } = Route.useParams();
  const keyBase64 = useMemo(() => globalThis.location.hash.slice(1) || null, []);

  const { data, isLoading, isError } = useSharedMessage(shareId, keyBase64);
  const messageData = data as SharedMessageData | undefined;

  if (isLoading) {
    return (
      <div data-testid="shared-message-loading" className="flex h-dvh items-center justify-center">
        <span className="text-muted-foreground text-sm">Decrypting shared message...</span>
      </div>
    );
  }

  if (isError || !messageData) {
    return (
      <AppShell>
        <div data-testid="shared-message-error" className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <AlertTriangle className="text-muted-foreground h-8 w-8" />
            <h2 className="text-lg font-semibold">Unable to access message</h2>
            <p className="text-muted-foreground text-sm">
              This share link may be invalid or expired.
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  const singleMessage = {
    id: `shared-${shareId}`,
    conversationId: '',
    role: 'assistant' as const,
    content: messageData.content,
    createdAt: messageData.createdAt,
  };

  return (
    <AppShell>
      <ChatLayout
        title="Shared Message"
        messages={[singleMessage]}
        streamingMessageId={null}
        inputDisabled={true}
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
      />
    </AppShell>
  );
}
