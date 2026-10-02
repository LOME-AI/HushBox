import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No DOM harness renders `.astro` files in this app, so the page and its sections are
// asserted against source.
//
// This file lives outside `apps/marketing/src/pages/` because Astro routes every file under
// that directory; a page test there is built as a junk route that ENOENTs at
// build time reading `.astro` sources absent from `dist/`. `import.meta.url`
// resolves the page source under ESM without relying on `__dirname`.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(currentDir, '../pages/welcome.astro'), 'utf8');
function sectionSource(section: string): string {
  const file = path.resolve(currentDir, `../components/welcome/${section}.astro`);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}
const pricingSource = sectionSource('PricingSection');
const markup = source.replace(/^---[\s\S]*?---/, '');

const SECTION_ORDER = [
  'HeroSection',
  'DemoSection',
  'ValuesSection',
  'VerifySection',
  'CostSection',
  'CompareSection',
  'FeaturesSection',
  'PricingSection',
  'ClosingSection',
  'NewsletterSection',
];

describe('welcome.astro', () => {
  it('renders the sections in order', () => {
    const rendered = [...markup.matchAll(/<([A-Z]\w*Section)\b/g)].map((match) => match[1]);
    expect(rendered).toEqual(SECTION_ORDER);
  });

  it('imports every section from the welcome components', () => {
    for (const section of SECTION_ORDER) {
      expect(source).toContain(`import ${section} from '../components/welcome/${section}.astro';`);
    }
  });

  it('writes no layout of its own', () => {
    expect(markup).not.toMatch(/\bclass=/);
  });

  it('writes no element of its own inside the layout besides the newsletter form', () => {
    const inner = /<SiteLayout\b[^>]*>([\s\S]*)<\/SiteLayout>/.exec(markup)?.[1] ?? '';
    const rest = inner
      .replace(/<NewsletterSection>[\s\S]*?<\/NewsletterSection>/, '')
      .replaceAll(/<[A-Z]\w*Section \/>/g, '');
    expect(rest.trim()).toBe('');
  });

  it('passes the newsletter form into its section', () => {
    expect(markup).toMatch(
      /<NewsletterSection>\s*<NewsletterSignup compact client:visible>\s*<NewsletterPrivacyNotice \/>\s*<\/NewsletterSignup>\s*<\/NewsletterSection>/
    );
  });
});

describe('the pricing section breakdown', () => {
  it('renders CostBreakdown without a client directive', () => {
    expect(pricingSource).toContain('<CostBreakdown headingLevel={3} depositAmount={10} />');
    expect(pricingSource).not.toMatch(/\bclient:/);
  });
});

describe.each([
  ['DemoSection', 'demo'],
  ['ValuesSection', 'pillars'],
  ['VerifySection', 'how-it-works'],
])('the %s anchor', (section, id) => {
  it(`keeps the id "${id}"`, () => {
    expect(sectionSource(section)).toMatch(new RegExp(String.raw`<WelcomeSection id="${id}"`));
  });
});
