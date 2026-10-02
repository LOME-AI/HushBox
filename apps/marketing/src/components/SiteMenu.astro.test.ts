import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// No DOM harness renders `.astro` files in this app, so the menu panel is asserted against
// its source, as SiteHeader.astro.test.ts does.
const source = readFileSync(path.resolve(__dirname, './SiteMenu.astro'), 'utf8');
const template = source.slice(source.indexOf('---', 3) + 3);

/**
 * The opening tag of the first element whose opening matches `opening`. A class value may
 * hold `>` (`[&>astro-island]:block`), so the tag ends at the first `>` after a closing
 * quote or brace.
 */
function openingTag(opening: RegExp): string {
  const start = template.search(opening);
  if (start === -1) throw new Error(`SiteMenu has no element matching ${String(opening)}`);
  const tag = /^<[\s\S]*?["}]\s*>/.exec(template.slice(start))?.[0];
  if (tag === undefined) throw new Error(`SiteMenu has an unclosed tag at ${String(opening)}`);
  return tag;
}

describe('SiteMenu panel', () => {
  const panel = openingTag(/<div\s+id="landing-mobile-menu"/);

  it('keeps the menu test id', () => {
    expect(panel).toContain('data-testid={TEST_IDS.landingMobileMenu}');
  });

  it('is the element the menu script drives', () => {
    expect(panel).toMatch(/\sdata-site-menu-panel[\s>]/);
  });

  it('is in the built page, hidden until opened', () => {
    expect(panel).toMatch(/\shidden[\s>]/);
    expect(template).not.toMatch(/^\s*\{\s*\w+\s*&&/m);
  });

  it('fills the screen under the header and the banner', () => {
    expect(panel).toContain('h-[calc(100dvh-var(--header-height)-var(--hb-banner-height))]');
  });

  it('starts under the header border', () => {
    expect(panel).toContain('top-[calc(100%+1px)]');
  });

  it('is solid', () => {
    expect(panel).toMatch(/class="[^"]*\bbg-background\b(?!\/)/);
  });
});

describe('SiteMenu links', () => {
  it('lists the site pages from the one site list', () => {
    expect(source).toContain("import { SITE_NAV_LINKS, isCurrentNavLink } from '../lib/site-nav'");
    expect(template.match(/SITE_NAV_LINKS\.map\(/g)).toHaveLength(1);
  });

  it('marks the current page', () => {
    expect(template).toContain(
      "aria-current={isCurrentNavLink(Astro.url.pathname, link.href) ? 'page' : undefined}"
    );
  });

  it('sets the page links large and centred in the reading serif', () => {
    const link = openingTag(/<a\s+href=\{link\.href\}/);
    expect(link).toMatch(/\bfont-serif\b/);
    expect(link).toMatch(/\btext-title-1\b/);
    expect(link).toMatch(/\bjustify-center\b/);
    expect(link).toMatch(/\bmin-h-14\b/);
  });

  it('draws the current page in Signal Red with a dot', () => {
    const link = openingTag(/<a\s+href=\{link\.href\}/);
    expect(link).toMatch(/\baria-\[current=page\]:text-brand-red\b/);
    expect(link).toMatch(/\baria-\[current=page\]:after:bg-brand-red\b/);
    expect(link).toMatch(/\baria-\[current=page\]:after:rounded-full\b/);
  });

  // Forced colors repaints the red text and the dot's fill to the system palette, so the
  // dot keeps a system colour there or the panel loses its only current-page cue.
  it('draws the current-page dot in a system colour under forced colors', () => {
    const link = openingTag(/<a\s+href=\{link\.href\}/);
    expect(link).toMatch(/\baria-\[current=page\]:forced-colors:after:bg-\[LinkText\](?=\s|")/);
  });

  it('lists the page links before the buttons, so Tab reaches them first', () => {
    expect(template.indexOf('SITE_NAV_LINKS.map(')).toBeLessThan(template.indexOf('<GitHubLink'));
  });
});

describe('SiteMenu buttons', () => {
  const stack = openingTag(/<div\s+class:list=\{\[buttonStackClass/);

  it('stacks GitHub and Open HushBox through the shared button stack', () => {
    expect(source).toContain("import { buttonStackClass } from '@hushbox/ui/button-groups'");
    expect(stack).toBeTruthy();
  });

  it('draws both buttons at the touch height the phone menu gives them', () => {
    expect(stack).toMatch(/'[^']*\*:min-h-11\b/);
  });

  it('draws GitHub through the shared link in its menu form', () => {
    expect(template).toContain('<GitHubLink stars={stars} variant="menu" />');
  });

  it('opens HushBox at the chat route as a large primary button', () => {
    expect(template).toMatch(
      /<a href=\{ROUTES\.CHAT\} class=\{buttonVariants\(\{ size: 'lg' \}\)\}>\s*Open HushBox\s*<\/a>/
    );
  });

  it('puts GitHub above Open HushBox', () => {
    expect(template.indexOf('<GitHubLink')).toBeLessThan(template.indexOf('Open HushBox'));
  });
});

describe('SiteMenu cipher wall', () => {
  const band = openingTag(/<div\s+aria-hidden="true"/);

  it('mounts the wall when the panel first shows', () => {
    expect(template).toMatch(/<CipherWall\s+client:visible\b/);
  });

  it('shows the landing messages', () => {
    expect(template).toMatch(/messages=\{LANDING_CIPHER_MESSAGES\}/);
  });

  it('leaves the fade to its wrapper', () => {
    expect(template).toMatch(/fadeMask="none"/);
  });

  it('fades the band in from the top by a mask on its wrapper', () => {
    expect(band).toContain('[mask-image:linear-gradient(to_bottom,transparent,black_45%)]');
  });

  it('fills the space under the buttons', () => {
    expect(band).toMatch(/\bflex-1\b/);
    expect(band).toMatch(/\bmin-h-28\b/);
  });

  it('gives the wall island a box to size its canvas by', () => {
    expect(band).toContain('[&>astro-island]:absolute');
    expect(band).toContain('[&>astro-island]:inset-0');
  });

  // Astro styles its islands `display: contents` outside any cascade layer, which outranks
  // every layered utility unless the utility is important.
  it('gives the wall island a box over the island style Astro sets', () => {
    expect(band).toContain('[&>astro-island]:block!');
  });

  it('comes after the buttons', () => {
    expect(template.indexOf('Open HushBox')).toBeLessThan(template.indexOf('<CipherWall'));
  });
});
