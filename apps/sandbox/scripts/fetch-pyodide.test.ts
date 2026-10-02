import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * The wheel fetch is the sandbox's supply-chain seam: 13 unsigned wheels pulled
 * from a CDN into the tree that runs untrusted document code, cached by CI on
 * the script's own text. These tests drive the real script against a local
 * origin and a scratch directory, so what is exercised is the committed bytes
 * rather than a re-implementation of them.
 *
 * The core runtime is not exercised here: it comes from `npm pack`, which npm
 * integrity-checks, and the scratch directory is seeded with it so the script
 * goes straight to the wheels.
 */

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fetch-pyodide.sh');

/** The core files the script copies out of the npm tarball. */
const CORE_FILES = [
  'pyodide.mjs',
  'pyodide.js',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
];

/**
 * The pinned wheel set, read from the script itself — the script is the source
 * of truth for exactly which bytes land in the tree, so a test carrying its own
 * copy of the list would be a second one that could drift from it.
 */
function pinnedWheels(): readonly string[] {
  const script = readFileSync(SCRIPT, 'utf8');
  return [...script.matchAll(/^\s*([A-Za-z0-9._+-]+\.whl)\s*$/gm)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]]
  );
}

/** The bytes the fake origin serves for a wheel: deterministic, per name. */
function wheelBody(name: string): Buffer {
  return Buffer.from(`wheel bytes for ${name}`);
}

/** A lock file shaped like Pyodide's, carrying the sha256 of what is served. */
function lockFileFor(wheels: readonly string[]): string {
  const packages = Object.fromEntries(
    wheels.map((name) => [
      name.split('-')[0],
      {
        name: name.split('-')[0],
        file_name: name,
        sha256: createHash('sha256').update(wheelBody(name)).digest('hex'),
      },
    ])
  );
  return JSON.stringify({ info: { version: '314.0.2' }, packages });
}

interface Origin {
  readonly url: string;
  readonly requests: string[];
  close(): Promise<void>;
}

/**
 * A stand-in for the wheel CDN. `status` 404 answers every request with one;
 * `corrupt` answers 200 with bytes the lock does not describe — an origin that
 * lies, which is the threat the per-wheel hash comparison exists to close.
 */
async function startOrigin(status: 200 | 404 | 'corrupt'): Promise<Origin> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const name = path.basename(req.url ?? '');
    requests.push(name);
    if (status === 404) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html>not found</html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(status === 'corrupt' ? Buffer.from('substituted payload') : wheelBody(name));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('origin has no port');
  return {
    url: `http://127.0.0.1:${String(address.port)}/full`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe('fetch-pyodide', () => {
  const wheels = pinnedWheels();
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pyodide-fetch-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A scratch asset directory holding the core runtime and nothing else.
   * `lockWheels` is the set the lock file describes, which the pinned set can
   * outrun when a name goes stale upstream.
   */
  function freshDir(lockWheels: readonly string[] = wheels): string {
    const target = mkdtempSync(path.join(dir, 'run-'));
    for (const file of CORE_FILES) writeFileSync(path.join(target, file), `stub ${file}`);
    writeFileSync(path.join(target, 'pyodide-lock.json'), lockFileFor(lockWheels));
    return target;
  }

  /** The first pinned wheel — the one the main loop reaches before any other. */
  function firstPinnedWheel(): string {
    const [first] = wheels;
    if (first === undefined) throw new Error('the script names no wheels');
    return first;
  }

  /**
   * Run the committed script through its own shebang, resolving to its exit
   * code however it ended.
   */
  function run(
    target: string,
    origin: Origin,
    cwd?: string
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(SCRIPT, [target, origin.url], { cwd }, (error, stdout, stderr) => {
        const code = error === null ? 0 : ((error as { code?: number }).code ?? 1);
        resolve({ exitCode: code, stdout, stderr });
      });
    });
  }

  it('names at least the numpy and micropip wheels', () => {
    // The list is read out of the script; an expression that matched nothing
    // would make every test below vacuously pass.
    expect(wheels).toContain('micropip-0.11.1-py3-none-any.whl');
    expect(wheels.some((name) => name.startsWith('numpy-'))).toBe(true);
  });

  it('leaves no wheel behind and exits non-zero when the CDN answers 404', async () => {
    const target = freshDir();
    const origin = await startOrigin(404);
    try {
      const result = await run(target, origin);
      expect(result.exitCode).not.toBe(0);
      expect(readdirSync(target).filter((name) => name.endsWith('.whl'))).toEqual([]);
    } finally {
      await origin.close();
    }
  }, 60_000);

  it('fetches every pinned wheel when the directory is empty', async () => {
    const target = freshDir();
    const origin = await startOrigin(200);
    try {
      const result = await run(target, origin);
      const byName = (a: string, b: string): number => a.localeCompare(b);
      expect(result.exitCode).toBe(0);
      expect(
        readdirSync(target)
          .filter((name) => name.endsWith('.whl'))
          .toSorted(byName)
      ).toEqual(wheels.toSorted(byName));
    } finally {
      await origin.close();
    }
  }, 60_000);

  it('re-fetches a wheel whose bytes no longer match the lock', async () => {
    const target = freshDir();
    const origin = await startOrigin(200);
    try {
      const first = await run(target, origin);
      expect(first.exitCode).toBe(0);
      const poisoned = path.join(target, 'micropip-0.11.1-py3-none-any.whl');
      writeFileSync(poisoned, '<html>404 not found</html>');
      origin.requests.length = 0;

      const result = await run(target, origin);
      expect(result.exitCode).toBe(0);
      expect(origin.requests).toContain('micropip-0.11.1-py3-none-any.whl');
      expect(readFileSync(poisoned)).toEqual(wheelBody('micropip-0.11.1-py3-none-any.whl'));
    } finally {
      await origin.close();
    }
  }, 60_000);

  it('leaves no wheel behind when the origin answers 200 with bytes the lock does not describe', async () => {
    const target = freshDir();
    const origin = await startOrigin('corrupt');
    try {
      const result = await run(target, origin);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('lock says');
      expect(readdirSync(target).filter((name) => name.endsWith('.whl'))).toEqual([]);
    } finally {
      await origin.close();
    }
  }, 60_000);

  it('refuses a pinned wheel the lock has no entry for', async () => {
    const unlisted = firstPinnedWheel();
    const target = freshDir(wheels.filter((name) => name !== unlisted));
    const origin = await startOrigin(200);
    try {
      const result = await run(target, origin);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('no entry in pyodide-lock.json');
      expect(readdirSync(target).filter((name) => name.endsWith('.whl'))).toEqual([]);
      expect(origin.requests).toEqual([unlisted]);
    } finally {
      await origin.close();
    }
  }, 60_000);

  it('stops without re-fetching a wheel already on disk that the lock has no entry for', async () => {
    const unlisted = firstPinnedWheel();
    const target = freshDir();
    const origin = await startOrigin(200);
    try {
      const first = await run(target, origin);
      expect(first.exitCode).toBe(0);
      writeFileSync(
        path.join(target, 'pyodide-lock.json'),
        lockFileFor(wheels.filter((name) => name !== unlisted))
      );
      origin.requests.length = 0;

      const result = await run(target, origin);
      expect(result.exitCode).not.toBe(0);
      expect(origin.requests).toEqual([]);
    } finally {
      await origin.close();
    }
  }, 60_000);

  it('resolves a relative target directory against the working directory it was run from', async () => {
    const target = freshDir();
    const origin = await startOrigin(200);
    try {
      const result = await run(path.basename(target), origin, dir);
      expect(result.exitCode).toBe(0);
      expect(readdirSync(target).filter((name) => name.endsWith('.whl'))).toHaveLength(
        wheels.length
      );
    } finally {
      await origin.close();
    }
  }, 60_000);

  it('downloads nothing when every wheel already verifies', async () => {
    const target = freshDir();
    const origin = await startOrigin(200);
    try {
      const first = await run(target, origin);
      expect(first.exitCode).toBe(0);
      origin.requests.length = 0;

      const result = await run(target, origin);
      expect(result.exitCode).toBe(0);
      expect(origin.requests).toEqual([]);
    } finally {
      await origin.close();
    }
  }, 60_000);
});
