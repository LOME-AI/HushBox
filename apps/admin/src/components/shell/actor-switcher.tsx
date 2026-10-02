import * as React from 'react';
import { UserRoundCog } from 'lucide-react';
import { Button } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { isDevAuthEnabled } from '@/lib/env';
import { queryClient } from '@/providers/query-provider';
import { DEV_ADMIN_ACTORS, getDevActor, setDevActor, useDevActor } from '@/lib/dev-actor';

/** The part of an actor's address that distinguishes it from the others. */
function shortName(actor: string): string {
  return actor.replace(/@.*/, '');
}

function ActorSwitcherControl(): React.JSX.Element {
  const actor = useDevActor();

  return (
    <div
      role="group"
      aria-label="Dev actor"
      title="Dev actor: the identity the dev-auth wrapper mints tokens for"
      data-testid={TEST_IDS.adminActorSwitcher}
      // The buttons wrap: at a phone width under the accessibility widget's
      // largest font tier one button per allowlisted actor is wider than the
      // topbar's line, and a group held to one line hangs off it over the nav.
      className="border-border flex flex-wrap items-center gap-1 rounded-md border p-0.5"
    >
      <UserRoundCog className="text-muted-foreground mx-1 h-4 w-4" aria-hidden="true" />
      {DEV_ADMIN_ACTORS.map((each) => (
        <Button
          key={each}
          variant={each === actor ? 'secondary' : 'ghost'}
          size="sm"
          aria-label={each}
          aria-pressed={each === actor}
          className="h-6 px-2 font-mono text-xs"
          onClick={() => {
            // Identity is what the plane authorizes against, so everything read
            // under the old one is dropped rather than left on screen: these
            // three actors do not share a role, and a cached catalogue from a
            // wider one draws controls this actor's mutations would be refused.
            // The cache is reached through the module that owns it rather than
            // through context, so this piece of chrome renders wherever the
            // topbar does instead of requiring a provider around it.
            if (getDevActor() === each) return;
            setDevActor(each);
            // Reset rather than clear: a cleared cache leaves a mounted screen
            // holding the result it already had, so the previous identity's
            // reads stay on screen until something else re-renders. A reset
            // drops the data AND re-reads it under the identity just chosen.
            void queryClient.resetQueries();
          }}
        >
          {shortName(each)}
        </Button>
      ))}
    </div>
  );
}

/**
 * Dev/E2E-only control naming the identity the dev-auth wrapper mints tokens
 * for, and offering every identity the allowlist admits — a list rather than a
 * swap, because the actors do not share one role and no pair of them is the
 * whole set. Renders nothing in production, where Cloudflare Access supplies
 * the identity at the edge.
 */
export function ActorSwitcher(): React.JSX.Element | null {
  if (!isDevAuthEnabled()) {
    return null;
  }
  return <ActorSwitcherControl />;
}
