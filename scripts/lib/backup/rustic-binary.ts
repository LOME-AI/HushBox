import { existsSync } from 'node:fs';
import { chmod as chmodFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

import { sha256Hex, verifySha256 } from '../sha256-checksum.js';

/**
 * The one place the rustic version is declared. The repository written on B2 is
 * read by other restic-family tools, so the writer's version is pinned rather
 * than tracked — bump it here together with the checksums below.
 */
export const RUSTIC_VERSION = '0.11.4';

/**
 * SHA256 of each release asset, read from the `<asset>.sha256` sidecar published
 * beside it and cross-checked against the Releases API `digest` field. The
 * release carries no build attestation, so this pin is the whole verification:
 * a substituted or corrupted download fails closed.
 */
const TARGETS: Readonly<Record<string, { readonly target: string; readonly sha256: string }>> = {
  'linux/x64': {
    target: 'x86_64-unknown-linux-gnu',
    sha256: 'c20bc3682c6275de3cfbc9317101dca5c0800a2fb5c610d0f9ef2addfd27cf81',
  },
  'darwin/arm64': {
    target: 'aarch64-apple-darwin',
    sha256: '6df166f68876f1bd1e0965547542374877f04ab498cbb5e19b1b155844bce307',
  },
  'win32/x64': {
    target: 'x86_64-pc-windows-msvc',
    sha256: 'aa3586c2646da30965e099393c739a32526c27314cfaaf97af7f65aab1ec230a',
  },
};

export interface RusticAsset {
  /** Release asset file name. Every target ships a `.tar.gz`, Windows included. */
  readonly fileName: string;
  /** Full GitHub release download URL. */
  readonly url: string;
  /** Pinned SHA256 of the asset. */
  readonly sha256: string;
  /** Name of the executable inside the archive; it sits at the archive root. */
  readonly binaryName: string;
}

export function resolveRusticAsset(
  platform: string,
  arch: string,
  version: string = RUSTIC_VERSION
): RusticAsset {
  const platformKey = `${platform}/${arch}`;
  const entry = TARGETS[platformKey];
  if (entry === undefined) {
    throw new Error(
      `rustic: unsupported platform '${platformKey}'. Supported: ${Object.keys(TARGETS).join(', ')}.`
    );
  }
  const fileName = `rustic-v${version}-${entry.target}.tar.gz`;
  return {
    fileName,
    url: `https://github.com/rustic-rs/rustic/releases/download/v${version}/${fileName}`,
    sha256: entry.sha256,
    binaryName: platform === 'win32' ? 'rustic.exe' : 'rustic',
  };
}

/**
 * Version-scoped, so the presence of the binary at this path is itself the
 * record that the cached bytes are the pinned release.
 */
export function rusticCacheDir(version: string = RUSTIC_VERSION): string {
  return fileURLToPath(new URL(`../../.cache/rustic/${version}`, import.meta.url));
}

export async function sha256OfFile(filePath: string): Promise<string> {
  return sha256Hex(await readFile(filePath));
}

export async function verifyArchiveChecksum(
  archivePath: string,
  expectedSha256: string
): Promise<void> {
  verifySha256(await readFile(archivePath), expectedSha256, path.basename(archivePath));
}

/* v8 ignore start -- external I/O seams (network, tar), exercised by the backup run itself */
async function defaultDownload(url: string, destination: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`rustic: download request failed for ${url}.`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(
      `rustic: download failed (${String(response.status)} ${response.statusText}) for ${url}`
    );
  }
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
}

async function defaultExtract(archivePath: string, dir: string, asset: RusticAsset): Promise<void> {
  // The binary sits at the archive root beside `config/` and `docs/`, so naming
  // it as the sole member leaves the documentation out of the cache. bsdtar
  // (macOS, Windows) and GNU tar (Linux) both accept this invocation.
  try {
    await execa('tar', ['-xzf', archivePath, '-C', dir, asset.binaryName]);
  } catch (error) {
    throw new Error(`rustic: extracting ${asset.fileName} failed.`, { cause: error });
  }
}
/* v8 ignore stop */

interface EnsureRusticOptions {
  platform?: string;
  arch?: string;
  version?: string;
  dir?: string;
  download?: (url: string, destination: string) => Promise<void>;
  extract?: (archivePath: string, dir: string, asset: RusticAsset) => Promise<void>;
  verify?: (archivePath: string, expectedSha256: string) => Promise<void>;
  chmod?: (filePath: string, mode: number) => Promise<void>;
}

interface ResolvedEnsure {
  readonly asset: RusticAsset;
  readonly platform: string;
  readonly dir: string;
  readonly binPath: string;
  readonly download: (url: string, destination: string) => Promise<void>;
  readonly extract: (archivePath: string, dir: string, asset: RusticAsset) => Promise<void>;
  readonly verify: (archivePath: string, expectedSha256: string) => Promise<void>;
  readonly chmod: (filePath: string, mode: number) => Promise<void>;
}

export function resolveEnsureRustic(options: EnsureRusticOptions): ResolvedEnsure {
  const version = options.version ?? RUSTIC_VERSION;
  const platform = options.platform ?? process.platform;
  const asset = resolveRusticAsset(platform, options.arch ?? process.arch, version);
  const dir = path.resolve(options.dir ?? rusticCacheDir(version));
  return {
    asset,
    platform,
    dir,
    binPath: path.join(dir, asset.binaryName),
    download: options.download ?? defaultDownload,
    extract: options.extract ?? defaultExtract,
    verify: options.verify ?? verifyArchiveChecksum,
    chmod: options.chmod ?? chmodFile,
  };
}

/**
 * Resolves to the absolute path of an executable rustic {@link RUSTIC_VERSION},
 * downloading and checksum-verifying the pinned release asset on a cache miss.
 */
export async function ensureRustic(options: EnsureRusticOptions = {}): Promise<string> {
  const { asset, platform, dir, binPath, download, extract, verify, chmod } =
    resolveEnsureRustic(options);
  if (existsSync(binPath)) return binPath;

  await mkdir(dir, { recursive: true });
  const archivePath = path.join(dir, asset.fileName);
  await download(asset.url, archivePath);
  try {
    await verify(archivePath, asset.sha256);
  } catch (error) {
    await rm(archivePath, { force: true });
    throw error;
  }
  await extract(archivePath, dir, asset);
  await rm(archivePath, { force: true });

  if (platform !== 'win32') {
    await chmod(binPath, 0o755);
  }
  return binPath;
}
