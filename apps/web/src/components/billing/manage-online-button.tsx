import * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '@hushbox/ui';
import { MARKETING_BASE_URL, ROUTES } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client';
import { openExternalUrl } from '@/capacitor/browser';

/** Opens the billing page in the system browser with a one-time login token. */
export function ManageOnlineButton(): React.JSX.Element {
  const [isLoading, setIsLoading] = React.useState(false);

  const handleClick = async (): Promise<void> => {
    setIsLoading(true);
    try {
      const { token } = await fetchJson<{ token: string }>(
        client.api.billing['login-link'].$post()
      );
      await openExternalUrl(`${MARKETING_BASE_URL}${ROUTES.BILLING}?token=${token}`);
    } catch (error: unknown) {
      console.error('Failed to generate billing login token:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button
      data-testid="manage-online-button"
      size="lg"
      disabled={isLoading}
      onClick={() => {
        void handleClick();
      }}
    >
      <ExternalLink className="mr-2 h-4 w-4" />
      Manage Balance Online
    </Button>
  );
}
