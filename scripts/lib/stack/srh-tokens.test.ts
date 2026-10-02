import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Mode, envConfig, resolveRaw } from '@hushbox/shared/env.config';
import {
  SRH_SERVICE,
  SRH_TOKENS_FILE,
  renderSrhTokens,
  tokenFor,
  writeSrhTokens,
} from './srh-tokens.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/**
 * The registry's own answer, reached without the module under test, so a test
 * that asks whether a pool carries the registry's token is not asking the
 * module to agree with itself.
 */
function registryToken(mode: Mode): string {
  const raw = resolveRaw(envConfig.UPSTASH_REDIS_REST_TOKEN, mode);
  // Not a fixture cast: the guard is the assertion. Every local mode's token is
  // a literal in the registry, and a mode whose token stopped being one is the
  // failure `tokenFor` exists to raise, so a test asserting against it would be
  // asserting against a production secret.
  if (typeof raw !== 'string') throw new TypeError(`no literal token for ${mode}`);
  return raw;
}

/** A spy over the real write, so a test can ask whether one happened at all. */
const writeFileSyncSpy = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: writeFileSyncSpy };
});

// The suite resets every mock between tests, which strips the pass-through
// along with the recorded calls, so the spy is pointed back at the real write
// before each one rather than once at module load.
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
beforeEach(() => {
  writeFileSyncSpy.mockImplementation(realFs.writeFileSync);
});

describe('renderSrhTokens', () => {
  it('names each pool by the token the registry gives that mode', () => {
    const pools = JSON.parse(renderSrhTokens()) as Record<string, unknown>;

    expect(Object.keys(pools)).toEqual([
      registryToken(Mode.Development),
      registryToken(Mode.CiVitest),
      registryToken(Mode.E2E),
    ]);
  });

  it('gives each pool a Redis database of its own, so one mode cannot read another', () => {
    const pools = JSON.parse(renderSrhTokens()) as Record<string, { connection_string: string }>;
    const databases = Object.values(pools).map((pool) => pool.connection_string);

    expect(new Set(databases).size).toBe(Object.keys(pools).length);
  });

  it('ends in a newline, so the committed file matches what the formatter writes', () => {
    expect(renderSrhTokens().endsWith('\n')).toBe(true);
  });
});

describe('the committed token file', () => {
  it('is what the registry produces, so a token renamed there cannot be left behind here', () => {
    expect(readFileSync(path.join(REPO_ROOT, SRH_TOKENS_FILE), 'utf8')).toBe(renderSrhTokens());
  });
});

describe('writeSrhTokens', () => {
  it('writes the file where the compose mount expects it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hb-srh-'));
    try {
      writeSrhTokens(root);
      expect(readFileSync(path.join(root, SRH_TOKENS_FILE), 'utf8')).toBe(renderSrhTokens());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names the service that has to be recreated when it wrote a new file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hb-srh-'));
    try {
      // The file is a path mount, so compose's config hash cannot see a token
      // change in it and the proxy reads it once at boot. Nothing but an
      // explicit recreate carries a new token into the running container.
      expect(writeSrhTokens(root)).toEqual([SRH_SERVICE]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves an already-current file untouched, so nothing recreates a container for nothing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hb-srh-'));
    try {
      writeSrhTokens(root);
      writeFileSyncSpy.mockClear();

      const recreate = writeSrhTokens(root);

      // Not the bytes: rewriting identical bytes leaves them identical, so a
      // contents comparison passes whether the skip happened or not.
      expect(writeFileSyncSpy).not.toHaveBeenCalled();
      expect(recreate).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replaces a file whose contents have drifted', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hb-srh-'));
    try {
      mkdirSync(path.join(root, path.dirname(SRH_TOKENS_FILE)), { recursive: true });
      writeFileSync(path.join(root, SRH_TOKENS_FILE), '{"stale_token":{}}\n');

      const recreate = writeSrhTokens(root);

      expect(readFileSync(path.join(root, SRH_TOKENS_FILE), 'utf8')).toBe(renderSrhTokens());
      expect(recreate).toEqual([SRH_SERVICE]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('tokenFor', () => {
  it('refuses a mode whose token is a production secret rather than fronting a pool with it', () => {
    expect(() => tokenFor(Mode.Production)).toThrow(/no literal token/);
  });
});

describe('the compose healthcheck', () => {
  it('spells no bearer token of its own, so the generated pool file stays the only source', () => {
    const compose = readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');

    for (const mode of [Mode.Development, Mode.CiVitest, Mode.E2E]) {
      expect(compose).not.toContain(registryToken(mode));
    }
  });
});
