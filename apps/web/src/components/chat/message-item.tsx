import * as React from 'react';
import { Avatar, AvatarFallback, cn } from '@lome-chat/ui';
import { Bot, User } from 'lucide-react';
import type { Message } from '@/lib/api';

interface MessageItemProps {
  message: Message;
}

export function MessageItem({ message }: MessageItemProps): React.JSX.Element {
  const isUser = message.role === 'user';

  return (
    <div
      data-testid="message-item"
      data-role={message.role}
      className={cn('flex w-full gap-3 px-4 py-3', isUser ? 'justify-end' : 'justify-start')}
    >
      {!isUser && (
        <Avatar data-testid="assistant-avatar" className="h-8 w-8 shrink-0">
          <AvatarFallback className="bg-primary text-primary-foreground">
            <Bot className="h-4 w-4" aria-hidden="true" />
          </AvatarFallback>
        </Avatar>
      )}

      <div
        className={cn(
          'max-w-[80%] rounded-lg px-4 py-2',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
        )}
      >
        <p className="text-base leading-relaxed whitespace-pre-wrap">{message.content}</p>
      </div>

      {isUser && (
        <Avatar data-testid="user-avatar" className="h-8 w-8 shrink-0">
          <AvatarFallback className="bg-secondary text-secondary-foreground">
            <User className="h-4 w-4" aria-hidden="true" />
          </AvatarFallback>
        </Avatar>
      )}
    </div>
  );
}
