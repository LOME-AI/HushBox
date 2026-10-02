import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// No DOM harness renders `.astro` files in this app, so the section is asserted against its source.
const source = readFileSync(path.resolve(__dirname, './PricingSection.astro'), 'utf8');

describe('PricingSection', () => {
  it('paints the ring gaps in the page background', () => {
    expect(source).toMatch(
      /<div class="[^"]*\[--cost-ring-gap:var\(--color-background\)\][^"]*">\s*<CostBreakdown\b/
    );
  });

  it('centres the breakdown in a 42rem block below the heading', () => {
    expect(source).toMatch(/<div class="mx-auto mt-12 max-w-2xl [^"]*">\s*<CostBreakdown\b/);
  });

  it('takes the breakdown from the shared ui package', () => {
    expect(source).toContain("import { CostBreakdown } from '@hushbox/ui';");
  });
});
