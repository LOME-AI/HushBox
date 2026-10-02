import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { secondsAt, TEST_DAY_START } from '@hushbox/shared/test-time';

import {
  GITLEAKS_VERSION,
  resolveAsset,
  resolveEnsure,
  verifyChecksum,
  cacheDir,
  ensureGitleaks,
  runGitleaks,
  gitleaksRangeScanArgs,
  type AssetInfo,
} from './gitleaks.js';

/** Every scratch root this file made, so `afterEach` removes exactly those. */
const scratchRoots: string[] = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporaryDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'gitleaks-test-'));
  scratchRoots.push(root);
  return root;
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

describe('gitleaksRangeScanArgs', () => {
  it('scans the commits of the given log range with every finding redacted', () => {
    expect(gitleaksRangeScanArgs('oldsha..newsha')).toEqual([
      'git',
      '--redact',
      '--no-banner',
      '--log-opts=oldsha..newsha --diff-merges=first-parent',
    ]);
  });
});

/** Every commit stamp in the scratch repositories, so no fixture reads a running clock. */
const FIXTURE_STAMP = `@${String(secondsAt(TEST_DAY_START))} +0000`;

/**
 * A token gitleaks' default `github-pat` rule detects, assembled per run so this
 * file holds no secret-shaped literal for the repository's own scans to find.
 */
function githubTokenShape(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const body = Array.from({ length: 36 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `ghp_${body}`;
}

interface ScratchRepository {
  readonly directory: string;
  /** Runs git in the repository, rejecting with git's stderr when it exits non-zero. */
  git: (...args: string[]) => Promise<string>;
  /** Runs a merge that must stop on a conflict, rejecting when it exits anything but 1. */
  mergeExpectingConflict: (...branches: string[]) => Promise<void>;
  writeFile: (name: string, value: string) => Promise<void>;
}

/** A repository in this file's scratch root, isolated from the developer's git config. */
async function scratchRepository(): Promise<ScratchRepository> {
  const root = await temporaryDir();
  const directory = path.join(root, 'repo');
  const globalConfig = path.join(root, 'gitconfig');
  await writeFile(globalConfig, '');
  const env = {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: FIXTURE_STAMP,
    GIT_COMMITTER_DATE: FIXTURE_STAMP,
    GIT_AUTHOR_NAME: 'agent',
    GIT_AUTHOR_EMAIL: 'agent@hushbox.ai',
    GIT_COMMITTER_NAME: 'agent',
    GIT_COMMITTER_EMAIL: 'agent@hushbox.ai',
  };
  await mkdir(directory);
  const git = async (...args: string[]): Promise<string> => {
    const result = await execa('git', ['-C', directory, ...args], { env });
    return result.stdout.trim();
  };
  const mergeExpectingConflict = async (...branches: string[]): Promise<void> => {
    const result = await execa('git', ['-C', directory, 'merge', '-q', ...branches], {
      env,
      reject: false,
    });
    if (result.exitCode !== 1) {
      throw new Error(
        `expected a conflicting merge (exit 1), got exit ${String(result.exitCode)}: ${result.stderr}`
      );
    }
  };
  const writeFileInRepository = async (name: string, value: string): Promise<void> => {
    await writeFile(path.join(directory, name), `value = ${value}\n`);
  };
  await git('init', '-q', '-b', 'main');
  return { directory, git, mergeExpectingConflict, writeFile: writeFileInRepository };
}

async function parentCount(repo: ScratchRepository, revision: string): Promise<number> {
  const line = await repo.git('rev-list', '--parents', '-n', '1', revision);
  return line.split(' ').length - 1;
}

/**
 * Two branches edit the same line, the merge conflicts, and its resolution writes
 * `resolution`; a later commit restores the line. Resolves to the range from the
 * base commit to that tip.
 */
async function conflictMergeRange(repo: ScratchRepository, resolution: string): Promise<string> {
  await repo.writeFile('settings.txt', 'base');
  await repo.git('add', '-A');
  await repo.git('commit', '-qm', 'base');
  const base = await repo.git('rev-parse', 'HEAD');
  await repo.git('checkout', '-qb', 'side');
  await repo.writeFile('settings.txt', 'side');
  await repo.git('commit', '-qam', 'side');
  await repo.git('checkout', '-q', 'main');
  await repo.writeFile('settings.txt', 'main');
  await repo.git('commit', '-qam', 'main');
  await repo.mergeExpectingConflict('side');
  await repo.writeFile('settings.txt', resolution);
  await repo.git('add', '-A');
  await repo.git('commit', '-q', '--no-edit');
  expect(await parentCount(repo, 'HEAD')).toBe(2);
  await repo.writeFile('settings.txt', 'base');
  await repo.git('commit', '-qam', 'restore');
  return `${base}..HEAD`;
}

/**
 * Two side branches each edit their own file and merge cleanly into `main` as one
 * three-parent commit whose own changes write `settings.txt`; a later commit
 * restores it. Resolves to the range from the base commit to that tip.
 */
async function octopusMergeRange(repo: ScratchRepository, mergeValue: string): Promise<string> {
  await repo.writeFile('settings.txt', 'base');
  await repo.git('add', '-A');
  await repo.git('commit', '-qm', 'base');
  const base = await repo.git('rev-parse', 'HEAD');
  for (const branch of ['left', 'right']) {
    await repo.git('checkout', '-qb', branch, base);
    await repo.writeFile(`${branch}.txt`, branch);
    await repo.git('add', '-A');
    await repo.git('commit', '-qm', branch);
  }
  await repo.git('checkout', '-q', 'main');
  await repo.git('merge', '-q', '--no-ff', '--no-commit', 'left', 'right');
  await repo.writeFile('settings.txt', mergeValue);
  await repo.git('add', '-A');
  await repo.git('commit', '-q', '--no-edit');
  expect(await parentCount(repo, 'HEAD')).toBe(3);
  await repo.writeFile('settings.txt', 'base');
  await repo.git('commit', '-qam', 'restore');
  return `${base}..HEAD`;
}

async function scanExitCode(
  repo: ScratchRepository,
  range: string,
  env: Record<string, string> = {}
): Promise<number | undefined> {
  const bin = await ensureGitleaks();
  const result = await execa(bin, gitleaksRangeScanArgs(range), {
    cwd: repo.directory,
    env,
    reject: false,
  });
  return result.exitCode;
}

describe('gitleaksRangeScanArgs with the pinned scanner', () => {
  it('fails a range whose merge resolution introduced a secret a later commit removed', async () => {
    const repo = await scratchRepository();
    const range = await conflictMergeRange(repo, githubTokenShape());
    expect(await scanExitCode(repo, range)).toBe(1);
  });

  it('passes a range whose merge resolution holds no secret', async () => {
    const repo = await scratchRepository();
    const range = await conflictMergeRange(repo, 'merged');
    expect(await scanExitCode(repo, range)).toBe(0);
  });

  it('fails a range whose three-parent merge introduced a secret a later commit removed', async () => {
    const repo = await scratchRepository();
    const range = await octopusMergeRange(repo, githubTokenShape());
    expect(await scanExitCode(repo, range)).toBe(1);
  });

  it.each(['dense-combined', 'combined', 'off'])(
    'fails a merge-borne secret whatever log.diffMerges the environment sets (%s)',
    async (format) => {
      const repo = await scratchRepository();
      const range = await conflictMergeRange(repo, githubTokenShape());
      const configured = {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'log.diffMerges',
        GIT_CONFIG_VALUE_0: format,
      };
      expect(await scanExitCode(repo, range, configured)).toBe(1);
    }
  );
});

describe('resolveEnsure', () => {
  it('fills the directory, asset, binary path and verifier from the environment', () => {
    const resolved = resolveEnsure({});
    expect(resolved.dir).toBe(cacheDir(GITLEAKS_VERSION));
    expect(resolved.asset).toEqual(resolveAsset(process.platform, process.arch));
    expect(resolved.binPath).toBe(path.join(resolved.dir, resolved.asset.binaryName));
    expect(resolved.verify).toBe(verifyChecksum);
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
