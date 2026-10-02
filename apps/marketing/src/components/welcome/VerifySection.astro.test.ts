import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// No DOM harness renders `.astro` files in this app, so the section is asserted against its source.
const source = readFileSync(path.resolve(__dirname, './VerifySection.astro'), 'utf8');

describe('VerifySection', () => {
  it('gives the trust blocks one column on phones that never widens past the page', () => {
    expect(source).toMatch(/<div class="mt-12 grid grid-cols-1 gap-6 md:grid-cols-2">/);
  });

  it('takes its copy from the one constant', () => {
    expect(source).toContain("import { TRUST_BLOCKS } from '../../lib/word-blocks';");
  });

  it('draws each fact as a green block with its heading at level three', () => {
    expect(source).toMatch(
      /TRUST_BLOCKS\.map\(\(block\) => \(\s*<WordBlock\s+tone="trust"\s+icon=\{block\.icon\}\s+title=\{block\.title\}\s+text=\{block\.text\}\s+headingLevel=\{3\}\s*\/>/
    );
  });
});
