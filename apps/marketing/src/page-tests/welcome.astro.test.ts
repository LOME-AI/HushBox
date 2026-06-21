import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No DOM harness renders `.astro` files in this app, so hydration directives are
// asserted against the page source. The two pricing charts sit below the fold;
// they must defer hydration to scroll (`client:visible`) rather than first paint.
//
// This file lives outside `src/pages/` because Astro routes every file under
// that directory; a page test there is built as a junk route that ENOENTs at
// build time reading `.astro` sources absent from `dist/`. `import.meta.url`
// resolves the page source under ESM without relying on `__dirname`.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(currentDir, '../pages/welcome.astro'), 'utf8');

describe('welcome.astro pricing chart hydration', () => {
  it('hydrates FeeBreakdown on scroll, not first paint', () => {
    expect(source).toContain('<FeeBreakdown client:visible depositAmount={10} />');
    expect(source).not.toContain('<FeeBreakdown client:load');
  });

  it('hydrates CostPieChart on scroll, not first paint', () => {
    expect(source).toContain('<CostPieChart client:visible depositAmount={10} />');
    expect(source).not.toContain('<CostPieChart client:load');
  });
});
