import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';

/**
 * The terminal state for an identity the admin plane refuses. It states only
 * that this identity is not authorized: the Worker answers a missing assertion,
 * a failed verification, an absent email claim, and an unlisted actor with one
 * indistinguishable body, and telling them apart here would rebuild in the
 * client the identity oracle the server deliberately refuses to be.
 *
 * Nothing on it retries. Reaching it means every reload the app was willing to
 * spend has been spent, so an action inviting another one would only restart
 * the loop this screen exists to end.
 */
export function AccessDeniedScreen(): React.JSX.Element {
  return (
    <div
      role="alert"
      data-testid={TEST_IDS.adminAccessDenied}
      className="bg-background text-foreground flex h-dvh flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <h1 className="text-lg font-semibold">Not authorized</h1>
      <p className="text-muted-foreground max-w-md text-sm">
        This identity is not authorized for the admin plane.
      </p>
    </div>
  );
}
