import * as React from 'react';
import { ThemeToggle } from '@/components/shared/theme-toggle';

interface ChatHeaderProps {
  title?: string;
}

export function ChatHeader({ title = 'New Chat' }: ChatHeaderProps): React.JSX.Element {
  return (
    <header
      data-testid="chat-header"
      className="bg-background/95 supports-backdrop-blur:bg-background/60 sticky top-0 z-10 flex items-center justify-between border-b px-4 py-3 backdrop-blur"
    >
      <h1 className="text-lg font-semibold">{title}</h1>
      <ThemeToggle />
    </header>
  );
}
