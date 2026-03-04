import path from 'node:path';

const API_BASE_URL = 'http://localhost:8787';

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

/** Returns the local API base URL. */
export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

/** Returns the URL for GET /api/updates/current. */
export function getUpdatesCurrentUrl(): string {
  return `${API_BASE_URL}/api/updates/current`;
}

/** Returns the URL for POST /api/dev/set-version. */
export function getSetVersionUrl(): string {
  return `${API_BASE_URL}/api/dev/set-version`;
}

/** Returns the R2 object key for a given version. */
export function getR2ObjectKey(version: string): string {
  return `hushbox-app-builds/builds/${version}.zip`;
}

/**
 * Automated local live update testing script.
 *
 * Flow:
 * 1. Query GET /api/updates/current for the current version
 * 2. Generate a new version string
 * 3. Run `vite build` with VITE_APP_VERSION=<new-version>
 * 4. Zip apps/web/dist/
 * 5. Upload zip to local R2 via `wrangler r2 object put`
 * 6. Call POST /api/dev/set-version
 * 7. Log instructions
 *
 * Requires: pnpm dev running (Vite + Wrangler).
 */
export async function runCapTestUpdate(rootDir: string): Promise<void> {
  const { $ } = await import('execa');

  // 1. Query current version
  console.log('Querying current server version...');
  const res = await fetch(getUpdatesCurrentUrl());
  if (!res.ok) {
    throw new Error(`Failed to query current version: ${String(res.status)}`);
  }
  const { version: currentVersion } = (await res.json()) as { version: string };
  console.log(`  Current version: ${currentVersion}`);

  // 2. Generate new version
  const newVersion = generateVersionString();
  console.log(`  New version: ${newVersion}`);

  // 3. Build with new version
  console.log('Building web with new version...');
  const webDir = path.join(rootDir, 'apps', 'web');
  await $({
    cwd: webDir,
    stdio: 'inherit',
    env: { ...process.env, VITE_APP_VERSION: newVersion },
  })`pnpm exec vite build`;

  // 4. Zip dist
  const distributionDir = getDistributionZipPath(rootDir);
  const zipPath = path.join(rootDir, 'web-dist.zip');
  console.log('Zipping dist...');
  await $({ cwd: distributionDir, stdio: 'inherit' })`zip -r ${zipPath} .`;

  // 5. Upload to local R2
  const r2Key = getR2ObjectKey(newVersion);
  console.log(`Uploading to R2: ${r2Key}`);
  const apiDir = path.join(rootDir, 'apps', 'api');
  await $({
    cwd: apiDir,
    stdio: 'inherit',
  })`pnpm exec wrangler r2 object put ${r2Key} --file ${zipPath}`;

  // 6. Set version override
  console.log('Setting version override...');
  const setRes = await fetch(getSetVersionUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: newVersion }),
  });
  if (!setRes.ok) {
    throw new Error(`Failed to set version: ${String(setRes.status)}`);
  }

  // 7. Done
  console.log('');
  console.log('Version updated successfully!');
  console.log(`  Old: ${currentVersion}`);
  console.log(`  New: ${newVersion}`);
  console.log('');
  console.log('Next API call from the emulator will trigger a Capgo update.');
}

// CLI entry point
/* v8 ignore next 2 */
const isMain = import.meta.url === `file://${String(process.argv[1])}`;
if (isMain) {
  /* v8 ignore next 5 */
  try {
    await runCapTestUpdate(process.cwd());
  } catch (error: unknown) {
    console.error('Cap test update failed:', error);
    process.exit(1);
  }
}
