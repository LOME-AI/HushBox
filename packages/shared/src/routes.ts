/** Production marketing site base URL (used for native deep links and external page opens). */
export const MARKETING_BASE_URL = 'https://hushbox.ai';

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
  USAGE: '/usage',
  SETTINGS: '/settings',

  // Auth routes
  LOGIN: '/login',
  SIGNUP: '/signup',
  VERIFY: '/verify',

  // Share routes (public, no auth required)
  SHARE_CONVERSATION: '/share/c/$conversationId',
  SHARE_MESSAGE: '/share/m/$shareId',

  // Marketing / legal routes (public, no auth)
  MARKETING: '/welcome',
  BLOG: '/blog',
  PRIVACY: '/privacy',
  TERMS: '/terms',

  // Dev routes
  DEV_PERSONAS: '/dev/personas',
  DEV_EMAILS: '/dev/emails',
  DEV_ASSETS: '/dev/assets',
  DEV_RENDER_ASSET: '/dev/render-asset/$name',
} as const;

export const FOOTER_LINKS = [
  { group: 'Product', label: 'Welcome', href: ROUTES.MARKETING },
  { group: 'Product', label: 'Chat', href: ROUTES.CHAT },
  { group: 'Product', label: 'Blog', href: ROUTES.BLOG },
  { group: 'Account', label: 'Log In', href: ROUTES.LOGIN },
  { group: 'Account', label: 'Sign Up', href: ROUTES.SIGNUP },
  { group: 'Legal', label: 'Privacy', href: ROUTES.PRIVACY },
  { group: 'Legal', label: 'Terms', href: ROUTES.TERMS },
] as const;
