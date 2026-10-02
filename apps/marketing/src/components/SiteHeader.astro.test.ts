import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { Logo, ReleaseStageBadge } from '@hushbox/ui';

// No DOM harness renders `.astro` files in this app, so the header is asserted against
// its source, as PageHero.astro.test.ts does.
const source = readFileSync(path.resolve(__dirname, './SiteHeader.astro'), 'utf8');

/** The markup of the element opened by the first tag matching `opening`, up to its close. */
function elementSource(opening: RegExp, closing: string): string {
  const start = source.search(opening);
  if (start === -1) throw new Error(`SiteHeader has no element matching ${String(opening)}`);
  return source.slice(start, source.indexOf(closing, start) + closing.length);
}

describe('SiteHeader width steps', () => {
  it('splits the header at 768 and at no other width', () => {
    expect(source).not.toMatch(/\b(?:sm|lg|xl|2xl):/);
  });

  it('shows the desktop nav from 768', () => {
    expect(elementSource(/<nav\b/, '</nav>')).toMatch(/class="[^"]*\bhidden\b[^"]*\bmd:flex\b/);
  });

  it('spaces the desktop nav 1.25rem apart', () => {
    expect(elementSource(/<nav\b/, '</nav>')).toMatch(/class="[^"]*\bgap-5\b/);
  });

  it('hides the compact row from 768', () => {
    expect(source).toMatch(/<div\s+class="[^"]*\bmd:hidden\b[^"]*"\s*>\s*<ThemeToggle/);
  });
});

// Under the accessibility widget's largest text a 320 phone cannot hold the logo, the
// theme toggle and the menu button at their scaled sizes, so the row's spacing and the
// wordmark stop growing at a share of the viewport; at the default text size each
// share is at least the fixed size from 320 up, so nothing moves there.
describe('SiteHeader row under large text', () => {
  const row =
    /<div\s+data-site-header-row\s+class="([^"]*)"\s*>\s*<a href=\{ROUTES\.MARKETING\}/.exec(
      source
    )?.[1] ?? '';

  it('caps the side padding at a share of the viewport', () => {
    expect(row.split(' ')).toContain('px-[min(1.5rem,7.5vw)]');
  });

  it('caps the gap between the logo and the controls at a share of the viewport', () => {
    expect(row.split(' ')).toContain('gap-[min(1rem,5vw)]');
  });

  it('caps the gap between the compact controls at a share of the viewport', () => {
    expect(source).toMatch(
      /<div\s+class="[^"]*\bgap-\[min\(0\.5rem,2\.5vw\)\][^"]*"\s*>\s*<ThemeToggle/
    );
  });

  it('caps the wordmark at a share of the viewport', () => {
    expect(source).toContain(
      '<Logo className="[&>span]:text-[length:min(var(--text-lg),5.625vw)]" />'
    );
  });

  // The wordmark cap selects the logo's direct-child span, so the header's class reaches
  // the wordmark only while the shared Logo draws it that way.
  it('reaches the real wordmark through the header class', () => {
    const logoClass = /<Logo className="([^"]+)" \/>/.exec(source)?.[1] ?? '';
    const { container } = render(createElement(Logo, { className: logoClass }));

    expect(container.querySelector(`[data-testid="${TEST_IDS.logo}"] > span`)?.textContent).toBe(
      'HushBox'
    );
  });
});

describe('SiteHeader links', () => {
  it('renders the page links from the one site list', () => {
    expect(source).toContain("import { SITE_NAV_LINKS, isCurrentNavLink } from '../lib/site-nav'");
    expect(elementSource(/<nav\b/, '</nav>')).toContain('SITE_NAV_LINKS.map(');
  });

  it('marks the current page on the rendered page links', () => {
    expect(elementSource(/<nav\b/, '</nav>')).toContain(
      "aria-current={isCurrentNavLink(Astro.url.pathname, link.href) ? 'page' : undefined}"
    );
  });

  it('offers no Log In or Sign Up', () => {
    expect(source).not.toMatch(/Log In|Sign Up|ROUTES\.LOGIN|ROUTES\.SIGNUP/);
  });

  it('opens HushBox at the chat route as a small primary button in the desktop nav', () => {
    expect(elementSource(/<nav\b/, '</nav>')).toMatch(
      /<a href=\{ROUTES\.CHAT\} class=\{buttonVariants\(\{ size: 'sm' \}\)\}>\s*Open HushBox\s*<\/a>/
    );
  });

  it('draws GitHub through the shared link in its nav form', () => {
    expect(elementSource(/<nav\b/, '</nav>')).toContain(
      '<GitHubLink stars={starCount} variant="nav" />'
    );
  });
});

describe('SiteHeader release stage', () => {
  // The logo link closes before the badge opens, so a badge nested inside it fails too.
  it('draws the badge right after the logo link, outside it', () => {
    expect(source).toMatch(
      /<a href=\{ROUTES\.MARKETING\}[^>]*>[\s\S]*?<\/a>\s*<ReleaseStageBadge\b/
    );
  });

  // The anchor's literal holds the spread and the merged class and nothing else, so no key
  // can override the href or name the badge hands it.
  it('hands the badge a link that keeps what the badge gives it on an anchor', () => {
    expect(source).toContain('<ReleaseStageBadge link={releaseStageLink} />');
    expect(source).toMatch(
      /function releaseStageLink\(\{\s*className,\s*\.\.\.props\s*\}[^)]*\)[^{]*\{\s*return createElement\('a', \{\s*\.\.\.props,\s*className: cn\(\s*className,\s*'[^']*',?\s*\),?\s*\}\);\s*\}/
    );
  });

  it('links the badge to the beta section of the Terms', () => {
    const { getByRole } = render(
      createElement(ReleaseStageBadge, { link: (props) => createElement('a', props) })
    );

    expect(getByRole('link', { name: 'Beta: read what that means' }).getAttribute('href')).toBe(
      '/terms#beta'
    );
  });
});

describe('SiteHeader drawing', () => {
  it('draws no raw svg', () => {
    expect(source).not.toMatch(/<svg\b/);
  });

  it('draws no raw button', () => {
    expect(source).not.toMatch(/<button\b/);
  });

  it('keeps the menu toggle id and test id', () => {
    expect(source).toContain('id="landing-menu-toggle"');
    expect(source).toContain('data-testid={TEST_IDS.landingMenuToggle}');
  });
});

describe('SiteHeader menu', () => {
  const toggle = elementSource(/<IconButton\b/, '/>');

  it('renders the menu panel inside the header with the star count', () => {
    expect(source).toContain("import SiteMenu from './SiteMenu.astro'");
    expect(elementSource(/<header\b/, '</header>')).toContain('<SiteMenu stars={starCount} />');
  });

  it('names the menu button Open menu until script opens the panel', () => {
    expect(toggle).toContain('aria-label="Open menu"');
  });

  it('ties the menu button to the panel it opens', () => {
    expect(toggle).toContain('aria-controls="landing-mobile-menu"');
    expect(toggle).toContain('aria-expanded="false"');
  });

  it('marks the menu button for the menu script', () => {
    expect(toggle).toContain('data-site-menu-toggle');
  });

  it('draws the menu glyph while closed and a close glyph while open', () => {
    expect(source).toMatch(/icon: Menu, size: 'xl', className: 'in-aria-expanded:hidden'/);
    expect(source).toMatch(/icon: X, size: 'xl', className: 'hidden in-aria-expanded:block'/);
  });

  it('runs the header through the menu script, bundled rather than inline', () => {
    expect(source).toContain("import { initSiteMenu } from '../lib/site-menu';");
    expect(source).not.toContain('is:inline');
  });

  it('marks the header and its row for the menu script', () => {
    expect(elementSource(/<header\b/, '>')).toContain('data-site-header');
    expect(source).toMatch(/<div\s+data-site-header-row\b/);
    expect(elementSource(/<nav\b/, '>')).toContain('data-site-nav');
  });
});

// From 768 the menu script sets data-nav-compact on the header whenever the full nav does
// not fit its row; the stylesheet then swaps the nav for the compact row.
describe('SiteHeader fallback to the menu', () => {
  it('names the header as the group the swap reads', () => {
    expect(elementSource(/<header\b/, '>')).toMatch(/class="[^"]*\bgroup\/site-header\b/);
  });

  it('hides the full nav while the header is compact', () => {
    expect(elementSource(/<nav\b/, '>')).toMatch(
      /class="[^"]*\bgroup-data-\[nav-compact\]\/site-header:hidden\b/
    );
  });

  it('shows the compact row while the header is compact', () => {
    expect(source).toMatch(
      /<div\s+class="[^"]*\bgroup-data-\[nav-compact\]\/site-header:flex\b[^"]*"\s*>\s*<ThemeToggle/
    );
  });
});
