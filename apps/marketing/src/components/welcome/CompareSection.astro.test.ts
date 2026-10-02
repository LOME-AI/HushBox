import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// No DOM harness renders `.astro` files in this app, so the section is asserted against its source.
const source = readFileSync(path.resolve(__dirname, './CompareSection.astro'), 'utf8');

function script(): string {
  return /<script>([\s\S]*?)<\/script>/.exec(source)?.[1] ?? '';
}

describe('CompareSection', () => {
  it('measures the table from a bundled script', () => {
    expect(script()).toContain(
      "import { observeOverflowStop } from '@hushbox/ui/scroll-overflow';"
    );
  });

  it('measures only the compare table’s scroll region', () => {
    expect(script()).toContain(
      `document.querySelectorAll<HTMLElement>(\n    '[data-slot="data-table"][data-layout="compare"] [data-slot="table-wrapper"]'\n  )`
    );
  });

  it('hands each region it finds to the overflow stop', () => {
    expect(script()).toMatch(/\)\s*\{\s*observeOverflowStop\(region\);\s*\}/);
  });

  it('imports nothing else into the page script', () => {
    expect(script().match(/^\s*import\b/gm)).toHaveLength(1);
  });
});
