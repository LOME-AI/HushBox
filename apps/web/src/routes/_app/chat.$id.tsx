import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { AuthenticatedChatPage } from '@/components/chat/authenticated-chat-page';
import { ErrorBoundary } from '@/components/shared/error-boundary';

const searchSchema = z.object({
  triggerStreaming: z.boolean().optional(),
});

export const Route = createFileRoute('/_app/chat/$id')({
  component: AuthenticatedChatWithErrorBoundary,
  validateSearch: searchSchema,
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
  const { triggerStreaming } = Route.useSearch();

  return (
    <AuthenticatedChatPage
      routeConversationId={id}
      {...(triggerStreaming !== undefined && { triggerStreaming })}
    />
  );
}
