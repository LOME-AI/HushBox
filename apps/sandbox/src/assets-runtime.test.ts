import { mkdtempSync, readdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { startAssetsRuntime } from './assets-runtime.js';
import { sandboxCspFor } from './csp.js';

/**
 * What the sandbox origin actually serves, read out of Cloudflare's own assets
 * runtime rather than inferred from the committed files.
 *
 * `public/_headers` splits the Content-Security-Policy per entry point, and the
 * split keys on a literal path. Whether a request for that path is answered at
 * it — or redirected to some other path that falls under a different block — is
 * decided by `wrangler.toml`'s `[assets] html_handling`, which no reading of
 * `_headers` reveals. Under the runtime default (`auto-trailing-slash`) a
 * request for `/python.html` is answered `307 → /python`, and `/python` matches
 * only `/*`: the Python runtime's wheel-host grant reaches nothing, while every
 * check that reads the two files agrees they are correct. That is the class of
 * defect this file exists to catch, and only executing the runtime catches it.
 *
 * The runtime is the real one: `wrangler` is a devDependency of this package and
 * bundles workerd plus the asset worker that parses `_headers`. It is pointed at
 * this package's real `wrangler.toml`, so `html_handling` and
 * `not_found_handling` are pinned here as production sets them.
 */

/** The package root — `public/` and `wrangler.toml` sit directly beneath it. */
const PACKAGE_ROOT = path.join(import.meta.dirname, '..');
const PUBLIC_DIR = path.join(PACKAGE_ROOT, 'public');

/**
 * Every static page the origin serves, read from `public/` rather than listed —
 * a page added there is covered without editing this file.
 */
function shippedPages(): string[] {
  return readdirSync(PUBLIC_DIR)
    .filter((entry) => entry.endsWith('.html'))
    .toSorted((a, b) => a.localeCompare(b));
}

/**
 * An assets directory holding the real `_headers` and a stand-in for each real
 * page. The page bytes decide nothing here — path-to-policy resolution is what
 * is under test — and standing in for them keeps the 27 MB of Pyodide payload
 * out of the runtime's content hashing.
 */
function stageAssets(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'sandbox-assets-'));
  copyFileSync(path.join(PUBLIC_DIR, '_headers'), path.join(directory, '_headers'));
  for (const page of shippedPages()) {
    writeFileSync(path.join(directory, page), '<!doctype html>');
  }
  return directory;
}

interface Hop {
  readonly pathname: string;
  readonly status: number;
  readonly location: string | null;
  readonly csp: string | undefined;
}

describe('the sandbox origin served through the Cloudflare assets runtime', () => {
  let directory: string;
  let worker: Awaited<ReturnType<typeof startAssetsRuntime>>;
  let origin: string;

  beforeAll(async () => {
    directory = stageAssets();
    worker = await startAssetsRuntime(path.join(PACKAGE_ROOT, 'wrangler.toml'), directory);
    origin = String(await worker.url);
  }, 120_000);

  afterAll(async () => {
    await worker.dispose();
    rmSync(directory, { recursive: true, force: true });
  });

  /** Every response from `pathname` up to and including the first non-redirect. */
  async function chase(pathname: string): Promise<Hop[]> {
    const hops: Hop[] = [];
    let target = new URL(pathname, origin);
    for (let hop = 0; hop < 5; hop += 1) {
      const response = await fetch(target, { redirect: 'manual' });
      const location = response.headers.get('location');
      await response.arrayBuffer();
      hops.push({
        pathname: target.pathname,
        status: response.status,
        location,
        csp: response.headers.get('content-security-policy') ?? undefined,
      });
      if (response.status < 300 || response.status >= 400 || location === null) break;
      target = new URL(location, origin);
    }
    return hops;
  }

  it.each(shippedPages())(
    'answers /%s at the literal path the policy split keys on',
    async (page) => {
      const hops = await chase(`/${page}`);
      // The split in `_headers` is keyed by path. A redirect moves the response
      // that carries the document onto a different path, and so under a
      // different block — silently, since both files still read correctly.
      expect(hops.map((h) => `${String(h.status)} ${h.pathname}`)).toEqual([`200 /${page}`]);
    },
    120_000
  );

  it.each(shippedPages())(
    'serves /%s the policy sandboxCspFor names for it',
    async (page) => {
      const hops = await chase(`/${page}`);
      const delivered = hops.at(-1);
      expect(delivered?.status).toBe(200);
      // Read off the response that actually carries the document, after any
      // redirect: that is the only response whose policy governs the code.
      //
      // The comparison is against the production policy derived for the origin
      // this runtime is serving on, not for the production origin the staged
      // `_headers` spells: the local assets runtime substitutes its own URL for
      // the Worker's configured custom domain inside `Content-Security-Policy`
      // specifically — a probe
      // through this same runtime showed a second header carrying both hosts
      // coming back untouched. Nothing rewrites in production, where the literal
      // in `_headers` is the origin; that file's own bytes are pinned to the
      // production derivation by `headers.test.ts`.
      expect(delivered?.csp).toBe(sandboxCspFor(`/${page}`, new URL(origin).origin, true));
    },
    120_000
  );
});
