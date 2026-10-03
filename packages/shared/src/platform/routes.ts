/** Production marketing site base URL (used for native deep links and external page opens). */
export const MARKETING_BASE_URL = 'https://hushbox.ai';

/**
 * The `$id` route param a chat page carries before its conversation exists.
 * The composer runs against it, the first send creates the real conversation,
 * and the route then swaps to that id. One constant because every reader has to
 * agree on the sentinel to tell "not created yet" from a real conversation id —
 * six files were matching the bare literal.
 */
export const PRE_CREATION_CONVERSATION_ID = 'new';

/**
 * Centralized route constants.
 * Single source of truth for all navigation paths.
 */
export const ROUTES = {
  CHAT: '/chat',
  CHAT_NEW: `/chat/${PRE_CREATION_CONVERSATION_ID}`,
  CHAT_ID: '/chat/$id',
  CHAT_TRIAL: '/chat/trial',
  BILLING: '/billing',
  BILLING_PORTAL: '/billing-portal',
  USAGE: '/usage',
  SETTINGS: '/settings',
  ACCESSIBILITY: '/accessibility',
  DEMO: '/demo',

  LOGIN: '/login',
  SIGNUP: '/signup',
  VERIFY: '/verify',

  SHARE_CONVERSATION: '/share/c/$conversationId',
  SHARE_MESSAGE: '/share/m/$shareId',

  MARKETING: '/welcome',
  BLOG: '/blog',
  NEWSLETTER: '/newsletter',
  NEWSLETTER_CONFIRMED: '/newsletter/confirmed',
  NEWSLETTER_UNSUBSCRIBED: '/newsletter/unsubscribed',
  ROADMAP: '/roadmap',
  LEADERBOARD: '/leaderboard',
  PRIVACY: '/privacy',
  TERMS: '/terms',

  DEV_PERSONAS: '/dev/personas',
  DEV_EMAILS: '/dev/emails',
  DEV_ASSETS: '/dev/assets',
  DEV_KIT: '/dev/kit',
  DEV_RENDER_ASSET: '/dev/render-asset/$name',
} as const;

/**
 * Routes served by the Astro marketing site (prerendered HTML with hashed
 * inline scripts via `experimental.csp`). Consumed by
 * `scripts/generate-headers.ts` to decide which paths get the per-page CSP
 * with extracted hashes vs the SPA `/*` fallback. Add a new entry here AND
 * an Astro page under `apps/marketing/src/pages/` together — the generator
 * fails loud if a listed route has no matching built HTML.
 */
export const MARKETING_ROUTES = [
  ROUTES.MARKETING,
  ROUTES.BLOG,
  ROUTES.NEWSLETTER,
  ROUTES.ROADMAP,
  ROUTES.LEADERBOARD,
  ROUTES.PRIVACY,
  ROUTES.TERMS,
] as const;

/**
 * Routes the web app serves only in development: each one's page redirects away
 * unless `env.isDev`, so production serves none of them.
 */
export const DEVELOPMENT_ROUTES: readonly string[] = Object.values(ROUTES).filter((route) =>
  route.startsWith('/dev/')
);

/**
 * Marketing pages under `apps/marketing/src/pages/` that are deliberately NOT
 * in `MARKETING_ROUTES` — special error pages served under the SPA `/*`
 * `_headers` CSP block. They must never get a per-path hashed CSP: `404.astro`
 * relies on an inline theme pre-paint script that a per-page `experimental.csp`
 * hash set would block. The coverage test in `scripts/generate-headers.test.ts`
 * exempts exactly these filenames; every other page must be a `MARKETING_ROUTES`
 * prefix. Keep this list minimal — only genuinely-special error pages belong.
 */
export const NON_ROUTE_MARKETING_PAGES = ['404.astro'] as const;

export const FOOTER_LINKS = [
  { group: 'Product', label: 'Welcome', href: ROUTES.MARKETING },
  { group: 'Product', label: 'Chat', href: ROUTES.CHAT },
  { group: 'Product', label: 'Blog', href: ROUTES.BLOG },
  { group: 'Product', label: 'Roadmap', href: ROUTES.ROADMAP },
  { group: 'Product', label: 'Leaderboard', href: ROUTES.LEADERBOARD },
  { group: 'Account', label: 'Log In', href: ROUTES.LOGIN },
  { group: 'Account', label: 'Sign Up', href: ROUTES.SIGNUP },
  { group: 'Legal', label: 'Privacy', href: ROUTES.PRIVACY },
  { group: 'Legal', label: 'Terms', href: ROUTES.TERMS },
] as const;
