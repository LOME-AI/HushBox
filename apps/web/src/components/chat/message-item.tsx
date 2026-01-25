import * as React from 'react';
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from '@lome-chat/ui';
import { Check, Copy } from 'lucide-react';
import type { Message } from '@/lib/api';
import type { Document } from '@/lib/document-parser';
import { MarkdownRenderer } from './markdown-renderer';
import { MessageCost } from './message-cost';

interface MessageItemProps {
  message: Message;
  /** Whether this message is currently streaming (for future loading indicator) */
  isStreaming?: boolean;
  onDocumentsExtracted?: ((messageId: string, documents: Document[]) => void) | undefined;
}

export function MessageItem({
  message,
  onDocumentsExtracted,
}: Readonly<MessageItemProps>): React.JSX.Element {
  const isUser = message.role === 'user';
  const [copied, setCopied] = React.useState(false);

  const contentToRender = message.content;

  const handleDocumentsExtracted = React.useCallback(
    (documents: Document[]) => {
      if (onDocumentsExtracted && documents.length > 0) {
        onDocumentsExtracted(message.id, documents);
      }
    },
    [onDocumentsExtracted, message.id]
  );

  const handleCopy = async (): Promise<void> => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  return (
    <div
      data-testid="message-item"
      data-role={message.role}
      className={cn('py-3', isUser ? 'mr-[2%] ml-auto w-fit max-w-[82%]' : 'w-full px-[2%] pb-7')}
    >
      <div className="group relative">
        <div
          className={cn(
            'px-4 py-2',
            isUser
              ? 'bg-message-user text-foreground rounded-lg'
              : 'text-foreground overflow-hidden'
          )}
        >
          {isUser ? (
            <p className="text-base leading-relaxed break-all whitespace-pre-wrap">
              {message.content}
            </p>
          ) : (
            <div className="w-full overflow-hidden text-base leading-relaxed break-all">
              <MarkdownRenderer
                content={contentToRender}
                messageId={message.id}
                onDocumentsExtracted={handleDocumentsExtracted}
              />
            </div>
          )}
        </div>

        {!isUser && (
          <div className="absolute right-0 -bottom-1 left-0 flex translate-y-full items-center justify-between px-1">
            {message.cost && <MessageCost cost={message.cost} />}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                  onClick={() => void handleCopy()}
                  aria-label={copied ? 'Copied' : 'Copy'}
                >
                  {copied ? (
                    <Check className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <Copy className="h-3 w-3" aria-hidden="true" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{copied ? 'Copied!' : 'Copy'}</p>
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
    </div>
  );
}
