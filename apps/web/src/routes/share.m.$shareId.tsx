import * as React from 'react';
import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { AppShell } from '../components/shared/app-shell.js';
import { MarkdownRenderer } from '../components/chat/markdown-renderer.js';
import { SharedMediaContentItem } from '../components/chat/shared-media-content-item.js';
import { useSharedMessage } from '../hooks/use-shared-message.js';

export const Route = createFileRoute('/share/m/$shareId')({
  component: SharedMessagePage,
});

export function SharedMessagePage(): React.JSX.Element {
  const { shareId } = Route.useParams();
  const keyBase64 = useMemo(() => globalThis.location.hash.slice(1) || null, []);

  const { data, isLoading, isError } = useSharedMessage(shareId, keyBase64);

  if (isLoading) {
    return (
      <div data-testid="shared-message-loading" className="flex h-dvh items-center justify-center">
        <span className="text-muted-foreground text-sm">Decrypting shared message...</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <AppShell>
        <div data-testid="shared-message-error" className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <AlertTriangle className="text-muted-foreground h-8 w-8" />
            <h2 className="text-lg font-semibold">Unable to access message</h2>
            <p className="text-muted-foreground text-sm">
              This share link may be invalid or expired.
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex flex-1 flex-col overflow-y-auto px-4 py-8">
        <div className="mx-auto w-full max-w-2xl">
          <h1 className="mb-6 text-lg font-semibold">Shared Message</h1>
          <div
            data-testid="shared-message-content"
            className="bg-card flex flex-col gap-4 rounded-md border p-4"
          >
            {data.contentItems.map((item) => {
              if (item.type === 'text') {
                return (
                  <div
                    key={`text-${String(item.position)}`}
                    className="prose dark:prose-invert max-w-none"
                  >
                    <MarkdownRenderer content={item.content} />
                  </div>
                );
              }
              return (
                <div key={item.contentItemId}>
                  <SharedMediaContentItem item={item} contentKey={data.contentKey} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
