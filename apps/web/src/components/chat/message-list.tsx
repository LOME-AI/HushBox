import * as React from 'react';
import { ScrollArea } from '@lome-chat/ui';
import { MessageItem } from './message-item';
import { StreamingMessage } from './streaming-message';
import type { Message } from '@/lib/api';

interface MessageListProps {
  messages: Message[];
  isStreaming?: boolean;
  streamingContent?: string;
}

export function MessageList({
  messages,
  isStreaming = false,
  streamingContent = '',
}: MessageListProps): React.JSX.Element {
  if (messages.length === 0 && !isStreaming) {
    return (
      <div data-testid="message-list-empty" className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground">No messages yet</p>
      </div>
    );
  }

  return (
    <ScrollArea data-testid="message-list" className="h-full flex-1 overflow-hidden">
      <div role="log" aria-live="polite" aria-label="Chat messages" className="flex flex-col py-4">
        {messages.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}
        {isStreaming && <StreamingMessage content={streamingContent} isStreaming={isStreaming} />}
      </div>
    </ScrollArea>
  );
}
