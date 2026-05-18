import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateVersionString,
  getDistributionZipPath,
  getApiBaseUrl,
  getSetVersionUrl,
  getUpdatesCurrentUrl,
  getR2ObjectKey,
  parsePlatformArgument,
  zipDirectory,
} from './cap-test-update.js';

describe('generateVersionString', () => {
  it('generates a string starting with dev-update-', () => {
    const version = generateVersionString();
    expect(version).toMatch(/^dev-update-/);
  });

  it('generates unique strings on successive calls', () => {
    const v1 = generateVersionString();
    const v2 = generateVersionString();
    expect(v1).not.toBe(v2);
  });

  it('includes a timestamp and counter component', () => {
    const version = generateVersionString();
    // Format: dev-update-{timestamp}-{counter}
    const parts = version.replace('dev-update-', '').split('-');
    expect(parts).toHaveLength(2);
    expect(Number(parts[0])).toBeGreaterThan(0);
    expect(Number(parts[1])).toBeGreaterThan(0);
  });
});

describe('getDistZipPath', () => {
  it('returns the dist zip path under web app', () => {
    const result = getDistributionZipPath('/root');
    expect(result).toBe('/root/apps/web/dist');
  });
});

describe('getApiBaseUrl', () => {
  it('returns the default local API URL', () => {
    expect(getApiBaseUrl()).toBe('http://localhost:8787');
  });
});

describe('getUpdatesCurrentUrl', () => {
  it('returns the updates/current endpoint URL', () => {
    expect(getUpdatesCurrentUrl()).toBe('http://localhost:8787/api/updates/current');
  });
});

describe('getSetVersionUrl', () => {
  it('returns the dev/set-version endpoint URL', () => {
    expect(getSetVersionUrl()).toBe('http://localhost:8787/api/dev/set-version');
  });
});

describe('getR2ObjectKey', () => {
  it('returns platform-specific R2 key for ios', () => {
    expect(getR2ObjectKey('ios', 'abc123')).toBe('hushbox-app-builds/builds/ios/abc123.zip');
  });

  it('returns platform-specific R2 key for android', () => {
    expect(getR2ObjectKey('android', '1.0.0')).toBe('hushbox-app-builds/builds/android/1.0.0.zip');
  });

  it('returns platform-specific R2 key for android-direct', () => {
    expect(getR2ObjectKey('android-direct', 'dev-update-1234567890')).toBe(
      'hushbox-app-builds/builds/android-direct/dev-update-1234567890.zip'
    );
  });
});

describe('zipDirectory', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'cap-test-zip-'));
  });

  function cleanup(): void {
    rmSync(temporaryDir, { recursive: true, force: true });
  }

  it('creates a zip file at the target path containing entries for the source files', async () => {
    const sourceDir = path.join(temporaryDir, 'src');
    mkdirSync(sourceDir);
    writeFileSync(path.join(sourceDir, 'a.txt'), 'alpha');
    writeFileSync(path.join(sourceDir, 'b.txt'), 'beta');

    const zipPath = path.join(temporaryDir, 'out.zip');
    await zipDirectory(sourceDir, zipPath);

    const zipBytes = readFileSync(zipPath);
    // PK\x03\x04 = local file header signature
    expect(zipBytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(zipBytes.byteLength).toBeGreaterThan(0);

    const zipString = zipBytes.toString('binary');
    expect(zipString).toContain('a.txt');
    expect(zipString).toContain('b.txt');

    cleanup();
  });

  it('includes nested files relative to the source directory root', async () => {
    const sourceDir = path.join(temporaryDir, 'src');
    const nested = path.join(sourceDir, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, 'deep.txt'), 'deep content');

    const zipPath = path.join(temporaryDir, 'out.zip');
    await zipDirectory(sourceDir, zipPath);

    const zipBytes = readFileSync(zipPath);
    const zipString = zipBytes.toString('binary');
    expect(zipString).toContain('nested/deep.txt');

    cleanup();
  });

  it('rejects when archiver cannot write to the destination', async () => {
    const sourceDir = path.join(temporaryDir, 'src');
    mkdirSync(sourceDir);
    const invalidZipPath = path.join(temporaryDir, 'no-such-dir', 'out.zip');
    await expect(zipDirectory(sourceDir, invalidZipPath)).rejects.toThrow();
    cleanup();
  });
});

describe('parsePlatformArgument', () => {
  it('returns undefined when --platform is not provided', () => {
    expect(parsePlatformArgument([])).toBeUndefined();
  });

  it('returns undefined when --platform has no value', () => {
    expect(parsePlatformArgument(['--platform'])).toBeUndefined();
  });

  it('returns the platform value when provided', () => {
    expect(parsePlatformArgument(['--platform', 'ios'])).toBe('ios');
  });

  it('parses android-direct platform', () => {
    expect(parsePlatformArgument(['--platform', 'android-direct'])).toBe('android-direct');
  });
});
