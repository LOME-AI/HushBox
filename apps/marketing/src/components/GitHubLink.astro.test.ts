import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// No DOM harness renders `.astro` files in this app, so the link is asserted against
// its source, as PageHero.astro.test.ts does.
const source = readFileSync(path.resolve(__dirname, './GitHubLink.astro'), 'utf8');

describe('GitHubLink', () => {
  it('takes the star count and a nav or menu variant', () => {
    expect(source).toMatch(/interface Props \{\s*stars: number;\s*variant: 'nav' \| 'menu';\s*\}/);
  });

  it('draws the shared GitHub mark through Icon', () => {
    expect(source).toContain("import { GitHubMark, Icon } from '@hushbox/ui/icons'");
    expect(source).toContain('<Icon icon={GitHubMark}');
  });

  it('draws no raw svg', () => {
    expect(source).not.toMatch(/<svg\b/);
  });

  it('names the link by its destination and the count it shows', () => {
    expect(source).toContain('aria-label={`GitHub, ${shownCount} stars`}');
  });

  it('opens the repository in a new tab without an opener', () => {
    expect(source).toMatch(/target="_blank"\s+rel="noopener noreferrer"/);
  });

  it('draws the menu variant as a full-width large outline button', () => {
    expect(source).toContain("buttonVariants({ variant: 'outline', size: 'lg' })");
    expect(source).toMatch(/'w-full'/);
  });

  it('labels the menu variant GitHub beside a count pill', () => {
    const pill = /<span>GitHub<\/span>\s*<span class="([^"]*)">/.exec(source)?.[1] ?? '';

    expect(pill.split(' ')).toEqual(expect.arrayContaining(['font-mono', 'rounded-full']));
  });
});
