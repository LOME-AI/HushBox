/**
 * Centralized route constants.
 * Single source of truth for all navigation paths.
 */
export const ROUTES = {
  // Main app routes
  CHAT: '/chat',
  CHAT_NEW: '/chat/new',
  CHAT_ID: '/chat/$id',
  CHAT_GUEST: '/chat/guest',
  PROJECTS: '/projects',
  BILLING: '/billing',

  // Auth routes
  LOGIN: '/login',
  SIGNUP: '/signup',
  VERIFY: '/verify',

  // Dev routes
  DEV_PERSONAS: '/dev/personas',
} as const;

/**
 * Helper for conversation route with ID substitution.
 */
export function chatConversationRoute(conversationId: string): string {
  return `${ROUTES.CHAT}/${conversationId}`;
}
