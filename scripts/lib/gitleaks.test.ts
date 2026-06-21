import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  GITLEAKS_VERSION,
  resolveAsset,
  resolveEnsure,
  sha256Hex,
  verifyChecksum,
  cacheDir,
  ensureGitleaks,
  runGitleaks,
  type AssetInfo,
} from './gitleaks.js';

async function temporaryDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'gitleaks-test-'));
}

async function installOnCacheMiss(
  platform: string,
  arch: string
): Promise<{
  dir: string;
  result: string;
  download: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
  payload: Uint8Array;
}> {
  const dir = path.join(await temporaryDir(), 'nested');
  const payload = new TextEncoder().encode('binary-bytes');
  const download = vi.fn((): Promise<Uint8Array> => Promise.resolve(payload));
  const verify = vi.fn();
  const extract = vi.fn(async (_archive: string, target: string, asset: AssetInfo) => {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, asset.binaryName), 'extracted');
  });
  const result = await ensureGitleaks({ platform, arch, dir, download, verify, extract });
  return { dir, result, download, verify, payload };
}

describe('resolveAsset', () => {
  it('resolves the macOS arm64 tarball', () => {
    const asset = resolveAsset('darwin', 'arm64');
    expect(asset.fileName).toBe(`gitleaks_${GITLEAKS_VERSION}_darwin_arm64.tar.gz`);
    expect(asset.isZip).toBe(false);
    expect(asset.binaryName).toBe('gitleaks');
    expect(asset.url).toBe(
      `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${asset.fileName}`
    );
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves the macOS x64 tarball', () => {
    expect(resolveAsset('darwin', 'x64').fileName).toBe(
      `gitleaks_${GITLEAKS_VERSION}_darwin_x64.tar.gz`
    );
  });

  it('resolves the Linux arm64 tarball', () => {
    expect(resolveAsset('linux', 'arm64').fileName).toBe(
      `gitleaks_${GITLEAKS_VERSION}_linux_arm64.tar.gz`
    );
  });

  it('resolves the Linux x64 tarball', () => {
    expect(resolveAsset('linux', 'x64').fileName).toBe(
      `gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`
    );
  });

  it('resolves the Windows x64 zip with an .exe binary', () => {
    const asset = resolveAsset('win32', 'x64');
    expect(asset.fileName).toBe(`gitleaks_${GITLEAKS_VERSION}_windows_x64.zip`);
    expect(asset.isZip).toBe(true);
    expect(asset.binaryName).toBe('gitleaks.exe');
  });

  it('throws on an unsupported platform', () => {
    expect(() => resolveAsset('freebsd', 'x64')).toThrow(/unsupported platform/);
  });

  it('throws on an unsupported architecture', () => {
    expect(() => resolveAsset('linux', 'ia32')).toThrow(/unsupported platform/);
  });

  it('throws when no checksum is pinned for an otherwise-valid combo', () => {
    expect(() => resolveAsset('win32', 'arm64')).toThrow(/no pinned checksum/);
  });
});

describe('sha256Hex', () => {
  it('hashes empty input', () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('hashes "abc"', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});

describe('verifyChecksum', () => {
  it('passes when the hash matches', () => {
    const bytes = new TextEncoder().encode('abc');
    expect(() => {
      verifyChecksum(bytes, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    }).not.toThrow();
  });

  it('throws when the hash does not match', () => {
    expect(() => {
      verifyChecksum(new TextEncoder().encode('abc'), 'deadbeef');
    }).toThrow(/checksum mismatch/);
  });
});

describe('cacheDir', () => {
  it('points at the repo .cache/gitleaks/<version> directory', () => {
    const dir = cacheDir(GITLEAKS_VERSION).replaceAll('\\', '/');
    expect(dir.endsWith(`/.cache/gitleaks/${GITLEAKS_VERSION}`)).toBe(true);
  });
});

describe('runGitleaks', () => {
  const ensure = (): Promise<string> => Promise.resolve('/bin/gitleaks');

  it('returns the exit code when gitleaks succeeds', async () => {
    const exec = vi.fn((): Promise<{ exitCode?: number }> => Promise.resolve({ exitCode: 0 }));
    expect(await runGitleaks(['version'], { ensure, exec })).toBe(0);
    expect(exec).toHaveBeenCalledWith('/bin/gitleaks', ['version']);
  });

  it('propagates a nonzero exit code', async () => {
    const exec = vi.fn((): Promise<{ exitCode?: number }> => Promise.resolve({ exitCode: 5 }));
    expect(await runGitleaks(['git'], { ensure, exec })).toBe(5);
  });

  it('returns 1 when the process is killed without an exit code', async () => {
    const exec = vi.fn((): Promise<{ exitCode?: number }> => Promise.resolve({}));
    expect(await runGitleaks([], { ensure, exec })).toBe(1);
  });
});

describe('resolveEnsure', () => {
  it('fills defaults from the environment when options are omitted', () => {
    const resolved = resolveEnsure({});
    expect(resolved.dir).toBe(cacheDir(GITLEAKS_VERSION));
    expect(resolved.asset).toEqual(resolveAsset(process.platform, process.arch));
    expect(resolved.binPath).toBe(path.join(resolved.dir, resolved.asset.binaryName));
    expect(resolved.verify).toBe(verifyChecksum);
    expect(resolved.download).toBeTypeOf('function');
    expect(resolved.extract).toBeTypeOf('function');
  });

  it('prefers provided options over defaults', () => {
    const download = vi.fn();
    const extract = vi.fn();
    const verify = vi.fn();
    const resolved = resolveEnsure({
      platform: 'win32',
      arch: 'x64',
      version: '9.9.9',
      dir: '/opt/custom',
      download,
      extract,
      verify,
    });
    expect(resolved.dir).toBe('/opt/custom');
    expect(resolved.asset.fileName).toBe('gitleaks_9.9.9_windows_x64.zip');
    expect(resolved.binPath).toBe(path.join('/opt/custom', 'gitleaks.exe'));
    expect(resolved.download).toBe(download);
    expect(resolved.extract).toBe(extract);
    expect(resolved.verify).toBe(verify);
  });
});

describe('ensureGitleaks', () => {
  it('returns the cached binary without downloading when it already exists', async () => {
    const dir = await temporaryDir();
    await writeFile(path.join(dir, 'gitleaks'), 'cached');
    const download = vi.fn();
    const result = await ensureGitleaks({ platform: 'linux', arch: 'x64', dir, download });
    expect(result).toBe(path.join(dir, 'gitleaks'));
    expect(download).not.toHaveBeenCalled();
  });

  it('installs the executable binary on a cache miss', async () => {
    const { dir, result, download, verify, payload } = await installOnCacheMiss('linux', 'x64');
    expect(result).toBe(path.join(dir, 'gitleaks'));
    expect(download).toHaveBeenCalledWith(resolveAsset('linux', 'x64').url);
    expect(verify).toHaveBeenCalledWith(payload, resolveAsset('linux', 'x64').sha256);
    expect(existsSync(result)).toBe(true);
    const { mode } = await stat(result);
    expect(mode & 0o111).not.toBe(0);
  });

  it('removes the downloaded archive after extraction', async () => {
    const { dir } = await installOnCacheMiss('linux', 'x64');
    expect(existsSync(path.join(dir, resolveAsset('linux', 'x64').fileName))).toBe(false);
  });

  it('rejects without writing a binary when the checksum mismatches', async () => {
    const dir = await temporaryDir();
    const download = vi.fn(
      (): Promise<Uint8Array> => Promise.resolve(new TextEncoder().encode('tampered'))
    );
    await expect(ensureGitleaks({ platform: 'linux', arch: 'x64', dir, download })).rejects.toThrow(
      /checksum mismatch/
    );
    expect(existsSync(path.join(dir, 'gitleaks'))).toBe(false);
  });

  it('does not chmod a Windows .exe', async () => {
    const dir = await temporaryDir();
    const download = vi.fn((): Promise<Uint8Array> => Promise.resolve(new Uint8Array([1])));
    const verify = vi.fn();
    const extract = vi.fn(async (_archive: string, target: string, asset: AssetInfo) => {
      await writeFile(path.join(target, asset.binaryName), 'exe');
    });
    const result = await ensureGitleaks({
      platform: 'win32',
      arch: 'x64',
      dir,
      download,
      verify,
      extract,
    });
    expect(result).toBe(path.join(dir, 'gitleaks.exe'));
    expect(await readFile(result, 'utf8')).toBe('exe');
  });
});
