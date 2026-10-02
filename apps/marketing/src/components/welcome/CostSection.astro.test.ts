import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// No DOM harness renders `.astro` files in this app, so the section is asserted against its source.
const source = readFileSync(path.resolve(__dirname, './CostSection.astro'), 'utf8');

describe('CostSection', () => {
  it('sets the lede in the ui type role', () => {
    expect(source).toMatch(
      /<Text variant="ui">\s*Based on \{MESSAGES_PER_DAY\} messages per day:\s*<\/Text>/
    );
  });

  it('takes the type role from the shared type door', () => {
    expect(source).toContain("import { Text } from '@hushbox/ui/type';");
  });

  it('centres the lede under the heading in the default ink', () => {
    expect(source).toMatch(/<div class="text-foreground mt-3 text-center">\s*<Text variant="ui">/);
  });

  it('takes the message count the figures are priced at from the cost calculator', () => {
    expect(source).toContain("import { MESSAGES_PER_DAY } from '../../lib/calculate-cost';");
  });
});
