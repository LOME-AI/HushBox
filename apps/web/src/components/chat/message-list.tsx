import { forwardRef, useCallback } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { MessageItem } from './message-item';
import type { Message } from '@/lib/api';
import type { Document } from '@/lib/document-parser';

interface MessageListProps {
  messages: Message[];
  streamingMessageId?: string | null;
  onDocumentsExtracted?: (messageId: string, documents: Document[]) => void;
}

const FOOTER_HEIGHT = '10dvh';

const Footer = (): React.JSX.Element => (
  <div style={{ height: FOOTER_HEIGHT }} aria-hidden="true" />
);

const Scroller = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function Scroller(props, ref) {
    return <div {...props} ref={ref} data-slot="scroll-area-viewport" />;
  }
);

const components = { Footer, Scroller };

export const MessageList = forwardRef<VirtuosoHandle, MessageListProps>(function MessageList(
  { messages, streamingMessageId, onDocumentsExtracted },
  ref
) {
  // eslint-disable-next-line sonarjs/function-return-type -- Virtuoso API requires this signature
  const followOutput = useCallback((isAtBottom: boolean): boolean | 'smooth' => {
    // eslint-disable-next-line sonarjs/no-selector-parameter -- Virtuoso API callback signature
    return isAtBottom ? 'smooth' : false;
  }, []);

  if (messages.length === 0) {
    return (
      <div data-testid="message-list-empty" className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground">No messages yet</p>
      </div>
    );
  }

  return (
    <div
      role="log"
      aria-label="Chat messages"
      data-testid="message-list"
      className="h-full min-h-0 flex-1"
    >
      <Virtuoso
        ref={ref}
        data={messages}
        followOutput={followOutput}
        atBottomThreshold={50}
        itemContent={(_index, message) => (
          <MessageItem
            key={message.id}
            message={message}
            isStreaming={message.id === streamingMessageId}
            onDocumentsExtracted={onDocumentsExtracted}
          />
        )}
        components={components}
      />
    </div>
  );
});
