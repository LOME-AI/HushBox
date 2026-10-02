import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  RUSTIC_VERSION,
  ensureRustic,
  resolveEnsureRustic,
  resolveRusticAsset,
  rusticCacheDir,
  sha256OfFile,
  verifyArchiveChecksum,
  type RusticAsset,
} from './rustic-binary.js';

/** Every scratch root this file made, so `afterEach` removes exactly those. */
const scratchRoots: string[] = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporaryDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'rustic-test-'));
  scratchRoots.push(root);
  return root;
}

/** sha256 of the three ASCII bytes `abc`, the canonical NIST test vector. */
const SHA256_OF_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

type DownloadFunction = (url: string, destination: string) => Promise<void>;
type ExtractFunction = (archivePath: string, dir: string, asset: RusticAsset) => Promise<void>;

function fakeDownload(): Mock<DownloadFunction> {
  return vi.fn<DownloadFunction>(async (_url, destination) => {
    await writeFile(destination, 'archive');
  });
}

function fakeExtract(): Mock<ExtractFunction> {
  return vi.fn<ExtractFunction>(async (_archivePath, dir, asset) => {
    await writeFile(path.join(dir, asset.binaryName), 'extracted');
  });
}

async function installOnCacheMiss(
  platform: string,
  arch: string
): Promise<{ dir: string; result: string; download: Mock<DownloadFunction> }> {
  const dir = path.join(await temporaryDir(), 'nested');
  const download = fakeDownload();
  const result = await ensureRustic({
    platform,
    arch,
    dir,
    download,
    verify: vi.fn(),
    extract: fakeExtract(),
  });
  return { dir, result, download };
}

describe('resolveRusticAsset', () => {
  it('resolves the Linux x64 tarball', () => {
    const asset = resolveRusticAsset('linux', 'x64');
    expect(asset.fileName).toBe(`rustic-v${RUSTIC_VERSION}-x86_64-unknown-linux-gnu.tar.gz`);
    expect(asset.binaryName).toBe('rustic');
    expect(asset.url).toBe(
      `https://github.com/rustic-rs/rustic/releases/download/v${RUSTIC_VERSION}/${asset.fileName}`
    );
  });

  it('resolves the macOS arm64 tarball', () => {
    const asset = resolveRusticAsset('darwin', 'arm64');
    expect(asset.fileName).toBe(`rustic-v${RUSTIC_VERSION}-aarch64-apple-darwin.tar.gz`);
    expect(asset.binaryName).toBe('rustic');
  });

  it('resolves the Windows x64 tarball with an .exe binary', () => {
    const asset = resolveRusticAsset('win32', 'x64');
    expect(asset.fileName).toBe(`rustic-v${RUSTIC_VERSION}-x86_64-pc-windows-msvc.tar.gz`);
    expect(asset.binaryName).toBe('rustic.exe');
  });

  it('pins a lowercase hex sha256 for every supported platform', () => {
    const supported: readonly (readonly [string, string])[] = [
      ['linux', 'x64'],
      ['darwin', 'arm64'],
      ['win32', 'x64'],
    ];
    for (const [platform, arch] of supported) {
      expect(resolveRusticAsset(platform, arch).sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('throws naming the platform when the architecture is unsupported', () => {
    expect(() => resolveRusticAsset('linux', 'arm64')).toThrow(/linux\/arm64/);
  });

  it('throws naming the platform when the operating system is unsupported', () => {
    expect(() => resolveRusticAsset('freebsd', 'x64')).toThrow(/freebsd\/x64/);
  });
});

describe('rusticCacheDir', () => {
  it('points at the version-scoped directory under the scripts cache', () => {
    const dir = rusticCacheDir().replaceAll('\\', '/');
    expect(dir.endsWith(`/scripts/.cache/rustic/${RUSTIC_VERSION}`)).toBe(true);
  });
});

describe('sha256OfFile', () => {
  it('hashes the bytes on disk', async () => {
    const file = path.join(await temporaryDir(), 'payload');
    await writeFile(file, 'abc');
    expect(await sha256OfFile(file)).toBe(SHA256_OF_ABC);
  });
});

describe('verifyArchiveChecksum', () => {
  it('resolves when the digest matches', async () => {
    const file = path.join(await temporaryDir(), 'payload');
    await writeFile(file, 'abc');
    await expect(verifyArchiveChecksum(file, SHA256_OF_ABC)).resolves.toBeUndefined();
  });

  it('rejects when the digest differs', async () => {
    const file = path.join(await temporaryDir(), 'payload');
    await writeFile(file, 'tampered');
    await expect(verifyArchiveChecksum(file, SHA256_OF_ABC)).rejects.toThrow(/checksum mismatch/);
  });

  it('names the archive it refused', async () => {
    const file = path.join(await temporaryDir(), 'rustic-asset.tar.gz');
    await writeFile(file, 'tampered');
    await expect(verifyArchiveChecksum(file, SHA256_OF_ABC)).rejects.toThrow(
      /checksum mismatch for rustic-asset\.tar\.gz/
    );
  });
});

describe('resolveEnsureRustic', () => {
  it('fills the cache directory, binary path and I/O seams from the defaults', () => {
    const resolved = resolveEnsureRustic({ platform: 'linux', arch: 'x64' });
    expect(resolved.dir).toBe(rusticCacheDir());
    expect(resolved.asset).toEqual(resolveRusticAsset('linux', 'x64'));
    expect(resolved.binPath).toBe(path.join(resolved.dir, 'rustic'));
    expect(resolved.verify).toBe(verifyArchiveChecksum);
    expect(resolved.chmod).toBe(chmod);
    expect(resolved.download.name).toBe('defaultDownload');
    expect(resolved.extract.name).toBe('defaultExtract');
  });

  it('defaults the platform and architecture to the host', () => {
    const resolved = resolveEnsureRustic({ dir: 'host-default-probe' });
    expect(resolved.asset).toEqual(resolveRusticAsset(process.platform, process.arch));
    expect(resolved.platform).toBe(process.platform);
  });

  it('prefers provided options over defaults', () => {
    const download = fakeDownload();
    const extract = fakeExtract();
    const verify = vi.fn();
    const chmodSpy = vi.fn();
    const resolved = resolveEnsureRustic({
      platform: 'win32',
      arch: 'x64',
      version: '9.9.9',
      dir: 'relative/custom',
      download,
      extract,
      verify,
      chmod: chmodSpy,
    });
    expect(resolved.asset.fileName).toBe('rustic-v9.9.9-x86_64-pc-windows-msvc.tar.gz');
    expect(resolved.dir).toBe(path.resolve('relative/custom'));
    expect(resolved.binPath).toBe(path.join(path.resolve('relative/custom'), 'rustic.exe'));
    expect(resolved.download).toBe(download);
    expect(resolved.extract).toBe(extract);
    expect(resolved.verify).toBe(verify);
    expect(resolved.chmod).toBe(chmodSpy);
  });
});

describe('ensureRustic', () => {
  it('returns the cached binary without downloading when it already exists', async () => {
    const dir = await temporaryDir();
    await writeFile(path.join(dir, 'rustic'), 'cached');
    const download = vi.fn();
    const result = await ensureRustic({ platform: 'linux', arch: 'x64', dir, download });
    expect(result).toBe(path.join(dir, 'rustic'));
    expect(download).not.toHaveBeenCalled();
  });

  it('returns an absolute path to the installed binary', async () => {
    const { dir, result } = await installOnCacheMiss('linux', 'x64');
    expect(result).toBe(path.join(dir, 'rustic'));
    expect(path.isAbsolute(result)).toBe(true);
    expect(existsSync(result)).toBe(true);
  });

  it('downloads the pinned release asset on a cache miss', async () => {
    const { dir, download } = await installOnCacheMiss('linux', 'x64');
    const asset = resolveRusticAsset('linux', 'x64');
    expect(download).toHaveBeenCalledWith(asset.url, path.join(dir, asset.fileName));
  });

  it('leaves the extracted binary executable on POSIX', async () => {
    const { result } = await installOnCacheMiss('linux', 'x64');
    const { mode } = await stat(result);
    expect(mode & 0o111).not.toBe(0);
  });

  it('does not chmod a Windows .exe', async () => {
    const dir = await temporaryDir();
    const chmodSpy = vi.fn();
    await ensureRustic({
      platform: 'win32',
      arch: 'x64',
      dir,
      download: fakeDownload(),
      verify: vi.fn(),
      extract: fakeExtract(),
      chmod: chmodSpy,
    });
    expect(chmodSpy).not.toHaveBeenCalled();
  });

  it('removes the downloaded archive after extraction', async () => {
    const { dir } = await installOnCacheMiss('linux', 'x64');
    expect(existsSync(path.join(dir, resolveRusticAsset('linux', 'x64').fileName))).toBe(false);
  });

  it('rejects on a checksum mismatch', async () => {
    const dir = await temporaryDir();
    const download = vi.fn<DownloadFunction>(async (_url, destination) => {
      await writeFile(destination, 'tampered');
    });
    const extract = fakeExtract();
    await expect(
      ensureRustic({ platform: 'linux', arch: 'x64', dir, download, extract })
    ).rejects.toThrow(/checksum mismatch/);
    expect(extract).not.toHaveBeenCalled();
  });

  it('leaves neither binary nor archive behind after a checksum mismatch', async () => {
    const dir = await temporaryDir();
    const download = vi.fn<DownloadFunction>(async (_url, destination) => {
      await writeFile(destination, 'tampered');
    });
    await expect(ensureRustic({ platform: 'linux', arch: 'x64', dir, download })).rejects.toThrow(
      /checksum mismatch/
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('propagates the unsupported-platform failure', async () => {
    await expect(ensureRustic({ platform: 'freebsd', arch: 'x64' })).rejects.toThrow(
      /freebsd\/x64/
    );
  });
});
