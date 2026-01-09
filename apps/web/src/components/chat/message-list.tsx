import * as React from 'react';
import { ScrollArea } from '@lome-chat/ui';
import { MessageItem } from './message-item';
import type { Message } from '@/lib/api';
import type { Document } from '@/lib/document-parser';

interface MessageListProps {
  messages: Message[];
  streamingMessageId?: string | null;
  onDocumentsExtracted?: (messageId: string, documents: Document[]) => void;
  viewportRef?: React.Ref<HTMLDivElement>;
  onScroll?: (event: React.UIEvent<HTMLDivElement>) => void;
}

export function MessageList({
  messages,
  streamingMessageId,
  onDocumentsExtracted,
  viewportRef,
  onScroll,
}: MessageListProps): React.JSX.Element {
  if (messages.length === 0) {
    return (
      <div data-testid="message-list-empty" className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground">No messages yet</p>
      </div>
    );
  }

  // Build optional scroll props to avoid TypeScript exactOptionalPropertyTypes issues
  const scrollProps = {
    ...(viewportRef !== undefined && { viewportRef }),
    ...(onScroll !== undefined && { onScroll }),
  };

  return (
    <ScrollArea data-testid="message-list" className="h-full flex-1" {...scrollProps}>
      <div
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
        className="flex w-full flex-col py-4"
      >
        {messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            isStreaming={message.id === streamingMessageId}
            onDocumentsExtracted={onDocumentsExtracted}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
