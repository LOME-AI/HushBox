import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

/**
 * Pinned to the version gitleaks-action installs in CI. Local and CI must scan
 * with the same engine or findings diverge — bump this together with the
 * version in .github/workflows and the checksums below.
 */
export const GITLEAKS_VERSION = '8.24.3';

/**
 * SHA256 of each release asset, copied from the official
 * `gitleaks_<version>_checksums.txt`. Pinned so a corrupted or substituted
 * download fails closed rather than installing unknown bytes.
 */
const CHECKSUMS: Readonly<Record<string, string>> = {
  darwin_arm64: 'b90f13bb8c90ab72083d9b0c842e39dafb82c0e5c3f872f407366b7a58909013',
  darwin_x64: '41c44ae8ad1d6eef57d4526ad0fd67d8129eee9a856f55c2b3b9395fd3d9ec0f',
  linux_arm64: '5f2edbe1f49f7b920f9e06e90759947d3c5dfc16f752fb93aaafc17e9d14cf07',
  linux_x64: '9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c',
  windows_x64: '3f1a35578631dbfe633cc5b49e6c906e55ff14a4bfd7336a10fb27fe33b6dcd2',
};

const OS_BY_PLATFORM: Readonly<Record<string, string>> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
};

const ARCH_BY_NODE_ARCH: Readonly<Record<string, string>> = {
  arm64: 'arm64',
  x64: 'x64',
};

export interface AssetInfo {
  /** Checksum-map key, e.g. `linux_x64`. */
  readonly assetKey: string;
  /** Release asset file name. */
  readonly fileName: string;
  /** Full GitHub release download URL. */
  readonly url: string;
  /** Pinned SHA256 of the asset. */
  readonly sha256: string;
  /** Windows assets ship as `.zip`, everything else as `.tar.gz`. */
  readonly isZip: boolean;
  /** Name of the executable inside the archive. */
  readonly binaryName: string;
}

export function resolveAsset(
  platform: string,
  arch: string,
  version: string = GITLEAKS_VERSION
): AssetInfo {
  const os = OS_BY_PLATFORM[platform];
  const cpu = ARCH_BY_NODE_ARCH[arch];
  if (os === undefined || cpu === undefined) {
    throw new Error(
      `gitleaks: unsupported platform '${platform}/${arch}'. Supported: darwin, linux, win32 on x64 or arm64.`
    );
  }
  const assetKey = `${os}_${cpu}`;
  const sha256 = CHECKSUMS[assetKey];
  if (sha256 === undefined) {
    throw new Error(`gitleaks: no pinned checksum for '${assetKey}' at version ${version}.`);
  }
  const isZip = os === 'windows';
  const fileName = `gitleaks_${version}_${assetKey}.${isZip ? 'zip' : 'tar.gz'}`;
  return {
    assetKey,
    fileName,
    url: `https://github.com/gitleaks/gitleaks/releases/download/v${version}/${fileName}`,
    sha256,
    isZip,
    binaryName: isZip ? 'gitleaks.exe' : 'gitleaks',
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyChecksum(bytes: Uint8Array, expectedSha: string): void {
  const actual = sha256Hex(bytes);
  if (actual !== expectedSha) {
    throw new Error(`gitleaks: checksum mismatch (expected ${expectedSha}, got ${actual}).`);
  }
}

export function cacheDir(version: string = GITLEAKS_VERSION): string {
  return fileURLToPath(new URL(`../../.cache/gitleaks/${version}`, import.meta.url));
}

/* v8 ignore start -- external I/O seam (network + tar), exercised by install + pre-push */
async function defaultDownload(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `gitleaks: download failed (${String(response.status)} ${response.statusText}) for ${url}`
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function defaultExtract(archivePath: string, dir: string, asset: AssetInfo): Promise<void> {
  // bsdtar (macOS, Windows) extracts both .tar.gz and .zip; GNU tar (Linux)
  // handles the .tar.gz we download there — Linux never receives a .zip.
  const args = asset.isZip
    ? ['-xf', archivePath, '-C', dir, asset.binaryName]
    : ['-xzf', archivePath, '-C', dir, asset.binaryName];
  await execa('tar', args);
}
/* v8 ignore stop */

export interface EnsureOptions {
  platform?: string;
  arch?: string;
  version?: string;
  dir?: string;
  download?: (url: string) => Promise<Uint8Array>;
  extract?: (archivePath: string, dir: string, asset: AssetInfo) => Promise<void>;
  verify?: (bytes: Uint8Array, expectedSha: string) => void;
}

interface ResolvedEnsure {
  asset: AssetInfo;
  dir: string;
  binPath: string;
  download: (url: string) => Promise<Uint8Array>;
  extract: (archivePath: string, dir: string, asset: AssetInfo) => Promise<void>;
  verify: (bytes: Uint8Array, expectedSha: string) => void;
}

export function resolveEnsure(options: EnsureOptions): ResolvedEnsure {
  const version = options.version ?? GITLEAKS_VERSION;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const dir = options.dir ?? cacheDir(version);
  const asset = resolveAsset(platform, arch, version);
  return {
    asset,
    dir,
    binPath: path.join(dir, asset.binaryName),
    download: options.download ?? defaultDownload,
    extract: options.extract ?? defaultExtract,
    verify: options.verify ?? verifyChecksum,
  };
}

export async function ensureGitleaks(options: EnsureOptions = {}): Promise<string> {
  const { asset, dir, binPath, download, extract, verify } = resolveEnsure(options);

  if (!existsSync(binPath)) {
    await mkdir(dir, { recursive: true });
    const bytes = await download(asset.url);
    verify(bytes, asset.sha256);

    const archivePath = path.join(dir, asset.fileName);
    await writeFile(archivePath, bytes);
    await extract(archivePath, dir, asset);
    await rm(archivePath, { force: true });

    if (!asset.isZip) {
      await chmod(binPath, 0o755);
    }
  }
  return binPath;
}

export interface RunGitleaksDeps {
  ensure: () => Promise<string>;
  exec: (bin: string, args: readonly string[]) => Promise<{ exitCode?: number }>;
}

/**
 * Ensures the binary is present, runs it with the given arguments, and resolves
 * to its exit code (1 when the process was killed without one).
 */
export async function runGitleaks(argv: readonly string[], deps: RunGitleaksDeps): Promise<number> {
  const bin = await deps.ensure();
  const result = await deps.exec(bin, argv);
  return result.exitCode ?? 1;
}
