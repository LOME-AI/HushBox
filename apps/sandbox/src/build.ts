import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSandboxConfigScript } from './config.js';
import {
  shippingBundleOptions,
  verifyBundle,
  type VerifyBundleOptions,
} from '../../../scripts/verify-bundle.js';
import { buildEnvMode } from '../../../scripts/lib/bundling/build-mode.js';
import type { EnvMode } from '@hushbox/shared';

/**
 * Assemble the sandbox origin's deploy directory (`./dist`), which the
 * production Cloudflare assets Worker serves (wrangler.toml `[assets]`). The
 * static pages and the self-hosted Pyodide assets are copied from `public/`
 * verbatim, then the env-derived `/config.js` is written on top. Pyodide bytes
 * must already be present under `public/pyodide/` (run `fetch-pyodide` first);
 * this step does not fetch.
 */

export interface BuildSandboxOptions {
  /** Absolute source directory (the committed static pages + fetched assets). */
  readonly publicDir: string;
  /** Absolute deploy directory to (re)assemble. */
  readonly distDir: string;
  /** The `/config.js` body (from buildSandboxConfigScript). */
  readonly configScript: string;
}

/** (Re)assemble `distDir` from `publicDir` plus the generated `config.js`. */
export function buildSandbox(options: BuildSandboxOptions): void {
  rmSync(options.distDir, { recursive: true, force: true });
  mkdirSync(options.distDir, { recursive: true });
  cpSync(options.publicDir, options.distDir, { recursive: true });
  writeFileSync(path.join(options.distDir, 'config.js'), options.configScript);
}

/**
 * What the assembled dist is verified with. A shipping build is held to an
 * empty frontend supply: the origin reads no generated env file, so any
 * prefixed value baked into it is a leak.
 */
export function sandboxBundleOptions(repoRoot: string, mode: EnvMode): VerifyBundleOptions {
  return shippingBundleOptions(repoRoot, 'apps/sandbox', mode);
}

/* v8 ignore start -- CLI entry, exercised via the `build` package script */
async function main(): Promise<void> {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  buildSandbox({
    publicDir: path.join(packageRoot, 'public'),
    distDir: path.join(packageRoot, 'dist'),
    configScript: buildSandboxConfigScript(process.env),
  });
  // Verified here rather than from a workflow step, because this is where the
  // dist is finished: Cloudflare's per-file and file-count caps apply to the
  // Pyodide payload this copies, and the origin is served straight from these
  // bytes. Same seam the admin bundle uses, so the TTS expectation stays a
  // single declaration.
  await verifyBundle(
    sandboxBundleOptions(path.resolve(packageRoot, '../..'), buildEnvMode(process.env))
  );
  console.log('✓ sandbox dist assembled');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
/* v8 ignore stop */
