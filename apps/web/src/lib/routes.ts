import { ROUTES } from '@hushbox/shared';

/** Drizzle Studio URL — only accessible during local development. */
export const DRIZZLE_STUDIO_URL = 'https://local.drizzle.studio';

/**
 * Helper for conversation route with ID substitution.
 */
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
