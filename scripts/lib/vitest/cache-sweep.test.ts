import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ClaimHeldError, HELD_CLAIMS_ENV } from '../claims/claim.js';
import { readOwnership, recordOwnedResource } from '../claims/ownership.js';
import { RUN_CLAIM_ENV, registerRun, releaseBeforeRecordDrops } from '../claims/registry.js';
import { canonicalPath } from '../canonical-path.js';
import {
  CACHE_MAX_AGE_MS,
  CACHE_SLOT_CLAIMS_DIR,
  cacheNodeModulesDirectories,
  claimAndPruneCacheDirectories,
  markCacheDirUsed,
  withRunnerCacheClaim,
} from './cache-sweep.js';
import {
  OPTIMIZED_PACKAGES,
  RUN_CACHE_GENERATION_ENV,
  RUN_CACHE_SEGMENT_ENV,
  cacheDirName,
  optimizedSourcesFingerprint,
  resolveRunnerCacheNames,
  runCacheSegment,
  runnerCacheSegment,
  runnerMarkerName,
  slotCacheSegment,
} from './vitest-cache.js';

let workDir = '';
let registryDir = '';

/**
 * The tokens this file was invoked under. Both are cleared before every case
 * below, and a hook that puts back an empty string instead leaves every later
 * suite here — and everything else this worker goes on to run — creating
 * resources no claim names.
 */
const inheritedRunClaim = process.env[RUN_CLAIM_ENV];
const inheritedHeldClaims = process.env[HELD_CLAIMS_ENV];

beforeEach(() => {
  // Both tokens are inherited from whatever invoked the suite, so a case that
  // registers a run of its own would otherwise adopt that one and write into
  // the machine-wide registry. Neutralised before the first case rather than
  // after it: a token cleared only in teardown makes the first case of the file
  // fail and every later one pass.
  process.env[RUN_CLAIM_ENV] = '';
  process.env[HELD_CLAIMS_ENV] = '';
  workDir = mkdtempSync(path.join(tmpdir(), 'hb-cache-sweep-'));
  registryDir = mkdtempSync(path.join(tmpdir(), 'hb-cache-sweep-registry-'));
});

afterEach(() => {
  // Empty string rather than absent: every reader treats an empty token as
  // none, and a computed key cannot be deleted.
  process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
  process.env[HELD_CLAIMS_ENV] = inheritedHeldClaims ?? '';
  rmSync(workDir, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

/** A checkout path the registry records; nothing reads through it. */
const CHECKOUT = path.join(path.sep, 'checkout-under-test', '.git');

/** Runs `body` as a registered run holding its claim in this isolated registry. */
function inRun<T>(command: string, body: () => Promise<T>): Promise<T> {
  return registerRun(
    { command, mode: 'development', slot: 0, gitCommonDir: CHECKOUT, registryDir },
    body
  );
}

function ageDir(dir: string, ageMs: number): void {
  const seconds = (Date.now() - ageMs) / 1000;
  utimesSync(dir, seconds, seconds);
}

describe('cacheNodeModulesDirectories', () => {
  const byName = (paths: readonly string[]): string[] =>
    paths.toSorted((first, second) => first.localeCompare(second));

  function makeWorkspace(root: string, name: string): string {
    const dir = path.join(root, 'packages', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@hushbox/${name}` }));
    return path.join(dir, 'node_modules');
  }

  function makeRepo(...names: string[]): string {
    const root = path.join(workDir, 'repo');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    for (const name of names) makeWorkspace(root, name);
    return root;
  }

  it('names the node_modules of the repository root and of every declared workspace', () => {
    const root = makeRepo('alpha', 'beta');

    const directories = cacheNodeModulesDirectories(root, root);

    expect(byName(directories)).toEqual(
      byName([
        path.join(root, 'node_modules'),
        path.join(root, 'packages', 'alpha', 'node_modules'),
        path.join(root, 'packages', 'beta', 'node_modules'),
      ])
    );
  });

  it('names a workspace added to the manifest with nothing else edited', () => {
    const root = makeRepo('alpha');
    const before = cacheNodeModulesDirectories(root, root);

    const added = makeWorkspace(root, 'gamma');

    expect(byName(cacheNodeModulesDirectories(root, root))).toEqual(byName([...before, added]));
  });

  it('names the working directory even when it is not a declared workspace', () => {
    const root = makeRepo('alpha');
    const outside = path.join(workDir, 'elsewhere');
    mkdirSync(outside, { recursive: true });

    expect(cacheNodeModulesDirectories(root, outside)).toContain(
      path.join(outside, 'node_modules')
    );
  });

  it('names the same set when the working directory is reached through a symlink', () => {
    const root = makeRepo('alpha');
    const link = path.join(workDir, 'linked-repo');
    symlinkSync(root, link);

    expect(cacheNodeModulesDirectories(root, link)).toEqual(
      cacheNodeModulesDirectories(root, root)
    );
  });

  it('names a node_modules once when the working directory is itself a workspace', () => {
    const root = makeRepo('alpha');
    const workspace = path.join(root, 'packages', 'alpha');

    const directories = cacheNodeModulesDirectories(root, workspace);

    expect(directories).toEqual([...new Set(directories)]);
  });
});

describe('markCacheDirUsed', () => {
  it('creates the cache directory when it does not exist yet', async () => {
    const dir = path.join(workDir, 'node_modules', '.vite-0123456789abcdef');
    await markCacheDirUsed(dir, Date.now());
    expect(existsSync(dir)).toBe(true);
  });

  it('refreshes the modification time of an existing directory', async () => {
    const dir = path.join(workDir, 'node_modules', '.vite-0123456789abcdef');
    mkdirSync(dir, { recursive: true });
    ageDir(dir, 10 * CACHE_MAX_AGE_MS);

    const now = Date.now();
    await markCacheDirUsed(dir, now);

    expect(statSync(dir).mtimeMs).toBeGreaterThan(now - 1000);
  });
});

describe('claimAndPruneCacheDirectories', () => {
  const CURRENT = '.vite-1111111111111111';
  const STALE = '.vite-2222222222222222';
  const RECENT = '.vite-3333333333333333';
  const FOREIGN = '.vite-4444444444444444';

  function makeNodeModules(name = 'node_modules'): string {
    const dir = path.join(workDir, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function makeEntry(nodeModules: string, name: string, ageMs: number): string {
    const dir = path.join(nodeModules, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'marker'), 'x');
    ageDir(dir, ageMs);
    return dir;
  }

  function claimAndPrune(
    nodeModulesDirectories: string[],
    generationName = CURRENT
  ): Promise<string[]> {
    return claimAndPruneCacheDirectories({
      nodeModulesDirectories,
      generationName,
      runSegment: runCacheSegment(4321),
      maxAgeMs: CACHE_MAX_AGE_MS,
      now: Date.now(),
      registryDir,
    });
  }

  it('deletes a cache generation older than the age gate', async () => {
    const nodeModules = makeNodeModules();
    const stale = makeEntry(nodeModules, STALE, 2 * CACHE_MAX_AGE_MS);

    const removed = await claimAndPrune([nodeModules]);

    expect(existsSync(stale)).toBe(false);
    expect(removed).toEqual([stale]);
  });

  it('keeps a cache generation younger than the age gate', async () => {
    const nodeModules = makeNodeModules();
    const recent = makeEntry(nodeModules, RECENT, CACHE_MAX_AGE_MS / 2);

    await claimAndPrune([nodeModules]);

    expect(existsSync(recent)).toBe(true);
  });

  it('keeps the current generation even when it is older than the age gate', async () => {
    const nodeModules = makeNodeModules();
    const current = makeEntry(nodeModules, CURRENT, 10 * CACHE_MAX_AGE_MS);

    await claimAndPrune([nodeModules]);

    expect(existsSync(current)).toBe(true);
  });

  it('keeps node_modules/.vite-temp however old it is', async () => {
    const nodeModules = makeNodeModules();
    const viteTemporary = makeEntry(nodeModules, '.vite-temp', 10 * CACHE_MAX_AGE_MS);

    await claimAndPrune([nodeModules]);

    expect(existsSync(viteTemporary)).toBe(true);
  });

  it('keeps the default node_modules/.vite directory however old it is', async () => {
    const nodeModules = makeNodeModules();
    const viteDefault = makeEntry(nodeModules, '.vite', 10 * CACHE_MAX_AGE_MS);

    await claimAndPrune([nodeModules]);

    expect(existsSync(viteDefault)).toBe(true);
  });

  it('leaves unrelated node_modules entries alone', async () => {
    const nodeModules = makeNodeModules();
    const unrelated = makeEntry(nodeModules, 'some-package', 10 * CACHE_MAX_AGE_MS);

    await claimAndPrune([nodeModules]);

    expect(existsSync(unrelated)).toBe(true);
  });

  it('sweeps every node_modules directory it is given', async () => {
    const first = makeNodeModules('first');
    const second = makeNodeModules('second');
    const staleFirst = makeEntry(first, STALE, 2 * CACHE_MAX_AGE_MS);
    const staleSecond = makeEntry(second, STALE, 2 * CACHE_MAX_AGE_MS);

    await claimAndPrune([first, second]);

    expect(existsSync(staleFirst)).toBe(false);
    expect(existsSync(staleSecond)).toBe(false);
  });

  it('skips a node_modules directory that does not exist', async () => {
    const missing = path.join(workDir, 'never-installed', 'node_modules');

    await expect(claimAndPrune([missing])).resolves.toEqual([]);
  });

  it('skips an entry that vanishes before it can be measured', async () => {
    const nodeModules = makeNodeModules();
    symlinkSync(path.join(workDir, 'gone'), path.join(nodeModules, STALE));

    await expect(claimAndPrune([nodeModules])).resolves.toEqual([]);
  });

  it('propagates a failure that is not a missing directory', async () => {
    const notADirectory = path.join(workDir, 'regular-file');
    writeFileSync(notADirectory, 'x');

    await expect(claimAndPrune([notADirectory])).rejects.toThrow();
  });

  it('propagates a failure to identify an entry that is not a missing directory', async () => {
    const nodeModules = makeNodeModules();
    // A self-referential symlink resolves to ELOOP, not ENOENT, and the first
    // thing the sweep asks of an entry is who owns it — which canonicalises the
    // path. So the walk never reaches the age measurement below: the code is
    // asserted because it is what says which of the two failures arrived.
    symlinkSync(STALE, path.join(nodeModules, STALE));

    await expect(claimAndPrune([nodeModules])).rejects.toThrow(/ELOOP/);
  });

  it('propagates a failure to measure an entry that is not a missing directory', async () => {
    const nodeModules = makeNodeModules();
    const notADirectory = path.join(workDir, 'plain-file');
    writeFileSync(notADirectory, 'x');
    // A link into a path below a regular file answers ENOTDIR, which is one of
    // the codes canonicalising walks past — so the entry is identified, and the
    // failure arrives from the stat that measures its age instead.
    symlinkSync(path.join(notADirectory, 'below'), path.join(nodeModules, STALE));

    await expect(claimAndPrune([nodeModules])).rejects.toThrow(/ENOTDIR/);
  });

  it('keeps a generation a live run claimed, however far past the age gate it is', async () => {
    const nodeModules = makeNodeModules();
    const inUse = makeEntry(nodeModules, STALE, 2 * CACHE_MAX_AGE_MS);

    const removed = await inRun('pnpm test:watch', async () => {
      await recordOwnedResource('directory', inUse);
      return claimAndPrune([nodeModules]);
    });

    expect(existsSync(inUse)).toBe(true);
    expect(removed).toEqual([]);
  });

  it('deletes that same generation once the run that claimed it has finished', async () => {
    const nodeModules = makeNodeModules();
    const inUse = makeEntry(nodeModules, STALE, 2 * CACHE_MAX_AGE_MS);

    await inRun('pnpm test:watch', async () => {
      await recordOwnedResource('directory', inUse);
    });
    const removed = await claimAndPrune([nodeModules]);

    expect(existsSync(inUse)).toBe(false);
    expect(removed).toEqual([inUse]);
  });

  it("keeps this run's generation in every node_modules the sweep walks", async () => {
    const first = makeNodeModules('first');
    const second = makeNodeModules('second');
    const inFirst = makeEntry(first, CURRENT, 2 * CACHE_MAX_AGE_MS);
    const inSecond = makeEntry(second, CURRENT, 2 * CACHE_MAX_AGE_MS);

    await inRun('pnpm test', async () => {
      await claimAndPrune([first, second]);
      // A concurrent run on another branch: the same roots, another fingerprint.
      await claimAndPrune([first, second], FOREIGN);
    });

    expect([existsSync(inFirst), existsSync(inSecond)]).toEqual([true, true]);
  });

  it("records this run's generation against the claim under every node_modules", async () => {
    const first = makeNodeModules('first');
    const second = makeNodeModules('second');

    await inRun('pnpm test', async () => {
      await claimAndPrune([first, second]);
      const ownership = await readOwnership(registryDir);

      expect([
        ownership.stateOfResource('directory', path.join(first, CURRENT)),
        ownership.stateOfResource('directory', path.join(second, CURRENT)),
      ]).toEqual(['owned-live', 'owned-live']);
    });
  });

  /**
   * Makes the enclosing run's record unreadable in the form that needs no
   * corruption: a record a wider checkout wrote names a mode this one has
   * never heard of. The run behind it goes on holding its lock.
   */
  function damageOwnRecord(): string {
    const runDir = process.env[RUN_CLAIM_ENV] ?? '';
    const record = path.join(runDir, 'run.json');
    const written: unknown = JSON.parse(readFileSync(record, 'utf8'));
    writeFileSync(
      record,
      JSON.stringify({ ...(written as object), mode: 'a-mode-this-checkout-has-never-heard-of' })
    );
    return path.basename(runDir);
  }

  /** Registers a second run in this process, which needs the first one's token cleared. */
  function inSecondRun<T>(command: string, body: () => Promise<T>): Promise<T> {
    process.env[RUN_CLAIM_ENV] = '';
    return inRun(command, body);
  }

  it('spares every generation while a live run’s record could not be read', async () => {
    const nodeModules = makeNodeModules();
    const stale = makeEntry(nodeModules, STALE, 2 * CACHE_MAX_AGE_MS);

    const removed = await inRun('pnpm test:watch', async () => {
      damageOwnRecord();
      return inSecondRun('pnpm test', () => claimAndPrune([nodeModules]));
    });

    expect(existsSync(stale)).toBe(true);
    expect(removed).toEqual([]);
  });

  it('says which run directory stopped it, so a human can go and look', async () => {
    const nodeModules = makeNodeModules();
    makeEntry(nodeModules, STALE, 2 * CACHE_MAX_AGE_MS);
    const warnings: string[] = [];
    const restore = console.warn;
    console.warn = (line: string): void => {
      warnings.push(line);
    };

    try {
      const runId = await inRun('pnpm test:watch', async () => {
        const named = damageOwnRecord();
        await inSecondRun('pnpm test', () => claimAndPrune([nodeModules]));
        return named;
      });

      const skipped = warnings.filter((line) => line.includes('Skipped sweeping'));
      expect(skipped.join('\n')).toContain(runId);
    } finally {
      console.warn = restore;
    }
  });

  it('sweeps again once the run behind an unreadable record has gone', async () => {
    const nodeModules = makeNodeModules();
    const stale = makeEntry(nodeModules, STALE, 2 * CACHE_MAX_AGE_MS);

    await inRun('pnpm test:watch', () => Promise.resolve(damageOwnRecord()));
    const removed = await claimAndPrune([nodeModules]);

    expect(existsSync(stale)).toBe(false);
    expect(removed).toEqual([stale]);
  });

  it('keeps a live run generation claimed under a differently spelled path', async () => {
    const nodeModules = makeNodeModules();
    const inUse = makeEntry(nodeModules, CURRENT, 2 * CACHE_MAX_AGE_MS);

    await inRun('pnpm test:watch', async () => {
      // A trailing separator names the same directory and is not the same
      // string; the sweep looks it up by the path it walked.
      await claimAndPrune([`${nodeModules}${path.sep}`]);
      await claimAndPrune([nodeModules], FOREIGN);
    });

    expect(existsSync(inUse)).toBe(true);
  });
});

/**
 * The invocation directory inside a generation. Two concurrent runs of one
 * shape address one generation and one lifted segment, so the invocation
 * segment is the only thing separating their dependency bundles — and a run
 * that outlives the age gate must keep its own, while a run that has finished
 * must not keep anything.
 */
describe('claimAndPruneCacheDirectories, over invocation directories', () => {
  const CURRENT = '.vite-1111111111111111';
  const OLDER = '.vite-2222222222222222';
  const MINE = runCacheSegment(4321);
  const THEIRS = runCacheSegment(1234);

  function makeNodeModules(): string {
    const dir = path.join(workDir, 'node_modules');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function makeInvocation(
    nodeModules: string,
    generation: string,
    segment: string,
    ageMs = 0
  ): string {
    const dir = path.join(nodeModules, generation, segment);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'marker'), 'x');
    ageDir(dir, ageMs);
    ageDir(path.join(nodeModules, generation), 0);
    return dir;
  }

  function claimAndPrune(nodeModules: string, generationName = CURRENT): Promise<string[]> {
    return claimAndPruneCacheDirectories({
      nodeModulesDirectories: [nodeModules],
      generationName,
      runSegment: MINE,
      maxAgeMs: CACHE_MAX_AGE_MS,
      now: Date.now(),
      registryDir,
    });
  }

  it("records this run's invocation directory against the claim", async () => {
    const nodeModules = makeNodeModules();

    await inRun('pnpm test', async () => {
      await claimAndPrune(nodeModules);
      const ownership = await readOwnership(registryDir);

      expect(ownership.stateOfResource('directory', path.join(nodeModules, CURRENT, MINE))).toBe(
        'owned-live'
      );
    });
  });

  it('keeps the invocation directory of a run that is still going', async () => {
    const nodeModules = makeNodeModules();
    const theirs = makeInvocation(nodeModules, CURRENT, THEIRS, 2 * CACHE_MAX_AGE_MS);

    await inRun('pnpm test:watch', async () => {
      await recordOwnedResource('directory', theirs);
      await claimAndPrune(nodeModules);
    });

    expect(existsSync(theirs)).toBe(true);
  });

  /**
   * A run that ends cleanly drops its own directories and leaves its resources
   * unowned, so the state below is what a KILLED run leaves: the record stands
   * and its lock does not.
   */
  async function leaveKilledRun(record: () => Promise<void>): Promise<void> {
    await expect(
      inRun('pnpm test', async () => {
        await record();
        throw new Error('the run was killed');
      })
    ).rejects.toThrow('the run was killed');
  }

  it('removes the invocation directory of a killed run without waiting for the age gate', async () => {
    const nodeModules = makeNodeModules();
    const theirs = makeInvocation(nodeModules, CURRENT, THEIRS);

    await leaveKilledRun(async () => {
      await recordOwnedResource('directory', theirs);
    });
    const removed = await claimAndPrune(nodeModules);

    expect(existsSync(theirs)).toBe(false);
    expect(removed).toContain(theirs);
  });

  it('keeps an invocation directory nothing claimed until the age gate', async () => {
    const nodeModules = makeNodeModules();
    const unowned = makeInvocation(nodeModules, CURRENT, THEIRS);

    await claimAndPrune(nodeModules);

    expect(existsSync(unowned)).toBe(true);
  });

  it('removes an invocation directory nothing claimed once it is past the age gate', async () => {
    const nodeModules = makeNodeModules();
    const unowned = makeInvocation(nodeModules, CURRENT, THEIRS, 2 * CACHE_MAX_AGE_MS);

    const removed = await claimAndPrune(nodeModules);

    expect(existsSync(unowned)).toBe(false);
    expect(removed).toContain(unowned);
  });

  it("never removes this run's own invocation directory, however old it looks", async () => {
    const nodeModules = makeNodeModules();
    const mine = makeInvocation(nodeModules, CURRENT, MINE, 2 * CACHE_MAX_AGE_MS);

    await claimAndPrune(nodeModules);

    expect(existsSync(mine)).toBe(true);
  });

  it('reaches invocation directories in a generation this run is not using', async () => {
    const nodeModules = makeNodeModules();
    const theirs = makeInvocation(nodeModules, OLDER, THEIRS);

    await leaveKilledRun(async () => {
      await recordOwnedResource('directory', theirs);
    });
    await claimAndPrune(nodeModules);

    expect(existsSync(theirs)).toBe(false);
  });

  it('leaves a generation child that is not an invocation directory alone', async () => {
    const nodeModules = makeNodeModules();
    const other = path.join(nodeModules, CURRENT, 'vitest');
    mkdirSync(other, { recursive: true });
    ageDir(other, 2 * CACHE_MAX_AGE_MS);

    await claimAndPrune(nodeModules);

    expect(existsSync(other)).toBe(true);
  });

  /**
   * A runner's own directory is never claimed on its own account — the claim
   * covers the invocation directory it sits in — so a pass that judged one
   * would find every one of them unowned and hand it to the age gate, which is
   * the clock the claim replaced.
   */
  it("keeps a live run's runner directories, which nothing claims on their own account", async () => {
    const nodeModules = makeNodeModules();
    const theirs = makeInvocation(nodeModules, CURRENT, THEIRS, 2 * CACHE_MAX_AGE_MS);
    const runner = path.join(theirs, runnerCacheSegment(777));
    mkdirSync(runner, { recursive: true });
    ageDir(runner, 2 * CACHE_MAX_AGE_MS);

    await inRun('pnpm test:watch', async () => {
      await recordOwnedResource('directory', theirs);
      await claimAndPrune(nodeModules);
    });

    expect(existsSync(runner)).toBe(true);
  });

  it("removes a killed run's runner directories with the invocation directory claiming them", async () => {
    const nodeModules = makeNodeModules();
    const theirs = makeInvocation(nodeModules, CURRENT, THEIRS);
    const runner = path.join(theirs, runnerCacheSegment(777));
    mkdirSync(runner, { recursive: true });

    await leaveKilledRun(async () => {
      await recordOwnedResource('directory', theirs);
    });
    await claimAndPrune(nodeModules);

    expect(existsSync(runner)).toBe(false);
  });
});

describe('withRunnerCacheClaim', () => {
  /** A repository the fingerprint can read and the workspace scan can walk. */
  function makeRepo(): string {
    const root = path.join(workDir, 'repo');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    for (const packageName of OPTIMIZED_PACKAGES) {
      const dir = path.join(root, 'packages', packageName, 'src');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(root, 'packages', packageName, 'package.json'),
        JSON.stringify({ name: `@hushbox/${packageName}` })
      );
      writeFileSync(path.join(dir, 'index.ts'), `export const ${packageName} = 1;\n`);
    }
    return root;
  }

  /** Where the runner this claim is minted for will bundle, under one root. */
  function invocationDirectory(
    nodeModules: string,
    env: Record<string, string | undefined>
  ): string {
    const generation = env[RUN_CACHE_GENERATION_ENV];
    const runSegment = env[RUN_CACHE_SEGMENT_ENV];
    if (generation === undefined || runSegment === undefined) {
      throw new Error('the hold minted no cache names');
    }
    return path.join(nodeModules, generation, runSegment);
  }

  /** What the claim holder minted, as the runner reads it out of the environment. */
  function mintedSegment(env: Record<string, string | undefined>): string | undefined {
    return env[RUN_CACHE_SEGMENT_ENV];
  }

  interface Held {
    /** Defaults to one process id; a second run is a second process. */
    readonly processId?: number;
    /** Defaults to the whole pool; one slot is how a test exhausts it. */
    readonly slots?: number;
    readonly projectRoot?: string;
  }

  function holdFor<T>(
    root: string,
    env: Record<string, string | undefined>,
    body: () => Promise<T>,
    held: Held = {}
  ): Promise<T> {
    return withRunnerCacheClaim(
      {
        repoRoot: root,
        projectRoot: held.projectRoot ?? root,
        processId: held.processId ?? 1234,
        env,
        now: Date.now(),
        registryDir,
        slots: held.slots,
      },
      body
    );
  }

  /** What a runner leaves in the directory claimed for it: a directory of its own, with bundles. */
  function bundleInto(directory: string, runner: number): string {
    const bundles = path.join(directory, runnerCacheSegment(runner));
    mkdirSync(bundles, { recursive: true });
    writeFileSync(path.join(bundles, 'dep.js'), 'export const dep = 1;\n');
    return bundles;
  }

  it('names the invocation directory in the claim before anything creates it', async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};

    await inRun('pnpm test', async () => {
      await holdFor(root, env, async () => {
        const directory = invocationDirectory(path.join(root, 'node_modules'), env);
        const ownership = await readOwnership(registryDir);

        expect([existsSync(directory), ownership.stateOfResource('directory', directory)]).toEqual([
          false,
          'owned-live',
        ]);
      });
    });
  });

  it('mints the lowest slot of the pool for the runner it starts', async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};

    await inRun('pnpm test', () =>
      holdFor(root, env, () => {
        expect(mintedSegment(env)).toBe(slotCacheSegment(0));
        return Promise.resolve();
      })
    );
  });

  it('mints that same slot to a later run, which is what leaves it something to find', async () => {
    const root = makeRepo();
    const first: Record<string, string | undefined> = {};
    const second: Record<string, string | undefined> = {};

    await inRun('pnpm test', () => holdFor(root, first, () => Promise.resolve()));
    await inRun('pnpm test', () =>
      holdFor(root, second, () => Promise.resolve(), { processId: 4321 })
    );

    expect(mintedSegment(second)).toBe(mintedSegment(first));
  });

  it('keeps the slot directory once the command it enclosed has ended', async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};
    let directory = '';

    await inRun('pnpm test', () =>
      holdFor(root, env, () => {
        directory = invocationDirectory(path.join(root, 'node_modules'), env);
        bundleInto(directory, 0);
        return Promise.resolve();
      })
    );

    expect(existsSync(directory)).toBe(true);
  });

  it('keeps the bundles inside it, which is the whole of what the next run reuses', async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};
    let bundles = '';

    await inRun('pnpm test', () =>
      holdFor(root, env, () => {
        bundles = bundleInto(invocationDirectory(path.join(root, 'node_modules'), env), 0);
        return Promise.resolve();
      })
    );

    expect(existsSync(path.join(bundles, 'dep.js'))).toBe(true);
  });

  it('gives a run starting beside it a slot of its own', async () => {
    const root = makeRepo();
    const mine: Record<string, string | undefined> = {};
    const theirs: Record<string, string | undefined> = {};

    await inRun('pnpm test', () =>
      holdFor(root, mine, () => holdFor(root, theirs, () => Promise.resolve(), { processId: 4321 }))
    );

    expect(mintedSegment(theirs)).not.toBe(mintedSegment(mine));
  });

  it('leaves the directory of the run beside it alone', async () => {
    const root = makeRepo();
    const mine: Record<string, string | undefined> = {};
    const theirs: Record<string, string | undefined> = {};
    let bundles = '';

    await inRun('pnpm test', () =>
      holdFor(root, mine, async () => {
        await holdFor(
          root,
          theirs,
          () => {
            bundles = bundleInto(invocationDirectory(path.join(root, 'node_modules'), theirs), 0);
            return Promise.resolve();
          },
          { processId: 4321 }
        );
        expect(existsSync(bundles)).toBe(true);
      })
    );
  });

  it('takes a private directory when every slot of the pool is held', async () => {
    const root = makeRepo();
    const mine: Record<string, string | undefined> = {};
    const theirs: Record<string, string | undefined> = {};

    await inRun('pnpm test', () =>
      holdFor(
        root,
        mine,
        () => holdFor(root, theirs, () => Promise.resolve(), { processId: 4321, slots: 1 }),
        { slots: 1 }
      )
    );

    expect(mintedSegment(theirs)).toBe(runCacheSegment(4321));
  });

  it('runs the command it encloses when every slot is held', async () => {
    const root = makeRepo();

    await expect(
      inRun('pnpm test', () =>
        holdFor(
          root,
          {},
          () => holdFor(root, {}, () => Promise.resolve('done'), { processId: 4321, slots: 1 }),
          { slots: 1 }
        )
      )
    ).resolves.toBe('done');
  });

  it('releases the runner markers the last holder of the slot left', async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};
    let released: boolean | undefined;

    await inRun('pnpm test', () => holdFor(root, env, () => Promise.resolve()));
    const directory = invocationDirectory(path.join(root, 'node_modules'), env);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, runnerMarkerName(runnerCacheSegment(0))), '999');

    await inRun('pnpm test', () =>
      holdFor(root, env, () => {
        released = !existsSync(path.join(directory, runnerMarkerName(runnerCacheSegment(0))));
        return Promise.resolve();
      })
    );

    expect(released).toBe(true);
  });

  it('leaves the markers of a claim it inherited, whose runners are still bundling', async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};
    let standing: boolean | undefined;
    let marker = '';

    await inRun('pnpm test', async () => {
      await holdFor(root, env, () => {
        const directory = invocationDirectory(path.join(root, 'node_modules'), env);
        mkdirSync(directory, { recursive: true });
        marker = path.join(directory, runnerMarkerName(runnerCacheSegment(0)));
        writeFileSync(marker, '999');
        return Promise.resolve();
      });
      // What a process started inside a holder of this slot inherits.
      process.env[HELD_CLAIMS_ENV] = canonicalPath(
        path.join(root, 'node_modules', CACHE_SLOT_CLAIMS_DIR, 'slot-0.lock')
      );
      await holdFor(root, env, () => {
        standing = existsSync(marker);
        return Promise.resolve();
      });
    });

    expect(standing).toBe(true);
  });

  it('mints a segment the runner it starts resolves to the directory just claimed', async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};

    await inRun('pnpm test', async () => {
      await holdFor(root, env, async () => {
        // The runner is another process, so the number it would derive from is
        // never the minting one.
        await expect(resolveRunnerCacheNames(env, 999, root)).resolves.toMatchObject({
          runSegment: slotCacheSegment(0),
        });
      });
    });
  });

  it('mints the generation too, so sources only the runner reads cannot move it', async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};

    await inRun('pnpm test', async () => {
      await holdFor(root, env, async () => {
        const claimed = cacheDirName(await optimizedSourcesFingerprint(root));
        // The tree a runner reads is not always the tree claimed against: a
        // mutation run hands its runner an instrumented copy of the sources.
        writeFileSync(
          path.join(root, 'packages', OPTIMIZED_PACKAGES[0], 'src', 'index.ts'),
          'export const instrumented = 1;\n'
        );

        await expect(resolveRunnerCacheNames(env, 999, root)).resolves.toMatchObject({
          generationName: claimed,
        });
      });
    });
  });

  it('names the generation the invocation directory sits in', async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};

    await inRun('pnpm test', async () => {
      await holdFor(root, env, async () => {
        const directory = invocationDirectory(path.join(root, 'node_modules'), env);
        const ownership = await readOwnership(registryDir);

        expect(ownership.stateOfResource('directory', path.dirname(directory))).toBe('owned-live');
      });
    });
  });

  it('names the directory under every workspace the runner may resolve against', async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};

    await inRun('pnpm test', async () => {
      await holdFor(root, env, async () => {
        const ownership = await readOwnership(registryDir);
        const states = OPTIMIZED_PACKAGES.map((packageName) =>
          ownership.stateOfResource(
            'directory',
            invocationDirectory(path.join(root, 'packages', packageName, 'node_modules'), env)
          )
        );

        expect(states).toEqual(OPTIMIZED_PACKAGES.map(() => 'owned-live'));
      });
    });
  });

  it('prunes a generation nothing holds, so the sweep runs before the runner starts', async () => {
    const root = makeRepo();
    const stale = path.join(root, 'node_modules', '.vite-2222222222222222');
    mkdirSync(stale, { recursive: true });
    ageDir(stale, 2 * CACHE_MAX_AGE_MS);

    await inRun('pnpm test', () =>
      holdFor(root, {}, () => {
        expect(existsSync(stale)).toBe(false);
        return Promise.resolve();
      })
    );
  });

  it('removes the private directory it claimed once the command it enclosed has ended', async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};
    let directory = '';

    await inRun('pnpm test', () =>
      holdFor(
        root,
        {},
        () =>
          holdFor(
            root,
            env,
            () => {
              directory = invocationDirectory(path.join(root, 'node_modules'), env);
              bundleInto(directory, 0);
              return Promise.resolve();
            },
            { processId: 4321, slots: 1 }
          ),
        { slots: 1 }
      )
    );

    expect(existsSync(directory)).toBe(false);
  });

  /**
   * A runner killed mid-flight reaches no teardown of its own, so what it wrote
   * is removed by the process that claimed for it or by nothing at all. That
   * process is still running — it is the one that started the runner and
   * watched it die — and it is what runs here.
   */
  it('removes what a command that failed left standing in a private directory', async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};
    let directory = '';

    await inRun('pnpm test', () =>
      holdFor(
        root,
        {},
        async () => {
          await expect(
            holdFor(
              root,
              env,
              () => {
                directory = invocationDirectory(path.join(root, 'node_modules'), env);
                bundleInto(directory, 0);
                throw new Error('the runner died');
              },
              { processId: 4321, slots: 1 }
            )
          ).rejects.toThrow('the runner died');
        },
        { slots: 1 }
      )
    );

    expect(existsSync(directory)).toBe(false);
  });

  it('removes every runner directory a private claim covered', async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};
    const runners: string[] = [];

    await inRun('pnpm test', () =>
      holdFor(
        root,
        {},
        () =>
          holdFor(
            root,
            env,
            () => {
              const directory = invocationDirectory(path.join(root, 'node_modules'), env);
              runners.push(bundleInto(directory, 0), bundleInto(directory, 1));
              return Promise.resolve();
            },
            { processId: 4321, slots: 1 }
          ),
        { slots: 1 }
      )
    );

    expect(runners.map((runner) => existsSync(runner))).toEqual([false, false]);
  });

  it('removes it under every workspace root a runner could have resolved against', async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};
    const directories: string[] = [];

    await inRun('pnpm test', () =>
      holdFor(
        root,
        {},
        () =>
          holdFor(
            root,
            env,
            () => {
              for (const packageName of OPTIMIZED_PACKAGES) {
                const directory = invocationDirectory(
                  path.join(root, 'packages', packageName, 'node_modules'),
                  env
                );
                bundleInto(directory, 0);
                directories.push(directory);
              }
              return Promise.resolve();
            },
            { processId: 4321, slots: 1 }
          ),
        { slots: 1 }
      )
    );

    expect(directories.map((directory) => existsSync(directory))).toEqual(
      OPTIMIZED_PACKAGES.map(() => false)
    );
  });

  /**
   * The property the whole shape exists for. A run's record is what says who
   * owns the directory; once the record has gone, anything still standing reads
   * as owned by nobody, which is the one state a reclaimer reports and never
   * removes — leaving the retention clock as its only reclaimer. The removal
   * therefore has to have happened while the record is still on disk, and this
   * observes exactly that instant.
   */
  it('has removed the private directory while the record naming it is still on disk', async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};
    let observed: { directoryStanding: boolean; recordStanding: boolean } | undefined;

    await inRun('pnpm test', async () => {
      const runDir = process.env[RUN_CLAIM_ENV] ?? '';
      let directory = '';
      releaseBeforeRecordDrops(() => {
        observed = {
          directoryStanding: existsSync(directory),
          recordStanding: existsSync(runDir),
        };
      });
      await holdFor(
        root,
        {},
        () =>
          holdFor(
            root,
            env,
            () => {
              directory = invocationDirectory(path.join(root, 'node_modules'), env);
              bundleInto(directory, 0);
              return Promise.resolve();
            },
            { processId: 4321, slots: 1 }
          ),
        { slots: 1 }
      );
    });

    expect(observed).toEqual({ directoryStanding: false, recordStanding: true });
  });

  it("leaves another run's invocation directory where it is", async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};
    let theirs = '';

    await inRun('pnpm test', () =>
      holdFor(root, env, () => {
        const directory = invocationDirectory(path.join(root, 'node_modules'), env);
        theirs = path.join(path.dirname(directory), runCacheSegment(9999));
        bundleInto(theirs, 0);
        return Promise.resolve();
      })
    );

    expect(existsSync(theirs)).toBe(true);
  });

  it('leaves the generation itself, which outlives any one run', async () => {
    const root = makeRepo();
    const env: Record<string, string | undefined> = {};
    let generation = '';

    await inRun('pnpm test', () =>
      holdFor(root, env, () => {
        const directory = invocationDirectory(path.join(root, 'node_modules'), env);
        generation = path.dirname(directory);
        bundleInto(directory, 0);
        return Promise.resolve();
      })
    );

    expect(existsSync(generation)).toBe(true);
  });

  it('lets a failure of the command it enclosed through', async () => {
    const root = makeRepo();

    await expect(
      inRun('pnpm test', () =>
        holdFor(root, {}, () => Promise.reject(new Error('the runner died')))
      )
    ).rejects.toThrow('the runner died');
  });

  /**
   * A suite taking a claim of its own and being refused is ordinary, and the
   * refusal it raises reaches the hold around it. Reading one as this slot
   * being held would move the run to the next slot and run the whole command a
   * second time.
   */
  it('runs the command once when the command itself is refused a claim', async () => {
    const root = makeRepo();
    let started = 0;

    await expect(
      inRun('pnpm test', () =>
        holdFor(root, {}, () => {
          started += 1;
          return Promise.reject(new ClaimHeldError('a database', 'another run'));
        })
      )
    ).rejects.toThrow(ClaimHeldError);

    expect(started).toBe(1);
  });

  it('says nothing where the command it enclosed wrote no cache directory at all', async () => {
    const root = makeRepo();

    await expect(
      inRun('pnpm test', () => holdFor(root, {}, () => Promise.resolve('done')))
    ).resolves.toBe('done');
  });
});
