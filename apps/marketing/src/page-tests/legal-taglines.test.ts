import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The hero taglines are each page's own frontmatter literal, which no rendered-policy test can see.
// HushBox has no export feature, so no tagline may promise one. Lives outside src/pages/ because
// Astro routes every file under that directory.
const currentDir = path.dirname(fileURLToPath(import.meta.url));

function cipherMessages(page: string, constantName: string): string[] {
  const source = readFileSync(path.resolve(currentDir, '../pages', page), 'utf8');
  const declaration = new RegExp(
    String.raw`const ${constantName}: readonly string\[\] = \[([^\]]*)\];`
  );
  const body = declaration.exec(source)?.[1];
  if (body === undefined) {
    throw new Error(`${constantName} not found in ${page}`);
  }
  return [...body.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '');
}

describe('legal page hero taglines', () => {
  it('lists the privacy page taglines in order', () => {
    expect(cipherMessages('privacy.astro', 'PRIVACY_CIPHER_MESSAGES')).toEqual([
      'No Plaintext Stored',
      'Keys Stay Local',
      'Never Trained On',
      'No Tracking Pixels',
      'No Ads, Ever',
      'You Hold The Recovery',
      'Yours To Delete',
      'Zero Retention',
    ]);
  });

  it('lists the terms page taglines in order', () => {
    expect(cipherMessages('terms.astro', 'TERMS_CIPHER_MESSAGES')).toEqual([
      'No Lock-In',
      'No Auto-Renew',
      'Source Available',
      'No Forced Arbitration',
      'No Dark Patterns',
      'Promises We Keep',
    ]);
  });
});
