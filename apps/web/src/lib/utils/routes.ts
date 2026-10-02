import { ROUTES } from '@hushbox/shared';

/**
 * Build the hosted Drizzle Studio URL pointing at the local studio server.
 * The hosted client reads `host` and `port` from the query string, so each
 * worktree's studio (started on its own offset port by `pnpm dev`) gets a
 * routable link instead of every worktree fighting over the default 4983.
 *
 * Throws if `localStudioUrl` isn't a parseable URL — that means the env config
 * is wrong and the caller should surface it, not silently render a dead link.
 */
export function buildDrizzleStudioUrl(localStudioUrl: string): string {
  const parsed = new URL(localStudioUrl);
  return `https://local.drizzle.studio?host=${parsed.hostname}&port=${parsed.port}`;
}

export function chatConversationRoute(conversationId: string): string {
  return `${ROUTES.CHAT}/${conversationId}`;
}

/**
 * Constructs a share conversation URL with the link private key in the fragment.
 * The fragment is never sent to the server, preserving E2E encryption.
 */
export function shareConversationRoute(
  conversationId: string,
  linkPrivateKeyBase64: string
): string {
  const [prefix = ''] = ROUTES.SHARE_CONVERSATION.split('$');
  return `${prefix}${conversationId}#${linkPrivateKeyBase64}`;
}

/**
 * Constructs a share message URL with the share key in the fragment.
 * The fragment is never sent to the server, preserving E2E encryption.
 */
export function shareMessageRoute(shareId: string, shareKeyBase64: string): string {
  const [prefix = ''] = ROUTES.SHARE_MESSAGE.split('$');
  return `${prefix}${shareId}#${shareKeyBase64}`;
}
