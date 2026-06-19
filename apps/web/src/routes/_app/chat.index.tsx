import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { ChatIndex } from './-chat-index';

export const Route = createFileRoute('/_app/chat/')({
  component: ChatIndexWithErrorBoundary,
});

function ChatIndexWithErrorBoundary(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <ChatIndex />
    </ErrorBoundary>
  );
}
