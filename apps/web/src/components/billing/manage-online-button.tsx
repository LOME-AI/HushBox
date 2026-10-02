import * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '@hushbox/ui';
import { MARKETING_BASE_URL, TEST_IDS } from '@hushbox/shared';
import { MANAGE_BALANCE_ONLINE_LABEL } from '@hushbox/shared/billing-portal';
import { client, fetchJson } from '@/lib/api-client.js';
import { idempotentHeaders } from '@/lib/api/idempotent-mutation.js';
import { openExternalUrl } from '@/capacitor/browser';
import type { FileRouteTypes } from '@/routeTree.gen';

/**
 * The route that redeems the minted login token. Typed against the router's
 * generated route union so that a path the app does not serve fails to
 * compile; a path interpolated into a template string is checked by nothing.
 *
 * Deliberately absent from the deep-link allowlist in
 * `apps/web/src/capacitor/hooks/use-deep-links.ts`, so an OS-delivered link
 * cannot drive the app to a redemption route carrying an attacker's token.
 * Opening it here is the outbound side and needs no entry there.
 */
const BILLING_PORTAL_PATH: FileRouteTypes['to'] = '/billing-portal';

/** Opens the billing page in the system browser with a one-time login token. */
export function ManageOnlineButton(): React.JSX.Element {
  const [isLoading, setIsLoading] = React.useState(false);

  const handleClick = async (): Promise<void> => {
    setIsLoading(true);
    try {
      // `byKey`, session-class: the Idempotency-Key replays the same minted
      // token for a retried click; each fresh click mints a new one.
      const { token } = await fetchJson(
        client.billing['login-link'].$post({}, idempotentHeaders({}))
      );
      const portalUrl = new URL(BILLING_PORTAL_PATH, MARKETING_BASE_URL);
      portalUrl.searchParams.set('token', token);
      await openExternalUrl(portalUrl.toString());
    } catch (error: unknown) {
      console.error('Failed to generate billing login token:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button
      data-testid={TEST_IDS.manageOnlineButton}
      block
      size="lg"
      disabled={isLoading}
      onClick={() => {
        void handleClick();
      }}
    >
      <ExternalLink className="mr-2 h-4 w-4" />
      {MANAGE_BALANCE_ONLINE_LABEL}
    </Button>
  );
}
