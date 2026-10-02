import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CACHE_DIR_NAME_PATTERN,
  OPTIMIZED_PACKAGES,
  OPTIMIZER_INCLUDE,
  RUN_CACHE_GENERATION_ENV,
  RUN_CACHE_SEGMENT_ENV,
  RUN_CACHE_SEGMENT_PATTERN,
  RUNNER_CACHE_SEGMENT_PATTERN,
  allocateRunnerCacheSegment,
  isRunnerMarker,
  cacheDirName,
  liftedCacheDir,
  optimizedSourcesFingerprint,
  resolveRunnerCacheNames,
  runCacheSegment,
  runnerCacheClaimRefusal,
  runnerCacheSegment,
  runnerMarkerName,
  slotCacheSegment,
} from './vitest-cache.js';

let workDir = '';

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'hb-vitest-cache-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeFileAt(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

/** What a run holding a slot does to the markers before it starts a runner. */
function releaseMarkers(claimed: string): void {
  for (const name of readdirSync(claimed)) {
    if (isRunnerMarker(name)) rmSync(path.join(claimed, name), { force: true });
  }
}

/** A repo root carrying only what the fingerprint is specified to read. */
function makeRepo(root: string): void {
  for (const packageName of OPTIMIZED_PACKAGES) {
    writeFileAt(
      path.join(root, 'packages', packageName, 'package.json'),
      `{"name":"@hushbox/${packageName}"}`
    );
    writeFileAt(
      path.join(root, 'packages', packageName, 'src', 'index.ts'),
      `export const ${packageName} = 1;\n`
    );
  }
}

describe('OPTIMIZER_INCLUDE', () => {
  it('carries one @hushbox workspace specifier per optimized package', () => {
    expect(OPTIMIZER_INCLUDE).toHaveLength(OPTIMIZED_PACKAGES.length);
    for (const packageName of OPTIMIZED_PACKAGES) {
      expect(OPTIMIZER_INCLUDE).toContain(`@hushbox/${packageName}`);
    }
  });
});

describe('cacheDirName', () => {
  it('prefixes a truncated fingerprint with .vite-', () => {
    expect(cacheDirName('a'.repeat(64))).toBe(`.vite-${'a'.repeat(16)}`);
  });

  it('produces a name matching the pattern the prune recognises', () => {
    expect(cacheDirName('0123456789abcdef'.repeat(4))).toMatch(CACHE_DIR_NAME_PATTERN);
  });

  it('produces different names for different fingerprints', () => {
    expect(cacheDirName('a'.repeat(64))).not.toBe(cacheDirName('b'.repeat(64)));
  });
});

describe('CACHE_DIR_NAME_PATTERN', () => {
  it('does not match vite own config-loading directory', () => {
    expect('.vite-temp').not.toMatch(CACHE_DIR_NAME_PATTERN);
  });

  it('does not match the default vite cache directory', () => {
    expect('.vite').not.toMatch(CACHE_DIR_NAME_PATTERN);
  });
});

describe('optimizedSourcesFingerprint', () => {
  it('returns a sha256 hex digest', async () => {
    makeRepo(workDir);
    expect(await optimizedSourcesFingerprint(workDir)).toMatch(/^[\da-f]{64}$/);
  });

  it('is stable across calls when nothing changes', async () => {
    makeRepo(workDir);
    expect(await optimizedSourcesFingerprint(workDir)).toBe(
      await optimizedSourcesFingerprint(workDir)
    );
  });

  it.each(OPTIMIZED_PACKAGES)(
    'changes when a byte under packages/%s/src changes',
    async (packageName) => {
      makeRepo(workDir);
      const before = await optimizedSourcesFingerprint(workDir);
      writeFileAt(
        path.join(workDir, 'packages', packageName, 'src', 'index.ts'),
        `export const ${packageName} = 2;\n`
      );
      expect(await optimizedSourcesFingerprint(workDir)).not.toBe(before);
    }
  );

  it.each(OPTIMIZED_PACKAGES)(
    'changes when a file is added under packages/%s/src',
    async (packageName) => {
      makeRepo(workDir);
      const before = await optimizedSourcesFingerprint(workDir);
      writeFileAt(
        path.join(workDir, 'packages', packageName, 'src', 'added.ts'),
        'export const added = 1;\n'
      );
      expect(await optimizedSourcesFingerprint(workDir)).not.toBe(before);
    }
  );

  it.each(OPTIMIZED_PACKAGES)(
    'changes when packages/%s/package.json changes',
    async (packageName) => {
      makeRepo(workDir);
      const before = await optimizedSourcesFingerprint(workDir);
      writeFileAt(
        path.join(workDir, 'packages', packageName, 'package.json'),
        `{"name":"@hushbox/${packageName}","x":1}`
      );
      expect(await optimizedSourcesFingerprint(workDir)).not.toBe(before);
    }
  );

  it('returns to the original digest when a source edit is reverted', async () => {
    makeRepo(workDir);
    const source = path.join(workDir, 'packages', 'shared', 'src', 'index.ts');
    const original = await optimizedSourcesFingerprint(workDir);

    writeFileAt(source, 'export const shared = 2;\n');
    const edited = await optimizedSourcesFingerprint(workDir);

    writeFileAt(source, 'export const shared = 1;\n');
    const reverted = await optimizedSourcesFingerprint(workDir);

    expect(edited).not.toBe(original);
    expect(reverted).toBe(original);
  });

  it('ignores files outside the three optimized packages', async () => {
    makeRepo(workDir);
    const before = await optimizedSourcesFingerprint(workDir);
    writeFileAt(path.join(workDir, 'packages', 'ui', 'src', 'index.ts'), 'export const ui = 1;\n');
    expect(await optimizedSourcesFingerprint(workDir)).toBe(before);
  });

  it('ignores files outside src in an optimized package', async () => {
    makeRepo(workDir);
    const before = await optimizedSourcesFingerprint(workDir);
    writeFileAt(path.join(workDir, 'packages', 'db', 'README.md'), 'docs\n');
    expect(await optimizedSourcesFingerprint(workDir)).toBe(before);
  });

  it('rejects when an optimized package is missing', async () => {
    await expect(optimizedSourcesFingerprint(workDir)).rejects.toThrow();
  });
});

describe('liftedCacheDir', () => {
  it('places a lifted project beneath the cache directory its package declares', () => {
    const declared = path.join('node_modules', '.vite-0123456789abcdef');
    expect(path.dirname(liftedCacheDir(declared, 'packages/db'))).toBe(declared);
  });

  it('resolves somewhere the package-rooted shape never addresses', () => {
    const declared = path.join('node_modules', '.vite-0123456789abcdef');
    expect(liftedCacheDir(declared, 'packages/db')).not.toBe(declared);
  });

  it('keeps the generation the outermost segment of the whole path, so the sweep still sees it', () => {
    // The composition a real configuration builds: the generation, this
    // invocation's directory inside it, and the shape's segment inside that.
    const generation = path.join('node_modules', '.vite-0123456789abcdef');
    const lifted = liftedCacheDir(path.join(generation, runCacheSegment(1234)), 'apps/web');
    expect(path.relative(generation, lifted).split(path.sep)).toEqual([
      runCacheSegment(1234),
      path.basename(liftedCacheDir('cache', 'a package')),
    ]);
  });

  it('names one segment, so the two shapes differ by exactly that directory', () => {
    const declared = path.join('node_modules', '.vite-0123456789abcdef');
    expect(
      path.relative(declared, liftedCacheDir(declared, 'packages/db')).split(path.sep)
    ).toHaveLength(1);
  });

  it('rejects a package declaring no cache directory', () => {
    expect(() => liftedCacheDir(undefined, 'packages/db')).toThrow(/packages\/db/);
  });

  it('rejects an empty cache directory', () => {
    expect(() => liftedCacheDir('', 'apps/web')).toThrow(/apps\/web/);
  });
});

describe('runCacheSegment', () => {
  it('names a different directory for each concurrent invocation', () => {
    expect(runCacheSegment(4321)).not.toBe(runCacheSegment(1234));
  });

  it('answers the same for one invocation, so its every config load resolves one directory', () => {
    expect(runCacheSegment(1234)).toBe(runCacheSegment(1234));
  });

  it('produces a name the prune recognises as an invocation directory', () => {
    expect(runCacheSegment(1234)).toMatch(RUN_CACHE_SEGMENT_PATTERN);
  });

  it('produces a name no generation could carry, so the prune cannot confuse the two', () => {
    expect(runCacheSegment(1234)).not.toMatch(CACHE_DIR_NAME_PATTERN);
  });

  it('carries the invocation identity as a digest rather than verbatim', () => {
    expect(runCacheSegment(1234)).not.toContain('1234');
  });
});

describe('slotCacheSegment', () => {
  it('names a different directory for each slot of the pool', () => {
    expect(slotCacheSegment(1)).not.toBe(slotCacheSegment(0));
  });

  it('produces a name the prune recognises as an invocation directory', () => {
    expect(slotCacheSegment(0)).toMatch(RUN_CACHE_SEGMENT_PATTERN);
  });

  it('produces a name no generation could carry, so the prune cannot confuse the two', () => {
    expect(slotCacheSegment(0)).not.toMatch(CACHE_DIR_NAME_PATTERN);
  });

  it('names no directory a private per-invocation run could take', () => {
    expect(slotCacheSegment(0)).not.toBe(runCacheSegment(0));
  });
});

describe('runnerCacheSegment', () => {
  it('names a different directory for each runner sharing one run', () => {
    expect(runnerCacheSegment(1)).not.toBe(runnerCacheSegment(0));
  });

  it('produces a name the prune recognises as a runner directory', () => {
    expect(runnerCacheSegment(0)).toMatch(RUNNER_CACHE_SEGMENT_PATTERN);
  });

  it('produces a name no run directory could carry, so the prune cannot confuse the two', () => {
    expect(runnerCacheSegment(0)).not.toMatch(RUN_CACHE_SEGMENT_PATTERN);
  });

  it('produces a name no generation could carry', () => {
    expect(runnerCacheSegment(0)).not.toMatch(CACHE_DIR_NAME_PATTERN);
  });
});

describe('isRunnerMarker', () => {
  it('recognises the marker a runner leaves beside the directory it took', () => {
    expect(isRunnerMarker(runnerMarkerName(runnerCacheSegment(0)))).toBe(true);
  });

  it('recognises no runner directory, so releasing the markers keeps every bundle', () => {
    expect(isRunnerMarker(runnerCacheSegment(0))).toBe(false);
  });

  it('recognises nothing else a run directory might hold', () => {
    expect(isRunnerMarker('lifted.taken')).toBe(false);
  });
});

describe('allocateRunnerCacheSegment', () => {
  it('gives the first runner asking the lowest directory in the claimed one', () => {
    expect(allocateRunnerCacheSegment(path.join(workDir, 'claimed'), 11)).toBe(
      runnerCacheSegment(0)
    );
  });

  it('creates the claimed directory when nothing has created it yet', () => {
    const claimed = path.join(workDir, 'claimed');
    allocateRunnerCacheSegment(claimed, 11);
    expect(existsSync(claimed)).toBe(true);
  });

  it('gives a second runner under one claim a directory of its own', () => {
    const claimed = path.join(workDir, 'claimed');
    const first = allocateRunnerCacheSegment(claimed, 11);
    expect(allocateRunnerCacheSegment(claimed, 22)).not.toBe(first);
  });

  it('answers the same directory when one runner asks twice', () => {
    const claimed = path.join(workDir, 'claimed');
    const first = allocateRunnerCacheSegment(claimed, 11);
    expect(allocateRunnerCacheSegment(claimed, 11)).toBe(first);
  });

  it('gives the lowest directory back once the markers are released', () => {
    const claimed = path.join(workDir, 'claimed');
    allocateRunnerCacheSegment(claimed, 11);
    releaseMarkers(claimed);
    expect(allocateRunnerCacheSegment(claimed, 22)).toBe(runnerCacheSegment(0));
  });

  it('passes over a marker whose holder it cannot read', () => {
    const claimed = path.join(workDir, 'claimed');
    mkdirSync(path.join(claimed, runnerMarkerName(runnerCacheSegment(0))), { recursive: true });
    expect(allocateRunnerCacheSegment(claimed, 11)).toBe(runnerCacheSegment(1));
  });
});

describe('resolveRunnerCacheNames', () => {
  const minted = {
    generationName: cacheDirName('a'.repeat(64)),
    runSegment: runCacheSegment(1234),
  };
  const mintedEnv = {
    [RUN_CACHE_GENERATION_ENV]: minted.generationName,
    [RUN_CACHE_SEGMENT_ENV]: minted.runSegment,
  };

  it('answers the names the claim holder minted, whatever process asks', async () => {
    await expect(resolveRunnerCacheNames(mintedEnv, 4321, workDir)).resolves.toMatchObject(minted);
  });

  it('reads no source when the claim holder minted the names', async () => {
    // No repository at `workDir`, so a derivation would fail rather than answer.
    await expect(resolveRunnerCacheNames(mintedEnv, 4321, workDir)).resolves.toMatchObject(minted);
  });

  it('gives each runner asking under one minted claim a directory of its own', async () => {
    const resolved = await Promise.all(
      [11, 22, 33, 44].map((processId) => resolveRunnerCacheNames(mintedEnv, processId, workDir))
    );

    expect(new Set(resolved.map((names) => names.runnerSegment)).size).toBe(4);
  });

  it('keeps the claimed directory the parent of every runner sharing that claim', async () => {
    const resolved = await Promise.all(
      [11, 22, 33, 44].map((processId) => resolveRunnerCacheNames(mintedEnv, processId, workDir))
    );

    expect(
      new Set(resolved.map((names) => path.join(names.generationName, names.runSegment))).size
    ).toBe(1);
  });

  it("allocates the runner's own segment inside the directory the claim holder minted", async () => {
    const { runnerSegment } = await resolveRunnerCacheNames(mintedEnv, 4321, workDir);

    expect(
      existsSync(
        path.join(
          workDir,
          'node_modules',
          minted.generationName,
          minted.runSegment,
          runnerMarkerName(runnerSegment)
        )
      )
    ).toBe(true);
  });

  it('derives every name for a runner no claim holder minted for', async () => {
    makeRepo(workDir);

    await expect(resolveRunnerCacheNames({}, 4321, workDir)).resolves.toEqual({
      generationName: cacheDirName(await optimizedSourcesFingerprint(workDir)),
      runSegment: runCacheSegment(4321),
      runnerSegment: runnerCacheSegment(0),
    });
  });

  it('writes nothing under the repository root for a runner no claim holder minted for', async () => {
    makeRepo(workDir);

    await resolveRunnerCacheNames({}, 4321, workDir);

    expect(existsSync(path.join(workDir, 'node_modules'))).toBe(false);
  });

  it('derives when the environment carries names the prune would not recognise', async () => {
    makeRepo(workDir);

    await expect(
      resolveRunnerCacheNames(
        { [RUN_CACHE_GENERATION_ENV]: '..', [RUN_CACHE_SEGMENT_ENV]: '../elsewhere' },
        4321,
        workDir
      )
    ).resolves.toEqual({
      generationName: cacheDirName(await optimizedSourcesFingerprint(workDir)),
      runSegment: runCacheSegment(4321),
      runnerSegment: runnerCacheSegment(0),
    });
  });

  it('derives when only one of the two names was minted, since half an address is none', async () => {
    makeRepo(workDir);

    await expect(
      resolveRunnerCacheNames({ [RUN_CACHE_SEGMENT_ENV]: minted.runSegment }, 4321, workDir)
    ).resolves.toEqual({
      generationName: cacheDirName(await optimizedSourcesFingerprint(workDir)),
      runSegment: runCacheSegment(4321),
      runnerSegment: runnerCacheSegment(0),
    });
  });
});

describe('runnerCacheClaimRefusal', () => {
  const mintedEnv = {
    [RUN_CACHE_GENERATION_ENV]: cacheDirName('a'.repeat(64)),
    [RUN_CACHE_SEGMENT_ENV]: runCacheSegment(1234),
  };

  it('refuses a runner started inside a run that claimed nothing for it', () => {
    expect(runnerCacheClaimRefusal({}, 'a-run')).toMatch(/claim/);
  });

  it('names what a starter reaching a runner some other way runs through', () => {
    expect(runnerCacheClaimRefusal({}, 'a-run')).toContain('with-runner-cache-claim.ts');
  });

  it('refuses a run that minted only one of the two names', () => {
    expect(
      runnerCacheClaimRefusal({ [RUN_CACHE_SEGMENT_ENV]: runCacheSegment(1234) }, 'a-run')
    ).toMatch(/claim/);
  });

  it('accepts a runner whose claim holder minted the pair', () => {
    expect(runnerCacheClaimRefusal(mintedEnv, 'a-run')).toBeUndefined();
  });

  it('accepts a runner no run claim encloses, which has no claim to be recorded against', () => {
    expect(runnerCacheClaimRefusal({}, null)).toBeUndefined();
  });
});
