import path from 'node:path';
import { createWriteStream, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import archiver from 'archiver';
import { $, execa } from 'execa';
import { isMainModule } from './lib/cli/is-main.js';
import { parseCommandLine, readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import { withScratchDirectory } from './lib/scratch-directory.js';
import { localOriginFor } from './lib/stack/local-origin.js';
import { r2PutArgs } from './lib/wrangler/r2.js';
import { stackModeFrom } from './with-env.js';
import type { MobilePlatform } from '@hushbox/shared';

/** The bundle staged here is a build artifact, never part of the checkout. */
const SCRATCH_PREFIX = 'hushbox-cap-update-';

let versionCounter = 0;

/** Generates a unique version string for testing OTA updates. */
export function generateVersionString(): string {
  versionCounter += 1;
  return `dev-update-${String(Date.now())}-${String(versionCounter)}`;
}

/** Returns the path to the web dist directory. */
export function getDistributionZipPath(rootDir: string): string {
  return path.join(rootDir, 'apps', 'web', 'dist');
}

/** Returns the local API base URL of the port this checkout was allocated. */
export function getApiBaseUrl(): string {
  return localOriginFor('api');
}

/** Returns the URL for GET /updates/current. */
export function getUpdatesCurrentUrl(): string {
  return `${getApiBaseUrl()}/updates/current`;
}

/** Returns the URL for POST /dev/set-version. */
export function getSetVersionUrl(): string {
  return `${getApiBaseUrl()}/dev/set-version`;
}

/** Returns the URL for POST /dev/set-checksum. */
export function getSetChecksumUrl(): string {
  return `${getApiBaseUrl()}/dev/set-checksum`;
}

/** Returns the R2 object key for a given platform and version. */
export function getR2ObjectKey(platform: MobilePlatform, version: string): string {
  return `hushbox-app-builds/builds/${platform}/${version}.zip`;
}

/**
 * Pack the contents of a directory into a zip file. Mirrors `cd <source> && zip -r <dest> .`:
 * entries are stored relative to the source directory root, not the source directory itself.
 */
export function zipDirectory(source: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(destination);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => {
      resolve();
    });
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(source, false);
    void archive.finalize();
  });
}

/**
 * Automated local live update testing script.
 *
 * Flow:
 * 1. Query GET /updates/current for the current version
 * 2. Generate a new version string
 * 3. Run vite build with the new version and platform env vars
 * 4. Zip apps/web/dist/ into a scratch directory outside the checkout
 * 5. Upload zip to local R2 via wrangler (platform-specific key)
 * 6. Call POST /dev/set-checksum with the zip's sha256
 * 7. Call POST /dev/set-version
 * 8. Log instructions
 *
 * Requires: pnpm dev running (Vite + Wrangler).
 */
export async function runCapTestUpdate(
  rootDir: string,
  platform: MobilePlatform = 'android-direct'
): Promise<void> {
  console.log('Querying current server version...');
  const res = await fetch(getUpdatesCurrentUrl());
  if (!res.ok) {
    throw new Error(`Failed to query current version: ${String(res.status)}`);
  }
  const { version: currentVersion } = (await res.json()) as { version: string };
  console.log(`  Current version: ${currentVersion}`);

  const newVersion = generateVersionString();
  console.log(`  New version: ${newVersion}`);

  console.log('Building web with new version...');
  const webDir = path.join(rootDir, 'apps', 'web');
  await $({
    cwd: webDir,
    stdio: 'inherit',
    env: { ...process.env, VITE_APP_VERSION: newVersion, VITE_PLATFORM: platform },
  })`pnpm exec vite build`;

  const distributionDir = getDistributionZipPath(rootDir);
  await withScratchDirectory(SCRATCH_PREFIX, async (scratchDir) => {
    const zipPath = path.join(scratchDir, 'web-dist.zip');
    console.log('Zipping dist...');
    await zipDirectory(distributionDir, zipPath);

    const r2Key = getR2ObjectKey(platform, newVersion);
    console.log(`Uploading to R2: ${r2Key}`);
    const apiDir = path.join(rootDir, 'apps', 'api');
    await execa(
      'pnpm',
      ['exec', 'wrangler', ...r2PutArgs(r2Key, zipPath, stackModeFrom(process.env))],
      { cwd: apiDir, stdio: 'inherit' }
    );

    // A bundle's sha256 exists only once the zip is built, so no binding can
    // carry it and this publishes it through the dev channel instead — without
    // it the native client refuses to install an unverifiable bundle. Published
    // before the version, because the client reads both from one response: a
    // device polling in between must never see the new version without the
    // checksum that lets it install.
    console.log('Publishing bundle checksum...');
    const checksum = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
    const checksumRes = await fetch(getSetChecksumUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, checksum }),
    });
    if (!checksumRes.ok) {
      throw new Error(`Failed to publish checksum: ${String(checksumRes.status)}`);
    }

    console.log('Setting version override...');
    const setRes = await fetch(getSetVersionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: newVersion }),
    });
    if (!setRes.ok) {
      throw new Error(`Failed to set version: ${String(setRes.status)}`);
    }
  });

  console.log('');
  console.log('Version updated successfully!');
  console.log(`  Old: ${currentVersion}`);
  console.log(`  New: ${newVersion}`);
  console.log('');
  console.log('Next API call from the emulator will trigger a Capgo update.');
}

export const COMMAND_LINE = {
  command: 'pnpm cap:test-update',
  summary: 'Exercises the native over-the-air update flow against a built bundle.',
  flags: [
    {
      flag: '--platform',
      kind: 'value',
      placeholder: '<platform>',
      summary: 'Which native platform to drive. Defaults to every one of them.',
    },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/** Parses --platform from CLI args. Returns undefined if not provided. */
export function parsePlatformArgument(args: readonly string[]): MobilePlatform | undefined {
  const parsed = parseCommandLine(COMMAND_LINE, args);
  if (parsed.kind === 'help') return undefined;
  return parsed.flags['--platform'] as MobilePlatform | undefined;
}

/* v8 ignore start -- CLI entry point exercised via cap:test-update script */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const argv = process.argv.slice(2);
    if (readCommandLine(COMMAND_LINE, argv) === null) return;
    await runCapTestUpdate(process.cwd(), parsePlatformArgument(argv));
  });
}
/* v8 ignore stop */
