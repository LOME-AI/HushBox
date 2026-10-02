import { ROUTES } from '@hushbox/shared/routes';

export interface SiteNavLink {
  label: 'Welcome' | 'Blog' | 'Roadmap' | 'Leaderboard';
  href: string;
}

/** The site's pages, in the order the header and the phone menu list them. */
export const SITE_NAV_LINKS: readonly SiteNavLink[] = [
  { label: 'Welcome', href: ROUTES.MARKETING },
  { label: 'Blog', href: ROUTES.BLOG },
  { label: 'Roadmap', href: ROUTES.ROADMAP },
  { label: 'Leaderboard', href: ROUTES.LEADERBOARD },
];

/** Whether `href` names the page at `pathname`; a page beneath it (a blog post) counts as it. */
export function isCurrentNavLink(pathname: string, href: string): boolean {
  const shown = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return shown === href || shown.startsWith(`${href}/`);
}
