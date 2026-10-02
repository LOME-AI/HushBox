import * as React from 'react';
import { useState, useEffect } from 'react';
import { z } from 'zod';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Logo } from '@hushbox/ui';
import { Button, ButtonRow, Spinner } from '@hushbox/ui/button';
import { ArrowUpRight, Clock, Icon } from '@hushbox/ui/icons';
import { Heading, Text } from '@hushbox/ui/type';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import {
  APP_RETURN_TO_BILLING_URL,
  MANAGE_BALANCE_ONLINE_LABEL,
} from '@hushbox/shared/billing-portal';
import { authClient } from '@/lib/auth/auth';
import { BillingContent } from '@/components/billing/billing-content';
import { ThemeToggle } from '@/components/shared/theme-toggle';

export interface BillingPortalSearch {
  token: string | undefined;
}

const tokenSchema = z.string();

export const Route = createFileRoute('/billing-portal')({
  validateSearch: (search: Record<string, unknown>): BillingPortalSearch => {
    const token = tokenSchema.safeParse(search['token']);
    return { token: token.success ? token.data : undefined };
  },
  component: BillingPortalPage,
});

function ExpiredLink(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col overflow-y-auto px-4 pt-8 pb-16">
      <div
        className="m-auto flex w-full max-w-sm flex-col items-center gap-3 text-center text-pretty"
        data-testid={TEST_IDS.billingPortalError}
      >
        <span
          aria-hidden="true"
          className="bg-brand-red-subtle text-brand-red mb-1 grid size-12 place-items-center rounded-full"
        >
          <Icon icon={Clock} size="xl" />
        </span>
        <Heading level={1} variant="auth-title">
          Link expired
        </Heading>
        <Text variant="ui" tone="muted">
          This link has expired or was already used. For a new one, open the HushBox app and tap{' '}
          {/* An inline block keeps the button's name on one line while it fits, and lets it
              wrap inside itself only when a line cannot hold it. */}
          <b className="text-foreground inline-block font-semibold">
            {MANAGE_BALANCE_ONLINE_LABEL}
          </b>
          .
        </Text>
        <Button asChild block size="lg" className="mt-3">
          <Link to={ROUTES.LOGIN}>Log in</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * Drawn in the balance card once a purchase completes. The pair stacks when its labels no
 * longer fit side by side, and a stacked row reverses its markup, so Return to the app is
 * both drawn and reached first there, and Add Credits first side by side.
 */
function renderPurchasedActions({ openPayment }: { openPayment: () => void }): React.JSX.Element {
  return (
    <ButtonRow stack="labels" stackedOrder="reverse">
      <Button variant="outline" size="lg" onClick={openPayment}>
        Add Credits
      </Button>
      <Button asChild size="lg" data-testid={TEST_IDS.returnToAppLink}>
        <a href={APP_RETURN_TO_BILLING_URL}>
          Return to the app
          <Icon icon={ArrowUpRight} />
        </a>
      </Button>
    </ButtonRow>
  );
}

function BillingPortalPage(): React.JSX.Element {
  const { token } = Route.useSearch();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (!token) {
      globalThis.location.href = '/login';
      return;
    }

    const validToken = token;
    async function exchangeToken(): Promise<void> {
      const result = await authClient.tokenLogin({ token: validToken });
      setState(result.error ? 'error' : 'ready');
    }

    void exchangeToken();
  }, [token]);

  const isReady = state === 'ready';

  // One `main#main` wraps every branch, so the element the route announcer focused
  // while the token exchange ran stays mounted when the portal settles.
  return (
    <div
      className="flex h-full flex-col"
      data-testid={isReady ? TEST_IDS.billingPortal : undefined}
    >
      {state !== 'loading' && (
        <header data-chrome="" className="flex items-center justify-between border-b px-4 py-3">
          <Link to={ROUTES.CHAT} aria-label="HushBox - Go to chat">
            <Logo />
          </Link>
          <ThemeToggle />
        </header>
      )}
      <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col">
        {state === 'loading' && (
          <div className="flex h-full items-center justify-center">
            <Spinner className="text-primary size-8" />
          </div>
        )}
        {state === 'error' && <ExpiredLink />}
        {isReady && <BillingContent surface="portal" purchasedActions={renderPurchasedActions} />}
      </main>
    </div>
  );
}
