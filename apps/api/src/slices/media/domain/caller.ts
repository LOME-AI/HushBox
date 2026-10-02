import { okAsync } from '../../../lib/result/index.js';
import { resolveLinkGuestPrincipal } from '../../identity/index.js';
import type { Principal } from '../../../lib/context/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { LinkResolutionPort } from '../../identity/index.js';
import type { PresignPrincipal } from './presign-authz.js';

/**
 * Re-exported so the slice's consumers reach the credential header through its
 * own barrel. The HTTP route-class matrix admits no link-guest principal, so
 * media presign is a `public` route that resolves the credential itself and
 * authorizes by typed match — the seam the principal contract reserves for
 * realtime and media.
 */
export { LINK_CREDENTIAL_HEADER } from '@hushbox/shared';

interface ResolveMediaCallerArgs {
  readonly principal: Principal;
  readonly linkCredential: string | undefined;
  readonly linkResolution: LinkResolutionPort;
}

/**
 * Resolves the member-path caller: a full session wins outright; otherwise a
 * presented link credential may resolve to a link guest. `null` means
 * unauthenticated — a mid-2FA session and the billing-portal credential are
 * deliberately NOT admitted; the epoch gate downstream is identical for
 * both caller kinds.
 */
export function resolveMediaCaller(
  args: ResolveMediaCallerArgs
): ResultAsync<PresignPrincipal | null, DomainError> {
  if (args.principal.kind === 'full') {
    return okAsync({ kind: 'user', userId: args.principal.claims.userId });
  }
  if (args.linkCredential === undefined) {
    return okAsync(null);
  }
  return resolveLinkGuestPrincipal({
    port: args.linkResolution,
    credential: args.linkCredential,
  }).map((resolution) =>
    resolution.kind === 'link-guest' ? { kind: 'linkGuest', linkId: resolution.linkId } : null
  );
}
