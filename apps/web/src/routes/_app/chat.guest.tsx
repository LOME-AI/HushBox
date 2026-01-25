import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { GuestChatPage } from '@/components/chat/guest-chat-page';
import { ErrorBoundary } from '@/components/shared/error-boundary';

export const Route = createFileRoute('/_app/chat/guest')({
  component: GuestChatWithErrorBoundary,
});

function GuestChatWithErrorBoundary(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <GuestChatPage />
    </ErrorBoundary>
  );
}
