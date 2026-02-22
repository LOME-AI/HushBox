import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AuthenticatedChatPage } from '@/components/chat/authenticated-chat-page';
import { ErrorBoundary } from '@/components/shared/error-boundary';

export const Route = createFileRoute('/_app/chat/$id')({
  component: AuthenticatedChatWithErrorBoundary,
});

function AuthenticatedChatWithErrorBoundary(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <AuthenticatedChat />
    </ErrorBoundary>
  );
}

function AuthenticatedChat(): React.JSX.Element {
  const { id } = Route.useParams();

  return <AuthenticatedChatPage routeConversationId={id} />;
}
