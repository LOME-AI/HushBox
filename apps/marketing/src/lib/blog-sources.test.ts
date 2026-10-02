import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A post's Sources list is marketing copy, so it follows DESIGN.md's long-dash rule: a source
// separates publisher from title with a colon, or a period where the title holds its own colon.
const blogDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../content/blog');

function sourcesSection(source: string): string {
  const start = source.indexOf('\n## Sources\n');
  if (start === -1) {
    return '';
  }
  const body = source.slice(start + '\n## Sources\n'.length);
  const next = body.search(/^## /m);
  return next === -1 ? body : body.slice(0, next);
}

const posts = readdirSync(blogDir).filter((name) => name.endsWith('.mdx'));

describe('blog post sources', () => {
  it('finds the posts to sweep', () => {
    expect(posts).toContain('what-is-opaque-authentication.mdx');
  });

  it.each(posts)('%s lists its sources with no em dash', (post) => {
    const section = sourcesSection(readFileSync(path.join(blogDir, post), 'utf8'));
    expect(section).not.toContain('—');
  });

  it('separates each OPAQUE post publisher from its title with a colon, or a period when the title has its own colon', () => {
    const section = sourcesSection(
      readFileSync(path.join(blogDir, 'what-is-opaque-authentication.mdx'), 'utf8')
    );
    const labels = [...section.matchAll(/^\d+\. \[(.+)\]\(/gm)].map((match) => match[1]);
    expect(labels).toEqual([
      'Jarecki, Krawczyk, Xu. "OPAQUE: An Asymmetric PAKE Protocol Secure Against Pre-Computation Attacks" (EUROCRYPT 2018)',
      'RFC 9807: The OPAQUE Augmented PAKE Protocol (July 2025)',
      'RFC 9497: Oblivious Pseudorandom Functions Using Prime-Order Groups (December 2023)',
      'CFRG PAKE Selection Process',
      'Meta Engineering: WhatsApp End-to-End Encrypted Backups (September 2021)',
      'WhatsApp Security: Encrypted Backups Whitepaper',
      'Cloudflare Blog. OPAQUE: The Best Passwords Never Leave Your Device',
      'NIST CSRC: The OPAQUE Password Protocol (October 2024)',
    ]);
  });
});
