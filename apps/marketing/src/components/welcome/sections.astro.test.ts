import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// No DOM harness renders `.astro` files in this app, so each welcome section is asserted
// against its source.
function read(name: string): string {
  const file = path.resolve(__dirname, `./${name}.astro`);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function frameOf(source: string): string {
  return /<WelcomeSection\b[^>]*>/.exec(source)?.[0] ?? '';
}

const FRAMES: readonly { name: string; frame: RegExp }[] = [
  { name: 'CostSection', frame: /^<WelcomeSection reveal>$/ },
  { name: 'DemoSection', frame: /^<WelcomeSection id="demo" width="none">$/ },
  { name: 'ValuesSection', frame: /^<WelcomeSection id="pillars" reveal>$/ },
  { name: 'VerifySection', frame: /^<WelcomeSection id="how-it-works" reveal>$/ },
  { name: 'CompareSection', frame: /^<WelcomeSection reveal>$/ },
  { name: 'FeaturesSection', frame: /^<WelcomeSection reveal>$/ },
  { name: 'PricingSection', frame: /^<WelcomeSection reveal>$/ },
  { name: 'ClosingSection', frame: /^<WelcomeSection width="narrow">$/ },
  { name: 'NewsletterSection', frame: /^<WelcomeSection width="narrow">$/ },
];

// The encryption demo and the provider strip each fade up a beat after the section around them.
const DELAYED_REVEALS: Readonly<Record<string, number>> = { VerifySection: 1, CostSection: 1 };

describe.each(FRAMES)('$name', ({ name, frame }) => {
  const source = read(name);

  it('sits in the welcome section frame', () => {
    expect(frameOf(source)).toMatch(frame);
  });

  it('writes no raw heading element', () => {
    expect(source).not.toMatch(/<h[1-6]\b/);
  });

  it('steps at 768 and at no other width', () => {
    expect(source).not.toMatch(/\b(?:sm|lg|xl|2xl):/);
  });

  it('fades up nothing of its own but the elements it delays', () => {
    expect(source.match(/\bdata-reveal[\w-]*(?:="[^"]*")?/g) ?? []).toEqual(
      Array.from({ length: DELAYED_REVEALS[name] ?? 0 }, () => 'data-reveal="delayed"')
    );
  });
});

describe.each([
  ['VerifySection', 'Privacy you can verify'],
  ['CostSection', 'Same models. A fraction of the cost'],
  ['CompareSection', 'How we compare'],
  ['FeaturesSection', 'Everything you need'],
  ['PricingSection', 'Transparent pricing'],
  ['ClosingSection', 'Ready to chat privately?'],
])('%s headline', (name, headline) => {
  it('renders through SectionHeading', () => {
    expect(read(name)).toContain(`<SectionHeading>${headline}</SectionHeading>`);
  });
});

describe('DemoSection', () => {
  it('shows the product demo', () => {
    expect(read('DemoSection')).toMatch(/<AppDemo \/>/);
  });
});

describe('VerifySection', () => {
  it('fades the encryption demo up after the trust blocks', () => {
    expect(read('VerifySection')).toMatch(
      /<div class="mt-12" data-reveal="delayed">\s*<EncryptionDemo client:visible initialSample=\{encryptionSample\} \/>/
    );
  });
});

describe('FeaturesSection', () => {
  const source = read('FeaturesSection');

  it('lists the shipped features as cards', () => {
    expect(source).toMatch(
      /SHIPPED_FEATURES\.map\(\(feature\) => \(\s*<FeatureCard name=\{feature\.name\} description=\{feature\.description\}>/
    );
  });

  it('lists the coming-soon features as coming-soon cards', () => {
    expect(source).toMatch(
      /COMING_SOON_FEATURES\.map\(\(feature\) => \(\s*<FeatureCard name=\{feature\.name\} comingSoon>/
    );
  });

  it('leaves each card its own width', () => {
    expect(source).not.toMatch(/<FeatureCard\b[^>]*\bclass=/);
  });
});

describe('ClosingSection', () => {
  const source = read('ClosingSection');

  it('sets the call to action in a button row', () => {
    expect(source).toContain("import { buttonRowClass } from '@hushbox/ui/button-groups'");
    expect(source).toMatch(
      /<div class=\{`\$\{buttonRowClass\} mt-8`\}>\s*<a href=\{ROUTES\.CHAT\}/
    );
  });

  it('measures the row from a bundled script', () => {
    expect(source).toMatch(
      /<script>\s*import \{ measureButtonGroups \} from '@hushbox\/ui\/button-groups';/
    );
  });

  it('measures only its own row', () => {
    expect(source).toMatch(/document\.querySelectorAll\('\[data-closing-call\]'\)/);
  });

  it('keeps the note under the call to action', () => {
    expect(source).toContain('No account required.');
  });
});

describe('NewsletterSection', () => {
  const source = read('NewsletterSection');

  it('renders the form the page passes it', () => {
    expect(source).toMatch(/<div class="text-center">\s*<slot \/>\s*<\/div>/);
  });

  it('composes no form of its own', () => {
    expect(source).not.toContain('NewsletterSignup');
  });
});

describe('ValuesSection', () => {
  const source = read('ValuesSection');
  const blocks = read('../ValueBlocks');

  it('renders the value blocks', () => {
    expect(source).toMatch(
      /<WelcomeSection id="pillars" reveal>\s*<ValueBlocks \/>\s*<\/WelcomeSection>/
    );
  });

  it('gives the value blocks one column on phones', () => {
    expect(blocks).toMatch(/<div class="flex flex-col gap-6 wrap-break-word md:flex-row\b/);
  });

  it('sets the three value headings at level two', () => {
    expect(blocks).toMatch(
      /VALUE_BLOCKS\.map\(\(block\) => \(\s*<WordBlock\b[^>]*\bheadingLevel=\{2\}/
    );
  });
});

describe('CostSection', () => {
  const source = read('CostSection');

  it('reads the catalog through the build-time loader', () => {
    expect(source).toMatch(/await loadCatalogAtBuild\(getApiUrl\(\), \{/);
  });

  it('fails a production build on a catalog it cannot read', () => {
    expect(source).toContain('isProduction: env.isProduction');
  });

  it('shows where the catalog failed in place of the figures', () => {
    expect(source).toMatch(
      /catalog\.kind === 'unavailable' \? \([\s\S]*Catalog unavailable at build[\s\S]*\) : /
    );
  });

  it('keeps the section hidden when the catalog prices nothing', () => {
    expect(source).toContain('costData.monthlyCost > 0 && (');
  });

  it('fades the provider strip up after the figures', () => {
    expect(source).toMatch(
      /<div class="border-border mt-16 rounded-lg border-2 p-6" data-reveal="delayed">\s*<ModelProviderStrip\b/
    );
  });

  it('fades up with the rest of the page', () => {
    expect(source.match(/<WelcomeSection reveal>/g)).toHaveLength(2);
  });
});
