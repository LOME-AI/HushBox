import * as React from 'react';
import { useMemo } from 'react';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';
import { SharedMessageChatPage } from '@/components/chat/page/shared-message-chat-page';
import { PageShell } from '@/components/shared/page-shell';
import { useSharedMessage } from '@/hooks/chat/use-shared-message.js';
import { AppShell } from '../components/shared/app-shell.js';

export const Route = createFileRoute('/share/m/$shareId')({
  component: SharedMessagePage,
});

function SharedMessagePage(): React.JSX.Element {
  const { shareId } = useParams({ from: '/share/m/$shareId' });
  const keyBase64 = useMemo(() => globalThis.location.hash.slice(1) || null, []);

  const { data, isLoading, isError } = useSharedMessage(shareId, keyBase64);

  // Every branch renders inside AppShell so its `main#main` stays one mounted
  // element as the page settles, keeping the focus the route announcer gave it.
  if (isLoading) {
    return (
      <AppShell>
        <div
          data-testid={TEST_IDS.sharedMessageLoading}
          role="status"
          aria-live="polite"
          className="flex h-full items-center justify-center"
        >
          <span className="text-muted-foreground text-sm">Decrypting shared message...</span>
        </div>
      </AppShell>
    );
  }

  if (isError || !data) {
    return (
      <AppShell>
        <div
          data-testid={TEST_IDS.sharedMessageError}
          role="alert"
          className="flex flex-1 items-center justify-center"
        >
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
      <PageShell>
        <SharedMessageChatPage data={data} />
      </PageShell>
    </AppShell>
  );
}
