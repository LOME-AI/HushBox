import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ADMIN_PREVIEW_PREFIX } from '@hushbox/shared';
import {
  MARKETING_PREVIEW_INDEX_PLUGIN_NAME,
  marketingPreviewIndexPlugin,
  rewriteToPreviewIndex,
} from './marketing-preview-index.js';
import type { PreviewIndexHandler } from './marketing-preview-index.js';

const PUBLIC_DIR = path.resolve('/admin/public');

/** The page URLs below are built from the prefix the copy is served under. */
const PREVIEW = `/${ADMIN_PREVIEW_PREFIX}`;

function existing(...pages: readonly string[][]): (filePath: string) => boolean {
  const present = new Set(
    pages.map((segments) =>
      path.resolve(PUBLIC_DIR, ADMIN_PREVIEW_PREFIX, ...segments, 'index.html')
    )
  );
  return (filePath) => present.has(filePath);
}

const WELCOME_ONLY = existing(['welcome']);

function rewrite(url: string, fileExists = WELCOME_ONLY): string | null {
  return rewriteToPreviewIndex(url, PUBLIC_DIR, fileExists);
}

describe('rewriteToPreviewIndex', () => {
  it('sends a directory request under the preview prefix to that directory’s index file', () => {
    expect(rewrite(`${PREVIEW}/welcome/`)).toBe(`${PREVIEW}/welcome/index.html`);
  });

  it('keeps the query string behind the index file it resolved to', () => {
    expect(rewrite(`${PREVIEW}/welcome/?from=overlay`)).toBe(
      `${PREVIEW}/welcome/index.html?from=overlay`
    );
  });

  it('resolves a nested page, not only a single segment', () => {
    expect(rewrite(`${PREVIEW}/newsletter/confirmed/`, existing(['newsletter', 'confirmed']))).toBe(
      `${PREVIEW}/newsletter/confirmed/index.html`
    );
  });

  it('resolves a page whose segment arrives percent-encoded', () => {
    expect(rewrite(`${PREVIEW}/a%20slug/`, existing(['a slug']))).toBe(
      `${PREVIEW}/a%20slug/index.html`
    );
  });

  // Both forms below are declined by the trailing-slash rule alone, so they
  // are driven against a file system that claims every file exists: told
  // otherwise, each would also be declined by a lookup that missed, and the
  // test would hold with the rule gone.
  it('declines the slash-less form, which the preview server also answers with the shell', () => {
    expect(rewrite(`${PREVIEW}/welcome`, () => true)).toBeNull();
  });

  it('declines a request that already names the index file', () => {
    expect(rewrite(`${PREVIEW}/welcome/index.html`, () => true)).toBeNull();
  });

  it('declines a page with no index file, leaving it to the shell', () => {
    expect(rewrite(`${PREVIEW}/nonexistent/`)).toBeNull();
  });

  it('declines the bare prefix', () => {
    expect(rewrite(`${PREVIEW}/`)).toBeNull();
  });

  it('declines a path that merely begins like the prefix', () => {
    expect(rewrite(`${PREVIEW}x/welcome/`)).toBeNull();
  });

  it('declines an ordinary admin route', () => {
    expect(rewrite('/growth')).toBeNull();
  });

  it('declines the admin root', () => {
    expect(rewrite('/')).toBeNull();
  });

  it('declines a doubled slash', () => {
    expect(rewrite(`${PREVIEW}/welcome//`)).toBeNull();
  });

  it('declines a current-directory segment', () => {
    expect(rewrite(`${PREVIEW}/./welcome/`)).toBeNull();
  });

  it('declines a traversing segment even where every file appears to exist', () => {
    // The traversal guard has to trip before the lookup, not rely on it.
    expect(rewrite(`${PREVIEW}/../welcome/`, () => true)).toBeNull();
  });

  it('declines a malformed percent-encoding instead of throwing', () => {
    expect(rewrite(`${PREVIEW}/%E0%A4%A/`)).toBeNull();
  });
});

describe('the marketing preview index plugin', () => {
  let publicDir: string;

  beforeAll(() => {
    publicDir = mkdtempSync(path.join(os.tmpdir(), 'admin-preview-'));
    mkdirSync(path.join(publicDir, ADMIN_PREVIEW_PREFIX, 'welcome'), { recursive: true });
    writeFileSync(
      path.join(publicDir, ADMIN_PREVIEW_PREFIX, 'welcome', 'index.html'),
      '<!doctype html>'
    );
  });

  afterAll(() => {
    rmSync(publicDir, { recursive: true, force: true });
  });

  /** The handler the plugin installs on a server serving `publicDir`. */
  function installed(): PreviewIndexHandler {
    let handler: PreviewIndexHandler | undefined;
    marketingPreviewIndexPlugin().configureServer({
      config: { publicDir },
      middlewares: {
        use: (registered) => {
          handler = registered;
        },
      },
    });
    if (!handler) throw new Error('the plugin registered no middleware');
    return handler;
  }

  function handle(url?: string): { url: string | undefined; nextCalls: number } {
    const request: { url?: string } = url === undefined ? {} : { url };
    const next = vi.fn();

    installed()(request, {}, next);

    return { url: request.url, nextCalls: next.mock.calls.length };
  }

  it('registers under the name the admin config wires it in by', () => {
    expect(marketingPreviewIndexPlugin().name).toBe(MARKETING_PREVIEW_INDEX_PLUGIN_NAME);
  });

  it('reads the index file out of the public directory the server is serving', () => {
    expect(handle(`${PREVIEW}/welcome/`).url).toBe(`${PREVIEW}/welcome/index.html`);
  });

  it('hands a page it has no index file for to the next middleware untouched', () => {
    expect(handle(`${PREVIEW}/nonexistent/`).url).toBe(`${PREVIEW}/nonexistent/`);
  });

  it('leaves a request carrying no URL alone', () => {
    expect(handle().url).toBeUndefined();
  });

  it('passes every request on exactly once, rewritten or not', () => {
    expect([handle(`${PREVIEW}/welcome/`).nextCalls, handle('/growth').nextCalls]).toEqual([1, 1]);
  });
});
