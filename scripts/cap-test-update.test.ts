import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  generateVersionString,
  getDistributionZipPath,
  getApiBaseUrl,
  getSetChecksumUrl,
  getSetVersionUrl,
  getUpdatesCurrentUrl,
  getR2ObjectKey,
  parsePlatformArgument,
  runCapTestUpdate,
  zipDirectory,
} from './cap-test-update.js';
import { wranglerPersistPath } from './wrangler-dev.js';
import { stackModeFrom } from './with-env.js';

const dollarMock = vi.hoisted(() => vi.fn());
const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ $: dollarMock, execa: execaMock }));

/** Any allocated port; the point is that no literal decides where the API is. */
const API_PORT = 10_242;
const API_ORIGIN = `http://localhost:${String(API_PORT)}`;

beforeEach(() => {
  vi.stubEnv('HB_API_PORT', String(API_PORT));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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
  it('returns the API URL of the port this checkout was allocated', () => {
    expect(getApiBaseUrl()).toBe(API_ORIGIN);
  });

  it('names the port variable rather than falling back to a literal port', () => {
    vi.stubEnv('HB_API_PORT', '');
    expect(() => getApiBaseUrl()).toThrow('HB_API_PORT');
  });
});

describe('getSetChecksumUrl', () => {
  it('returns the dev/set-checksum endpoint URL', () => {
    expect(getSetChecksumUrl()).toBe(`${API_ORIGIN}/dev/set-checksum`);
  });
});

describe('getUpdatesCurrentUrl', () => {
  it('returns the updates/current endpoint URL', () => {
    expect(getUpdatesCurrentUrl()).toBe(`${API_ORIGIN}/updates/current`);
  });
});

describe('getSetVersionUrl', () => {
  it('returns the dev/set-version endpoint URL', () => {
    expect(getSetVersionUrl()).toBe(`${API_ORIGIN}/dev/set-version`);
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

describe('runCapTestUpdate', () => {
  let rootDir: string;
  const fetchMock = vi.fn();
  /** Records each subprocess as { options, command }, whichever spelling ran it. */
  let shellCalls: { options: Record<string, unknown>; command: string }[];

  /**
   * The sha256 of the zip as it stood at upload time. Taken there because the
   * scratch directory is gone by the time the assertion runs, which is the
   * behaviour under test.
   */
  let uploadedZipSha: string | null;

  /** The `--file` argument of the recorded wrangler upload. */
  function uploadedZipPath(): string {
    const upload = shellCalls.find((call) => call.command.includes('wrangler r2 object put'));
    const words = upload!.command.split(' ');
    return words[words.indexOf('--file') + 1]!;
  }

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'cap-test-update-run-'));
    mkdirSync(path.join(rootDir, 'apps', 'web', 'dist'), { recursive: true });
    writeFileSync(path.join(rootDir, 'apps', 'web', 'dist', 'index.html'), '<html></html>');

    shellCalls = [];
    uploadedZipSha = null;
    const record = (options: Record<string, unknown>, command: string): Promise<void> => {
      shellCalls.push({ options, command });
      if (command.includes('wrangler r2 object put')) {
        uploadedZipSha = createHash('sha256').update(readFileSync(uploadedZipPath())).digest('hex');
      }
      return Promise.resolve();
    };
    dollarMock.mockReset();
    dollarMock.mockImplementation((options: Record<string, unknown>) => {
      return (strings: TemplateStringsArray, ...values: string[]): Promise<void> =>
        record(
          options,
          strings.reduce((joined, part, index) => joined + part + (values[index] ?? ''), '')
        );
    });
    execaMock.mockReset();
    execaMock.mockImplementation(
      (file: string, args: string[], options: Record<string, unknown>): Promise<void> =>
        record(options, [file, ...args].join(' '))
    );

    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/updates/current')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.9' }) });
      }
      return Promise.resolve({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds the web app with the generated version in the environment', async () => {
    await runCapTestUpdate(rootDir);

    const build = shellCalls.find((call) => call.command === 'pnpm exec vite build');
    expect(build).toBeDefined();
    expect(build!.options['cwd']).toBe(path.join(rootDir, 'apps', 'web'));
    const environment = build!.options['env'] as Record<string, string>;
    expect(environment['VITE_APP_VERSION']).toMatch(/^dev-update-/);
    expect(environment['VITE_PLATFORM']).toBe('android-direct');
  });

  it('leaves no zip behind in the checkout', async () => {
    await runCapTestUpdate(rootDir);

    expect(existsSync(path.join(rootDir, 'web-dist.zip'))).toBe(false);
  });

  it('removes the scratch directory it zipped into once the run succeeds', async () => {
    await runCapTestUpdate(rootDir);

    expect(existsSync(uploadedZipPath())).toBe(false);
    expect(existsSync(path.dirname(uploadedZipPath()))).toBe(false);
  });

  it('removes the scratch directory it zipped into when the run fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/updates/current')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.9' }) });
      }
      if (url.endsWith('/dev/set-version')) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true });
    });

    await expect(runCapTestUpdate(rootDir)).rejects.toThrow('Failed to set version');
    expect(existsSync(path.dirname(uploadedZipPath()))).toBe(false);
  });

  it('uploads the zip to R2 under the platform-specific key', async () => {
    await runCapTestUpdate(rootDir, 'ios');

    const upload = shellCalls.find((call) => call.command.includes('wrangler r2 object put'));
    expect(upload).toBeDefined();
    expect(upload!.command).toContain('hushbox-app-builds/builds/ios/');
    expect(upload!.options['cwd']).toBe(path.join(rootDir, 'apps', 'api'));
  });

  it("uploads into the store of the stack it runs under, never wrangler's default", async () => {
    await runCapTestUpdate(rootDir);

    const upload = shellCalls.find((call) => call.command.includes('wrangler r2 object put'));
    expect(upload!.command).toContain(
      `--persist-to ${wranglerPersistPath(stackModeFrom(process.env))}`
    );
  });

  it('uploads a zip staged outside the checkout', async () => {
    await runCapTestUpdate(rootDir);

    expect(uploadedZipPath().startsWith(rootDir)).toBe(false);
  });

  it('posts the same generated version to the set-version endpoint', async () => {
    await runCapTestUpdate(rootDir);

    const build = shellCalls.find((call) => call.command === 'pnpm exec vite build');
    const environment = build!.options['env'] as Record<string, string>;
    const setVersionCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/dev/set-version')
    );
    expect(setVersionCall).toBeDefined();
    const requestInit = setVersionCall![1] as { method: string; body: string };
    expect(requestInit.method).toBe('POST');
    expect(JSON.parse(requestInit.body)).toEqual({
      version: environment['VITE_APP_VERSION'],
    });
  });

  it('publishes the sha256 of the uploaded zip before setting the version', async () => {
    await runCapTestUpdate(rootDir, 'ios');

    const endpoints = fetchMock.mock.calls.map(([url]) => String(url));
    const checksumCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/dev/set-checksum')
    );
    expect(checksumCall).toBeDefined();
    const body = JSON.parse((checksumCall![1] as { body: string }).body) as unknown;
    expect(body).toEqual({ platform: 'ios', checksum: uploadedZipSha });
    // One response carries both, so a device polling between the two calls
    // must never see the new version without the checksum that installs it.
    expect(endpoints.indexOf(getSetChecksumUrl())).toBeLessThan(
      endpoints.indexOf(getSetVersionUrl())
    );
  });

  it('throws when publishing the bundle checksum fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/updates/current')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.9' }) });
      }
      return Promise.resolve({ ok: url.endsWith('/dev/set-version'), status: 503 });
    });

    await expect(runCapTestUpdate(rootDir)).rejects.toThrow('Failed to publish checksum: 503');
  });

  it('throws when the current-version query fails without building', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(runCapTestUpdate(rootDir)).rejects.toThrow('Failed to query current version: 500');
    expect(shellCalls).toHaveLength(0);
  });

  it('throws when setting the version override fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/dev/set-version')) {
        return Promise.resolve({ ok: false, status: 503 });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.9' }) });
    });

    await expect(runCapTestUpdate(rootDir)).rejects.toThrow('Failed to set version: 503');
  });
});

describe('parsePlatformArgument', () => {
  it('returns undefined when --platform is not provided', () => {
    expect(parsePlatformArgument([])).toBeUndefined();
  });

  it('refuses --platform left without a value', () => {
    expect(() => parsePlatformArgument(['--platform'])).toThrow(/--platform/);
  });

  it('refuses a flag it does not recognise', () => {
    expect(() => parsePlatformArgument(['--platfrom', 'ios'])).toThrow(/--platfrom/);
  });

  it('names no platform for a line asking for usage', () => {
    expect(parsePlatformArgument(['--help'])).toBeUndefined();
  });

  it('returns the platform value when provided', () => {
    expect(parsePlatformArgument(['--platform', 'ios'])).toBe('ios');
  });

  it('parses android-direct platform', () => {
    expect(parsePlatformArgument(['--platform', 'android-direct'])).toBe('android-direct');
  });
});
