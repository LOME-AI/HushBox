import * as React from 'react';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { deriveKeysFromLinkSecret, deriveLinkAuthToken } from '@hushbox/crypto';
import { fromBase64, toBase64, TEST_IDS } from '@hushbox/shared';
import { AuthenticatedChatPage } from '@/components/chat/page/authenticated-chat-page.js';
import { clearEpochKeyCache } from '@/lib/crypto/epoch-key-cache.js';
import { clearDecryptedMessageCache } from '@/lib/crypto/decrypted-message-cache.js';
import { AppShell } from '../components/shared/app-shell.js';
import { PageShell } from '../components/shared/page-shell.js';
import { setLinkGuestAuth, clearLinkGuestAuth } from '../lib/auth/link-guest-auth.js';
import type { KeyPair } from '@hushbox/crypto';

export const Route = createFileRoute('/share/c/$conversationId')({
  component: SharedConversationPage,
  // Guest-exit: a full reload is the only way to GUARANTEE no decrypted plaintext
  // lingers in module-level memory after leaving a shared conversation. It hangs on
  // the router's leave hook rather than on effect cleanup, because a cleanup fires
  // on every teardown — and React double-invokes effects in development, so a
  // cleanup-mounted reload runs at mount and the route reloads itself forever.
  // Leaving by hard navigation needs no hook: that discards the whole JS heap.
  onLeave: () => {
    globalThis.location.reload();
  },
});

// Wrapper forces remount when the URL hash changes. Hash-only navigation
// (same path, different fragment) does NOT trigger a TanStack Router re-render,
// so we listen for hashchange events to detect link switches and remount
// the inner component via key={hash}.
function SharedConversationPage(): React.JSX.Element {
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
  const { conversationId } = useParams({ from: '/share/c/$conversationId' });
  const [guestKeys, setGuestKeys] = React.useState<KeyPair | null>(null);
  const [derivationFailed, setDerivationFailed] = React.useState(false);
  const queryClient = useQueryClient();

  const linkSecret = React.useMemo(() => {
    try {
      const secret = fromBase64(globalThis.location.hash.slice(1));
      return secret.length === 32 ? secret : null;
    } catch {
      return null;
    }
  }, []);

  React.useLayoutEffect(() => {
    if (!linkSecret) return;
    // The keypair belongs to the effect setup that derived it, never to the
    // render: the cleanup below zeroes the private key in place, and React
    // double-invokes effects in a development build (setup, cleanup, setup), so
    // a pair derived once and shared by both setups reaches the chat page
    // already zeroed — every request authorizes, every decrypt fails.
    let keys: KeyPair;
    try {
      keys = deriveKeysFromLinkSecret(linkSecret);
    } catch {
      setDerivationFailed(true);
      return;
    }
    setLinkGuestAuth(toBase64(deriveLinkAuthToken(linkSecret)));
    // Invalidate ALL cached queries — entering link guest mode changes the
    // auth context entirely (session cookies → link credential header with credentials: 'omit').
    // All previously cached responses (members, budgets, session, etc.) are stale.
    void queryClient.invalidateQueries();
    setGuestKeys(keys);
    return (): void => {
      clearLinkGuestAuth();
      // Leaving the shared conversation (or switching links): zero the
      // guest-derived private key and drop every epoch key + decrypted
      // plaintext this session unwrapped, so none of it lingers in memory.
      keys.privateKey.fill(0);
      clearEpochKeyCache();
      clearDecryptedMessageCache();
    };
  }, [linkSecret, conversationId, queryClient]);

  if (!linkSecret || derivationFailed) {
    return (
      <AppShell>
        <div
          className="flex h-full items-center justify-center"
          data-testid={TEST_IDS.sharedConversationError}
        >
          <p className="text-muted-foreground">This shared link is no longer available.</p>
        </div>
      </AppShell>
    );
  }

  if (!guestKeys) {
    return (
      <AppShell>
        <div
          className="flex h-full items-center justify-center"
          data-testid={TEST_IDS.sharedConversationLoading}
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
      <PageShell>
        <AuthenticatedChatPage
          routeConversationId={conversationId}
          privateKeyOverride={guestKeys.privateKey}
        />
      </PageShell>
    </AppShell>
  );
}
