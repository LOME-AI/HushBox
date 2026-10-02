import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// No DOM harness renders `.astro` files in this app, so the row is asserted against its source.
const file = path.resolve(__dirname, './ValueBlocks.astro');
const source = existsSync(file) ? readFileSync(file, 'utf8') : '';

function rowClasses(): string[] {
  return (/<div class="(flex\b[^"]*)">/.exec(source)?.[1] ?? '').split(/\s+/);
}

describe('ValueBlocks', () => {
  it('stacks the blocks in one column on phones', () => {
    expect(rowClasses()).toStrictEqual(
      expect.arrayContaining(['flex', 'flex-col', 'gap-6', 'wrap-break-word'])
    );
  });

  it('sets the blocks side by side from 768', () => {
    expect(rowClasses()).toContain('md:flex-row');
  });

  it('shares the row equally from 768', () => {
    expect(rowClasses()).toContain('md:*:flex-1');
  });

  it('moves a block that cannot keep its content width onto the next line rather than overflowing', () => {
    expect(rowClasses()).toContain('md:flex-wrap');
  });

  it('lets no block shrink below its content', () => {
    expect(source).not.toMatch(/min-w-0/);
  });

  it('steps at 768 and at no other width', () => {
    expect(source).not.toMatch(/\b(?:sm|lg|xl|2xl):/);
  });

  it('takes its copy from the one constant', () => {
    expect(source).toContain("import { VALUE_BLOCKS } from '../lib/word-blocks';");
  });

  it('types none of the copy itself', () => {
    expect(source).not.toMatch(/Privacy|Innovation|Transparency/);
  });

  it('draws each value as a red block with its heading at level two', () => {
    expect(source).toMatch(
      /VALUE_BLOCKS\.map\(\(block\) => \(\s*<WordBlock\s+tone="value"\s+icon=\{block\.icon\}\s+title=\{block\.title\}\s+text=\{block\.text\}\s+headingLevel=\{2\}\s*\/>/
    );
  });
});
