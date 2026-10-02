import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// No DOM harness renders `.astro` files in this app, so the table wrapper is asserted against
// its source (mirrors SectionHeading.astro.test.ts).
const PROSE_TABLE = path.resolve(__dirname, './ProseTable.astro');
const source = existsSync(PROSE_TABLE) ? readFileSync(PROSE_TABLE, 'utf8') : '';

/**
 * The wrapper `div` that directly holds the table: its opening tag, then the template
 * expression holding the table (with an optional line comment), then its own closing tag.
 */
const WRAPPED_TABLE =
  /<div class="([^"]*)">\s*\{\s*\(\s*(?:\/\/[^\n]*\n\s*)?<table \{\.\.\.Astro\.props\}>\s*<slot \/>\s*<\/table>\s*\)\s*\}\s*<\/div>/;

function wrapperClasses(): string[] {
  return (WRAPPED_TABLE.exec(source)?.[1] ?? '').split(/\s+/);
}

describe('ProseTable', () => {
  it('renders the post table with the attributes the markdown gave it', () => {
    expect(source).toMatch(/<table \{\.\.\.Astro\.props\}>\s*<slot \/>\s*<\/table>/);
  });

  it('keeps the table inside the wrapper, with nothing else between them', () => {
    expect(source).toMatch(WRAPPED_TABLE);
  });

  it('wraps the table in a box that scrolls sideways below 768', () => {
    expect(wrapperClasses()).toContain('max-md:overflow-x-auto');
  });

  it('spaces the next block from the wrapper, where a scrolling box cannot swallow the margin', () => {
    expect(wrapperClasses()).toContain('mb-4');
  });

  it('scrolls only below 768', () => {
    expect(wrapperClasses().filter((token) => token.includes('overflow'))).toEqual([
      'max-md:overflow-x-auto',
    ]);
  });
});
