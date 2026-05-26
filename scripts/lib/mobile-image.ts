import { execa } from 'execa';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const IMAGE_NAMESPACE = 'ghcr.io/lome-ai/hushbox-android-emulator';
// Absolute path so docker build and the hash computation work regardless of
// the caller's cwd (tests run from scripts/; the CLI runs from repo root).
export const MOBILE_IMAGE_CONTEXT = path.join(REPO_ROOT, 'mobile-tests', 'docker');
const BAKE_CONTAINER_NAME = 'hushbox-mobile-emulator-bake';
const BAKE_ADB_PORT = 5555;
const BOOT_TIMEOUT_POLLS = 120;
const BOOT_POLL_INTERVAL_MS = 2000;
const BOOT_DIAGNOSTIC_INTERVAL = 10;
const SNAPSHOT_NAME = 'default_boot';

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

export async function computeImageHash(contextDir: string): Promise<string> {
  const absolute = path.resolve(contextDir);
  const files = await listFilesRecursive(absolute);
  // Sort by relative path so the hash is independent of readdir ordering
  // (which is filesystem-dependent and unstable across machines/CI runners).
  const relativePairs = files
    .map((f) => ({ rel: path.relative(absolute, f), abs: f }))
    .toSorted((a, b) => a.rel.localeCompare(b.rel));

  const hash = createHash('sha256');
  for (const { rel, abs } of relativePairs) {
    hash.update(rel);
    hash.update('\0');
    hash.update(await readFile(abs));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 32);
}

export async function computeImageTag(): Promise<string> {
  const hash = await computeImageHash(MOBILE_IMAGE_CONTEXT);
  return `${IMAGE_NAMESPACE}:${hash}`;
}

export async function localImageExists(tag: string): Promise<boolean> {
  try {
    const result = await execa('docker', ['images', '-q', tag]);
    return result.stdout.trim() !== '';
  } catch {
    return false;
  }
}

export async function manifestExists(tag: string): Promise<boolean> {
  try {
    await execa('docker', ['manifest', 'inspect', tag], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function pullImage(tag: string): Promise<void> {
  await execa('docker', ['pull', tag], { stdio: 'inherit' });
}

async function buildCold(tag: string): Promise<void> {
  await execa('docker', ['build', '-t', tag, MOBILE_IMAGE_CONTEXT], { stdio: 'inherit' });
}

export async function detectKvmGid(): Promise<string> {
  // fs.stat returns the gid as a number; the budtmo container expects it
  // passed to --group-add as a string. Using Node fs avoids shelling out to
  // POSIX-only `stat` (forbidden by lint rule).
  const info = await stat('/dev/kvm');
  return String(info.gid);
}

export interface RunEmulatorOptions {
  name: string;
  hostAdbPort: number;
  imageTag: string;
  kvmGid: string;
  /** Set WEB_VNC=true so the noVNC viewer at port 6080 is enabled. */
  includeVnc: boolean;
  /**
   * 'pipe' captures container id on stdout (caller needs it for `docker commit`);
   * 'inherit' streams docker run output to the parent so users see progress.
   */
  stdio: 'pipe' | 'inherit';
}

/**
 * Force-remove any leftover container with the given name, then `docker run -d`
 * a new budtmo emulator. Shared between bake (single ephemeral container) and
 * mobile-test shards (N persistent containers).
 *
 * budtmo's first-boot privilege drop (sudo sed -i '1d' /etc/passwd) wedges
 * the container permanently if a prior run died mid-boot; pre-remove is the
 * only recovery path.
 */
export async function runEmulatorContainer(options: RunEmulatorOptions): Promise<string> {
  await execa('docker', ['rm', '-f', options.name], { stdio: 'ignore' }).catch(() => {
    // Ignored: no leftover container is fine.
  });
  const envArgs: string[] = [
    '-e',
    // eslint-disable-next-line no-secrets/no-secrets -- budtmo env var literal selecting the AVD device profile, not a credential
    'EMULATOR_DEVICE=Samsung Galaxy S10',
  ];
  if (options.includeVnc) envArgs.push('-e', 'WEB_VNC=true');
  const result = await execa(
    'docker',
    [
      'run',
      '-d',
      '--privileged',
      '--name',
      options.name,
      '--device',
      '/dev/kvm',
      '--group-add',
      options.kvmGid,
      '-p',
      `${String(options.hostAdbPort)}:5555`,
      ...envArgs,
      options.imageTag,
    ],
    { stdio: options.stdio }
  );
  // execa returns undefined stdout when stdio is 'inherit' (output streams
  // straight to the parent). Callers that need the container id must pass
  // stdio: 'pipe'.
  return (result.stdout ?? '').trim();
}

async function pollBootOnce(host: string, index: number): Promise<boolean> {
  try {
    await execa('adb', ['connect', host], { stdio: 'pipe' });
    const result = await execa('adb', ['-s', host, 'shell', 'getprop', 'sys.boot_completed']);
    return result.stdout.trim() === '1';
  } catch (error: unknown) {
    // Polling failure during boot is expected, but log periodically so a
    // 4-minute timeout doesn't end with zero diagnostic context.
    if (index % BOOT_DIAGNOSTIC_INTERVAL === 0) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[bake poll ${String(index)}] ${host}: ${message}`);
    }
    return false;
  }
}

async function waitForBoot(adbPort: number): Promise<void> {
  const host = `localhost:${String(adbPort)}`;
  for (let index = 0; index < BOOT_TIMEOUT_POLLS; index++) {
    if (await pollBootOnce(host, index)) return;
    await new Promise((resolve) => {
      setTimeout(resolve, BOOT_POLL_INTERVAL_MS);
    });
  }
  throw new Error('Emulator failed to boot within timeout during image bake');
}

async function saveAvdSnapshot(containerId: string): Promise<void> {
  // `adb emu` is a console command, reachable only for an emulator the adb
  // server manages locally (serial emulator-5554). The host connects over TCP
  // (localhost:5555), which carries no console association and only publishes
  // the adb port, so the save must run inside the container where the emulator
  // is local. adb emu's console protocol is synchronous: the emulator returns
  // OK only after the snapshot is written to disk; docker commit then captures it.
  await execa(
    'docker',
    ['exec', containerId, 'adb', 'emu', 'avd', 'snapshot', 'save', SNAPSHOT_NAME],
    {
      stdio: 'inherit',
    }
  );
}

async function commitContainer(containerId: string, tag: string): Promise<void> {
  await execa('docker', ['commit', containerId, tag], { stdio: 'inherit' });
}

async function removeContainer(containerId: string): Promise<void> {
  await execa('docker', ['rm', '-f', containerId], { stdio: 'pipe' }).catch(() => {
    // Best-effort cleanup; container may already be gone.
  });
}

async function pushImage(tag: string): Promise<void> {
  await execa('docker', ['push', tag], { stdio: 'inherit' });
}

export async function bakeImage(options: { push: boolean }): Promise<string> {
  const tag = await computeImageTag();

  if (await localImageExists(tag)) {
    console.log(`[mobile-image] Cache hit (local): ${tag}`);
    return tag;
  }
  if (await manifestExists(tag)) {
    console.log(`[mobile-image] Cache hit (registry): ${tag} — pulling`);
    await pullImage(tag);
    return tag;
  }

  console.log(`[mobile-image] Cache miss: baking ${tag}`);
  await buildCold(tag);
  const kvmGid = await detectKvmGid();
  const containerId = await runEmulatorContainer({
    name: BAKE_CONTAINER_NAME,
    hostAdbPort: BAKE_ADB_PORT,
    imageTag: tag,
    kvmGid,
    // No VNC during bake — nothing to display interactively, and we want the
    // committed image's port surface to match the runtime emulator.
    includeVnc: false,
    // 'pipe' so we can capture the container id for the commit + cleanup.
    stdio: 'pipe',
  });
  try {
    console.log('[mobile-image] Waiting for emulator boot...');
    await waitForBoot(BAKE_ADB_PORT);
    console.log('[mobile-image] Saving AVD quick-boot snapshot...');
    await saveAvdSnapshot(containerId);
    console.log(`[mobile-image] Committing warm image: ${tag}`);
    await commitContainer(containerId, tag);
  } finally {
    await removeContainer(containerId);
  }

  if (options.push) {
    console.log(`[mobile-image] Pushing to registry: ${tag}`);
    await pushImage(tag);
  }
  return tag;
}
