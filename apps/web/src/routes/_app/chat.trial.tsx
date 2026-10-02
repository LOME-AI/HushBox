import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ErrorBoundary } from '@hushbox/ui';
import { TrialChatPage } from '@/components/chat/page/trial-chat-page';

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
