/**
 * Centralized route constants.
 * Single source of truth for all navigation paths.
 */
export const ROUTES = {
  // Main app routes
  CHAT: '/chat',
  CHAT_CONVERSATION: '/chat/$conversationId',
  PROJECTS: '/projects',
  BILLING: '/billing',

  // Auth routes
  LOGIN: '/login',
  SIGNUP: '/signup',
  VERIFY: '/verify',

  // Dev routes
  DEV_PERSONAS: '/dev/personas',
} as const;

export type RouteKey = keyof typeof ROUTES;
export type RoutePath = (typeof ROUTES)[RouteKey];

/**
 * Helper for conversation route with ID substitution.
 */
export function chatConversationRoute(conversationId: string): string {
  return `${ROUTES.CHAT}/${conversationId}`;
}
