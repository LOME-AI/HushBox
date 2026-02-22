/**
 * Centralized route constants.
 * Single source of truth for all navigation paths.
 */
export const ROUTES = {
  // Main app routes
  CHAT: '/chat',
  CHAT_NEW: '/chat/new',
  CHAT_ID: '/chat/$id',
  CHAT_TRIAL: '/chat/trial',
  PROJECTS: '/projects',
  BILLING: '/billing',
  SETTINGS: '/settings',

  // Auth routes
  LOGIN: '/login',
  SIGNUP: '/signup',
  VERIFY: '/verify',

  // Share routes (public, no auth required)
  SHARE_CONVERSATION: '/share/c/$conversationId',
  SHARE_MESSAGE: '/share/m/$shareId',

  // Legal routes (public, no auth)
  PRIVACY: '/privacy',
  TERMS: '/terms',

  // Dev routes
  DEV_PERSONAS: '/dev/personas',
} as const;
