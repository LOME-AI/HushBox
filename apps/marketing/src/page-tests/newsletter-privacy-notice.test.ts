import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No DOM harness renders `.astro` files in this app, so the notice and its placement are asserted
// against source. The notice reaches the newsletter island as slot content so React never owns its
// link, which the growth script rewrites before the island hydrates. Lives outside src/pages/
// because Astro routes every file under that directory.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const noticeSource = readFileSync(
  path.resolve(currentDir, '../components/newsletter/NewsletterPrivacyNotice.astro'),
  'utf8'
);

function anchorOpeningTag(): string {
  const tag = /<a\b[^>]*>/.exec(noticeSource)?.[0];
  if (tag === undefined) {
    throw new Error('NewsletterPrivacyNotice.astro renders no anchor');
  }
  return tag;
}

function visibleText(): string {
  const markup = noticeSource.replace(/^---[\s\S]*?---/, '');
  return markup
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

describe('NewsletterPrivacyNotice.astro', () => {
  it('renders the confirm, unsubscribe and Privacy Policy line', () => {
    expect(visibleText()).toBe(
      'We’ll email a link to confirm. Unsubscribe any time. Privacy Policy'
    );
  });

  it('links Privacy Policy to the privacy route', () => {
    expect(noticeSource).toContain("import { ROUTES } from '@hushbox/shared/routes';");
    expect(anchorOpeningTag()).toContain('href={ROUTES.PRIVACY}');
  });

  it.each(['text-primary', 'hover:text-brand-red-hover', 'underline', 'underline-offset-4'])(
    'styles the Privacy Policy link with %s',
    (className) => {
      const classes = /class="([^"]*)"/.exec(anchorOpeningTag())?.[1]?.split(/\s+/) ?? [];
      expect(classes).toContain(className);
    }
  );

  it("hides the Privacy Policy link's browser outline only while it has keyboard focus", () => {
    const classes = /class="([^"]*)"/.exec(anchorOpeningTag())?.[1]?.split(/\s+/) ?? [];
    expect(classes.filter((token) => /(^|:)outline-(none|hidden)$/.test(token))).toEqual([
      'focus-visible:outline-hidden',
    ]);
  });

  it('does not style the Privacy Policy link in ink', () => {
    expect(anchorOpeningTag()).not.toContain('text-foreground');
  });
});

describe.each(['welcome.astro', 'blog/[slug].astro', 'newsletter.astro'])(
  '%s newsletter form',
  (page) => {
    const source = readFileSync(path.resolve(currentDir, '../pages', page), 'utf8');

    it('passes NewsletterPrivacyNotice as the NewsletterSignup island’s child', () => {
      expect(source).toMatch(
        /<NewsletterSignup\b[^>]*>\s*<NewsletterPrivacyNotice \/>\s*<\/NewsletterSignup>/
      );
    });

    it('imports NewsletterPrivacyNotice from the newsletter components', () => {
      expect(source).toMatch(
        /import NewsletterPrivacyNotice from '(?:\.\.\/)+components\/newsletter\/NewsletterPrivacyNotice\.astro';/
      );
    });
  }
);
