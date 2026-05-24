import { describe, expect, it } from 'vitest';
import { rewriteForDirectoryIndex } from './preview-directory-index-fallback';

const DIST = '/app/dist';

function exists(present: string[]): (path: string) => boolean {
  return (p) => present.includes(p);
}

describe('rewriteForDirectoryIndex', () => {
  it('rewrites a directory-style URL to its index.html when the file exists', () => {
    const result = rewriteForDirectoryIndex(
      '/welcome',
      DIST,
      exists(['/app/dist/welcome/index.html'])
    );
    expect(result).toBe('/welcome/index.html');
  });

  it('preserves query string on rewrite', () => {
    const result = rewriteForDirectoryIndex(
      '/welcome?utm=x&foo=bar',
      DIST,
      exists(['/app/dist/welcome/index.html'])
    );
    expect(result).toBe('/welcome/index.html?utm=x&foo=bar');
  });

  it('returns null for the root URL', () => {
    expect(rewriteForDirectoryIndex('/', DIST, exists(['/app/dist/index.html']))).toBeNull();
  });

  it('returns null for a trailing-slash directory URL (vite already handles it)', () => {
    expect(
      rewriteForDirectoryIndex('/welcome/', DIST, exists(['/app/dist/welcome/index.html']))
    ).toBeNull();
  });

  it('returns null when the URL already has a .html extension', () => {
    expect(
      rewriteForDirectoryIndex(
        '/welcome.html',
        DIST,
        exists(['/app/dist/welcome.html', '/app/dist/welcome/index.html'])
      )
    ).toBeNull();
  });

  it('returns null when the matching index.html does not exist (SPA fallthrough)', () => {
    expect(rewriteForDirectoryIndex('/chat', DIST, exists([]))).toBeNull();
  });

  it('returns null for malformed percent-encoding instead of throwing', () => {
    expect(rewriteForDirectoryIndex('/%E0%A4%A', DIST, exists([]))).toBeNull();
  });

  it('refuses path traversal that escapes the dist directory', () => {
    // `/../etc/passwd` would resolve outside DIST. The guard must reject it
    // even if `fileExists` would return true for the target.
    const result = rewriteForDirectoryIndex(
      '/../etc/passwd',
      DIST,
      // Pretend the file is everywhere — the traversal guard should still trip first.
      () => true
    );
    expect(result).toBeNull();
  });

  it('rewrites nested directory URLs (e.g. /blog/tag/foo)', () => {
    const result = rewriteForDirectoryIndex(
      '/blog/tag/foo',
      DIST,
      exists(['/app/dist/blog/tag/foo/index.html'])
    );
    expect(result).toBe('/blog/tag/foo/index.html');
  });

  it('rewrites a URL containing percent-encoded path segments', () => {
    const result = rewriteForDirectoryIndex(
      '/blog/my%20post',
      DIST,
      exists(['/app/dist/blog/my post/index.html'])
    );
    // Rewritten URL keeps the original (still-encoded) path; vite/sirv
    // re-decodes it when reading the file.
    expect(result).toBe('/blog/my%20post/index.html');
  });
});
