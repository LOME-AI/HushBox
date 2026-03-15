import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Lock } from 'lucide-react';
import { deriveKeysFromLinkSecret } from '@hushbox/crypto';
import { fromBase64, toBase64 } from '@hushbox/shared';
import { AppShell } from '../components/shared/app-shell.js';
import { AuthenticatedChatPage } from '../components/chat/authenticated-chat-page.js';
import { setLinkGuestAuth, clearLinkGuestAuth } from '../lib/link-guest-auth.js';

export const Route = createFileRoute('/share/c/$conversationId')({
  component: SharedConversationPage,
});

export function SharedConversationPage(): React.JSX.Element {
  const { conversationId } = Route.useParams();
  const [linkReady, setLinkReady] = React.useState(false);

  const derivedKeys = React.useMemo(() => {
    try {
      const secret = fromBase64(globalThis.location.hash.slice(1));
      return deriveKeysFromLinkSecret(secret);
    } catch {
      return null;
    }
  }, []);

  React.useLayoutEffect(() => {
    if (!derivedKeys) return;
    setLinkGuestAuth(toBase64(derivedKeys.publicKey));
    setLinkReady(true);
    return (): void => {
      clearLinkGuestAuth();
    };
  }, [derivedKeys]);

  if (!derivedKeys) {
    return (
      <AppShell>
        <div
          className="flex h-full items-center justify-center"
          data-testid="shared-conversation-error"
        >
          <p className="text-muted-foreground">This shared link is no longer available.</p>
        </div>
      </AppShell>
    );
  }

  if (!linkReady) {
    return (
      <AppShell>
        <div
          className="flex h-full items-center justify-center"
          data-testid="shared-conversation-loading"
        >
          <div className="flex flex-col items-center gap-3">
            <Lock className="text-muted-foreground h-8 w-8" />
            <span className="text-muted-foreground text-sm">Decrypting your conversation...</span>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <AuthenticatedChatPage
        routeConversationId={conversationId}
        privateKeyOverride={derivedKeys.privateKey}
      />
    </AppShell>
  );
}
