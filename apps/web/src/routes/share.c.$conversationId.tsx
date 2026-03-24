import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { deriveKeysFromLinkSecret } from '@hushbox/crypto';
import { fromBase64, toBase64 } from '@hushbox/shared';
import { AppShell } from '../components/shared/app-shell.js';
import { AuthenticatedChatPage } from '../components/chat/authenticated-chat-page.js';
import { setLinkGuestAuth, clearLinkGuestAuth } from '../lib/link-guest-auth.js';

export const Route = createFileRoute('/share/c/$conversationId')({
  component: SharedConversationPage,
});

// Wrapper forces remount when the URL hash changes. Hash-only navigation
// (same path, different fragment) does NOT trigger a TanStack Router re-render,
// so we listen for hashchange events to detect link switches and remount
// the inner component via key={hash}.
export function SharedConversationPage(): React.JSX.Element {
  const [hash, setHash] = React.useState(globalThis.location.hash);

  React.useEffect(() => {
    const handler = (): void => {
      setHash(globalThis.location.hash);
    };
    globalThis.addEventListener('hashchange', handler);
    return () => {
      globalThis.removeEventListener('hashchange', handler);
    };
  }, []);

  return <SharedConversationPageInner key={hash} />;
}

function SharedConversationPageInner(): React.JSX.Element {
  const { conversationId } = Route.useParams();
  const [linkReady, setLinkReady] = React.useState(false);
  const queryClient = useQueryClient();

  const derivedKeys = React.useMemo(() => {
    try {
      const secret = fromBase64(globalThis.location.hash.slice(1));
      if (secret.length !== 32) return null;
      return deriveKeysFromLinkSecret(secret);
    } catch {
      return null;
    }
  }, []);

  React.useLayoutEffect(() => {
    if (!derivedKeys) return;
    setLinkGuestAuth(toBase64(derivedKeys.publicKey));
    // Invalidate ALL cached queries — entering link guest mode changes the
    // auth context entirely (session cookies → link key header with credentials: 'omit').
    // All previously cached responses (members, budgets, session, etc.) are stale.
    void queryClient.invalidateQueries();
    setLinkReady(true);
    return (): void => {
      clearLinkGuestAuth();
    };
  }, [derivedKeys, conversationId, queryClient]);

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
