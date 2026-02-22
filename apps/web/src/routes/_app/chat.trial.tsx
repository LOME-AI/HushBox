import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { TrialChatPage } from '@/components/chat/trial-chat-page';
import { ErrorBoundary } from '@/components/shared/error-boundary';

export const Route = createFileRoute('/_app/chat/trial')({
  component: TrialChatWithErrorBoundary,
});

function TrialChatWithErrorBoundary(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <TrialChatPage />
    </ErrorBoundary>
  );
}
