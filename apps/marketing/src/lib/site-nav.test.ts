import { describe, it, expect } from 'vitest';
import { ROUTES } from '@hushbox/shared/routes';
import { SITE_NAV_LINKS, isCurrentNavLink } from './site-nav';

describe('SITE_NAV_LINKS', () => {
  it('lists the four site pages in header order', () => {
    expect(SITE_NAV_LINKS.map((link) => link.label)).toEqual([
      'Welcome',
      'Blog',
      'Roadmap',
      'Leaderboard',
    ]);
  });

  it('takes every href from the shared routes', () => {
    expect(SITE_NAV_LINKS.map((link) => link.href)).toEqual([
      ROUTES.MARKETING,
      ROUTES.BLOG,
      ROUTES.ROADMAP,
      ROUTES.LEADERBOARD,
    ]);
  });
});

describe('isCurrentNavLink', () => {
  it('marks the link whose page is being shown', () => {
    expect(isCurrentNavLink(ROUTES.ROADMAP, ROUTES.ROADMAP)).toBe(true);
  });

  it('ignores a trailing slash on the shown page', () => {
    expect(isCurrentNavLink(`${ROUTES.LEADERBOARD}/`, ROUTES.LEADERBOARD)).toBe(true);
  });

  it('counts a blog post as the Blog page', () => {
    expect(isCurrentNavLink(`${ROUTES.BLOG}/what-is-opaque-authentication`, ROUTES.BLOG)).toBe(
      true
    );
  });

  it('leaves another page unmarked', () => {
    expect(isCurrentNavLink(ROUTES.MARKETING, ROUTES.BLOG)).toBe(false);
  });

  it('leaves a page whose path merely starts with the same letters unmarked', () => {
    expect(isCurrentNavLink(`${ROUTES.BLOG}roll`, ROUTES.BLOG)).toBe(false);
  });

  it('leaves every link unmarked on a page outside the nav', () => {
    const shown = SITE_NAV_LINKS.filter((link) => isCurrentNavLink('/newsletter', link.href));

    expect(shown).toEqual([]);
  });
});
