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
}

/**
 * Force-remove any leftover container with the given name, then `docker run -d`
 * a new budtmo emulator. Used to launch the mobile-test shard emulators.
 *
 * budtmo's first-boot privilege drop (sudo sed -i '1d' /etc/passwd) wedges
 * the container permanently if a prior run died mid-boot; pre-remove is the
 * only recovery path.
 */
export async function runEmulatorContainer(options: RunEmulatorOptions): Promise<void> {
  await execa('docker', ['rm', '-f', options.name], { stdio: 'ignore' }).catch(() => {
    // Ignored: no leftover container is fine.
  });
  const envArgs: string[] = [
    '-e',
    // eslint-disable-next-line no-secrets/no-secrets -- budtmo env var literal selecting the AVD device profile, not a credential
    'EMULATOR_DEVICE=Samsung Galaxy S10',
    // budtmo phones home (Google Form + ipinfo.io) on container start; disable
    // it to drop that network call from the boot path.
    '-e',
    // eslint-disable-next-line no-secrets/no-secrets -- budtmo env var literal toggling analytics, not a credential
    'USER_BEHAVIOR_ANALYTICS=false',
  ];
  if (options.includeVnc) envArgs.push('-e', 'WEB_VNC=true');
  await execa(
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
    { stdio: 'inherit' }
  );
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

  // Build the content-hashed budtmo image only. Emulators cold-boot from it on
  // each run; we deliberately do NOT bake an AVD quick-boot snapshot via
  // `docker commit`, because a snapshot captured from a live, privileged
  // emulator restores unreliably in a fresh container — it wedges "device
  // offline" and never reaches sys.boot_completed. See mobile-tests/docker/Dockerfile.
  console.log(`[mobile-image] Cache miss: building ${tag}`);
  await buildCold(tag);

  if (options.push) {
    console.log(`[mobile-image] Pushing to registry: ${tag}`);
    await pushImage(tag);
  }
  return tag;
}
